import { createRoute } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { deleteAccount } from "../lib/account";
import { requireUser } from "../lib/auth";
import { bearerAuth, createApp, errors, json } from "../lib/openapi";
import { hiddenMediaSql } from "../lib/moderation";
import { presignPut } from "../lib/r2";
import { isRevealed, publicUser } from "../lib/util";
import { USERNAME_TAKEN_MESSAGE } from "../lib/username";
import { AvatarUploadSchema, MyTripsSchema, UpdateProfileSchema, UserSchema } from "../schemas";
import type { Role, TripRow } from "../types";

const me = createApp();
const tags = ["Profile"];

const getMeRoute = createRoute({
  method: "get",
  path: "/",
  tags,
  summary: "Your profile",
  security: bearerAuth,
  middleware: [requireUser] as const,
  responses: { 200: json(UserSchema, "Your profile"), ...errors(401) },
});

me.openapi(getMeRoute, async (c) => c.json(publicUser(c.get("user")), 200));

const updateMeRoute = createRoute({
  method: "patch",
  path: "/",
  tags,
  summary: "Edit your profile",
  description:
    "Send any of name, username, bio and profileVisibility; fields left out are not changed. The name is shown in every rollo you are part of and does not have to be unique. " +
    "The username must be unique (case-insensitive); setting your own current one is a no-op. 409 if someone else has it. " +
    "The bio is trimmed, an empty one clears it (null), and it allows up to 150 characters and 3 lines (400 otherwise). " +
    "profileVisibility is \"friends\" (default) or \"public\"; any other value is a 400.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { body: { content: { "application/json": { schema: UpdateProfileSchema } }, required: true } },
  responses: { 200: json(UserSchema, "Profile updated"), ...errors(400, 401, 409) },
});

me.openapi(updateMeRoute, async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const next = {
    name: body.name ?? user.name,
    username: body.username ?? user.username,
    bio: body.bio === undefined ? user.bio : body.bio,
    profile_visibility: body.profileVisibility ?? user.profile_visibility,
  };
  if (body.username !== undefined && body.username !== user.username) {
    const owner = await c.env.DB.prepare("SELECT id FROM users WHERE username = ? AND id != ?")
      .bind(body.username, user.id)
      .first();
    if (owner) throw new HTTPException(409, { message: USERNAME_TAKEN_MESSAGE });
  }
  try {
    await c.env.DB.prepare("UPDATE users SET name = ?, username = ?, bio = ?, profile_visibility = ? WHERE id = ?")
      .bind(next.name, next.username, next.bio, next.profile_visibility, user.id)
      .run();
  } catch (err) {
    // Lost a race against another account taking the same username.
    if (String(err).includes("UNIQUE")) throw new HTTPException(409, { message: USERNAME_TAKEN_MESSAGE });
    throw err;
  }
  return c.json(publicUser({ ...user, ...next }), 200);
});

const AVATAR_URL_TTL = 15 * 60;
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

/** The stored content type is client-controlled, so the magic bytes are the source of truth. */
function hasJpegMagic(bytes: Uint8Array): boolean {
  return bytes.length >= JPEG_MAGIC.length && JPEG_MAGIC.every((b, i) => bytes[i] === b);
}

const avatarRoute = createRoute({
  method: "post",
  path: "/avatar",
  tags,
  summary: "Get a URL to upload your avatar",
  description:
    "Returns a signed URL to PUT a JPEG straight to R2. Then call POST /me/avatar/complete. " +
    "Each call generates a new random file name, so the avatar URL changes when you replace it.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  responses: { 200: json(AvatarUploadSchema, "Upload URL"), ...errors(401) },
});

me.openapi(avatarRoute, async (c) => {
  const user = c.get("user");
  const key = `avatars/${user.id}/${crypto.randomUUID()}.jpg`;
  await c.env.DB.prepare("UPDATE users SET pending_avatar_key = ? WHERE id = ?").bind(key, user.id).run();
  const upload = await presignPut(c.env, key, new URL(c.req.url).origin, AVATAR_URL_TTL);
  return c.json({ upload, expiresIn: AVATAR_URL_TTL }, 200);
});

const avatarCompleteRoute = createRoute({
  method: "post",
  path: "/avatar/complete",
  tags,
  summary: "Confirm your avatar upload",
  description:
    "Checks that the file is in R2, is a JPEG (verified by its magic bytes) and is at most 2 MB, " +
    "makes it your avatar and deletes the previous one. Otherwise the upload is discarded and the response is a 400.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  responses: { 200: json(UserSchema, "Profile with the new avatar"), ...errors(400, 401) },
});

me.openapi(avatarCompleteRoute, async (c) => {
  const user = c.get("user");
  const pending = user.pending_avatar_key;
  if (!pending) throw new HTTPException(400, { message: "Primero pedí dónde subir la foto" });
  const object = await c.env.MEDIA.get(pending);
  if (!object) throw new HTTPException(400, { message: "Falta la foto; volvé a subirla" });

  // Validate and copy the very same bytes: the presigned PUT stays valid after this call.
  const bytes = object.size > AVATAR_MAX_BYTES ? null : await object.arrayBuffer();
  if (!bytes || bytes.byteLength > AVATAR_MAX_BYTES || !hasJpegMagic(new Uint8Array(bytes))) {
    await c.env.MEDIA.delete(pending);
    await c.env.DB.prepare("UPDATE users SET pending_avatar_key = NULL WHERE id = ?").bind(user.id).run();
    throw new HTTPException(400, { message: "La foto tiene que ser un JPEG de hasta 2 MB" });
  }

  // Promote to a key that was never presigned, so nobody can overwrite it afterwards.
  const key = `avatars/${user.id}/${crypto.randomUUID()}.jpg`;
  await c.env.MEDIA.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
  await c.env.MEDIA.delete(pending);
  await c.env.DB.prepare("UPDATE users SET avatar_key = ?, pending_avatar_key = NULL WHERE id = ?")
    .bind(key, user.id)
    .run();
  if (user.avatar_key) await c.env.MEDIA.delete(user.avatar_key);
  return c.json(publicUser({ ...user, avatar_key: key }), 200);
});

const deleteMeRoute = createRoute({
  method: "delete",
  path: "/",
  tags,
  summary: "Delete your account",
  description:
    "Permanently deletes the account. In every rollo you belong to (also those you were removed from), " +
    "your photos and videos are deleted (database rows and files, even after the reveal) and your membership is removed. " +
    "If you were the admin, the oldest remaining active member becomes admin. " +
    "If no active members remain, the whole rollo is deleted with all its files. " +
    "Your reports and blocks (made and received) are deleted too. Your friendships, friend links and claims, avatar, sessions and pending login codes are deleted too (your friends keep their rollos). " +
    "The same email can sign up again later as a brand-new user.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  responses: { 204: { description: "Account deleted" }, ...errors(401) },
});

me.openapi(deleteMeRoute, async (c) => {
  await deleteAccount(c.env, c.get("user"));
  return c.body(null, 204);
});

const myTripsRoute = createRoute({
  method: "get",
  path: "/trips",
  tags,
  summary: "Your rollos",
  description: "Rollos you are an active member of, most recent start first.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  responses: { 200: json(MyTripsSchema, "Your rollos"), ...errors(401) },
});

me.openapi(myTripsRoute, async (c) => {
  const now = Date.now();
  const { results } = await c.env.DB.prepare(
    `SELECT t.*, m.role AS my_role,
            (SELECT COUNT(*) FROM media WHERE trip_id = t.id AND status = 'uploaded' AND deleted_at IS NULL) AS total_uploaded,
            (SELECT cm.thumbhash FROM media cm JOIN members cmem ON cmem.id = cm.member_id
             WHERE cm.trip_id = t.id AND cm.status = 'uploaded' AND cm.deleted_at IS NULL AND cm.thumbhash IS NOT NULL AND ${hiddenMediaSql("cm", "cmem")}
             ORDER BY cm.taken_at DESC, cm.id DESC LIMIT 1) AS cover_thumbhash
     FROM members m JOIN trips t ON t.id = m.trip_id
     WHERE m.user_id = ? AND m.removed_at IS NULL AND m.left_at IS NULL
     ORDER BY t.starts_at DESC`,
  )
    .bind(c.get("user").id, c.get("user").id, c.get("user").id)
    .all<TripRow & { my_role: Role; total_uploaded: number; cover_thumbhash: string | null }>();

  return c.json(
    {
      trips: results.map((t) => ({
        id: t.id,
        name: t.name,
        joinCode: t.join_code,
        startsAt: t.starts_at,
        endsAt: t.ends_at,
        revealAt: t.reveal_at,
        revealed: isRevealed(t, now),
        role: t.my_role,
        totalUploaded: t.total_uploaded,
        coverThumbhash: t.cover_thumbhash,
      })),
    },
    200,
  );
});

export default me;
