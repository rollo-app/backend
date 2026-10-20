import { createRoute } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { requireUser } from "../lib/auth";
import { bearerAuth, createApp, errors, json } from "../lib/openapi";
import { presignPut } from "../lib/r2";
import { isRevealed, publicUser } from "../lib/util";
import { AvatarUploadSchema, MyTripsSchema, UpdateProfileSchema, UserSchema } from "../schemas";
import type { MediaRow, Role, TripRow } from "../types";

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
  description: "The name is shown in every rollo you are part of. It does not have to be unique.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { body: { content: { "application/json": { schema: UpdateProfileSchema } }, required: true } },
  responses: { 200: json(UserSchema, "Profile updated"), ...errors(400, 401) },
});

me.openapi(updateMeRoute, async (c) => {
  const user = c.get("user");
  const { name } = c.req.valid("json");
  await c.env.DB.prepare("UPDATE users SET name = ? WHERE id = ?").bind(name, user.id).run();
  return c.json(publicUser({ ...user, name }), 200);
});

const AVATAR_URL_TTL = 15 * 60;

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
  description: "Checks that the file is in R2, makes it your avatar and deletes the previous one.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  responses: { 200: json(UserSchema, "Profile with the new avatar"), ...errors(400, 401) },
});

me.openapi(avatarCompleteRoute, async (c) => {
  const user = c.get("user");
  const pending = user.pending_avatar_key;
  if (!pending) throw new HTTPException(400, { message: "Primero pedí dónde subir la foto" });
  if (!(await c.env.MEDIA.head(pending))) throw new HTTPException(400, { message: "Falta la foto; volvé a subirla" });

  await c.env.DB.prepare("UPDATE users SET avatar_key = ?, pending_avatar_key = NULL WHERE id = ?")
    .bind(pending, user.id)
    .run();
  if (user.avatar_key) await c.env.MEDIA.delete(user.avatar_key);
  return c.json(publicUser({ ...user, avatar_key: pending }), 200);
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
    "Your avatar, sessions and pending login codes are deleted too. " +
    "The same email can sign up again later as a brand-new user.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  responses: { 204: { description: "Account deleted" }, ...errors(401) },
});

async function deleteMediaRows(db: D1Database, bucket: R2Bucket, where: string, id: string) {
  const { results } = await db
    .prepare(`SELECT original_key, thumb_key FROM media WHERE ${where} = ?`)
    .bind(id)
    .all<Pick<MediaRow, "original_key" | "thumb_key">>();
  const keys = results.flatMap((r) => [r.original_key, r.thumb_key]);
  // R2 deletes accept at most 1000 keys per call.
  for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
}

me.openapi(deleteMeRoute, async (c) => {
  const user = c.get("user");
  const { DB, MEDIA } = c.env;

  const { results: memberships } = await DB.prepare("SELECT * FROM members WHERE user_id = ?")
    .bind(user.id)
    .all<{ id: string; trip_id: string; role: Role; removed_at: number | null }>();

  for (const m of memberships) {
    await deleteMediaRows(DB, MEDIA, "member_id", m.id);
    await DB.batch([
      DB.prepare("DELETE FROM media WHERE member_id = ?").bind(m.id),
      DB.prepare("DELETE FROM members WHERE id = ?").bind(m.id),
    ]);

    const next = await DB.prepare(
      "SELECT id, role FROM members WHERE trip_id = ? AND removed_at IS NULL ORDER BY created_at, id",
    )
      .bind(m.trip_id)
      .all<{ id: string; role: Role }>();

    if (next.results.length === 0) {
      await deleteMediaRows(DB, MEDIA, "trip_id", m.trip_id);
      await DB.batch([
        DB.prepare("DELETE FROM media WHERE trip_id = ?").bind(m.trip_id),
        DB.prepare("DELETE FROM members WHERE trip_id = ?").bind(m.trip_id),
        DB.prepare("DELETE FROM trips WHERE id = ?").bind(m.trip_id),
      ]);
    } else if (m.role === "admin" && m.removed_at === null && !next.results.some((r) => r.role === "admin")) {
      await DB.prepare("UPDATE members SET role = 'admin' WHERE id = ?").bind(next.results[0]!.id).run();
    }
  }

  const avatars = [user.avatar_key, user.pending_avatar_key].filter((k): k is string => k !== null);
  if (avatars.length) await MEDIA.delete(avatars);

  await DB.batch([
    DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
    DB.prepare("DELETE FROM auth_codes WHERE email = ?").bind(user.email),
    DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
  ]);
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
            (SELECT COUNT(*) FROM media WHERE trip_id = t.id AND status = 'uploaded' AND deleted_at IS NULL) AS total_uploaded
     FROM members m JOIN trips t ON t.id = m.trip_id
     WHERE m.user_id = ? AND m.removed_at IS NULL
     ORDER BY t.starts_at DESC`,
  )
    .bind(c.get("user").id)
    .all<TripRow & { my_role: Role; total_uploaded: number }>();

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
      })),
    },
    200,
  );
});

export default me;
