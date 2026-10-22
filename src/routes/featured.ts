import { createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { requireUser } from "../lib/auth";
import { bearerAuth, createApp, errors, json } from "../lib/openapi";
import { canSeeProfile } from "../lib/profile-access";
import { serveMediaFile } from "../lib/r2";
import { avatarUrl, isRevealed } from "../lib/util";
import { zoneOf } from "../lib/zone";
import { FeaturedFileParams, FeaturedPhotosSchema, MAX_FEATURED, MediaParams, UserParams } from "../schemas";
import type { AppEnv, MediaRow, TripRow, UserRow } from "../types";

/**
 * Featured photos: photos from revealed rollos that a user pins to their profile.
 * What leaves this module never includes the rollo, the caption or the exact location (only a ~5 km zone).
 */
const featured = createApp();
const tags = ["Featured"];

const PRIVATE_PROFILE = "Este perfil es privado";

/**
 * Featured rows (`f`) that are visible on their owner's profile: an uploaded, not deleted photo of a revealed
 * rollo the owner is still an active member of, not blocked by its author (unless the owner is the author).
 * VISIBLE_FROM joins `m` (media), `t` (trips) and `author` (the author's membership); VISIBLE_WHERE binds `now`.
 */
const VISIBLE_FROM = `
  featured f
  JOIN media m ON m.id = f.media_id
  JOIN trips t ON t.id = m.trip_id
  JOIN members author ON author.id = m.member_id
  JOIN members owner ON owner.trip_id = m.trip_id AND owner.user_id = f.user_id
                    AND owner.removed_at IS NULL AND owner.left_at IS NULL`;
const VISIBLE_WHERE = `
  m.type = 'photo' AND m.status = 'uploaded' AND m.deleted_at IS NULL
  AND (t.revealed_at IS NOT NULL OR t.reveal_at <= ?)
  AND (m.feature_blocked_at IS NULL OR author.user_id = f.user_id)`;

// ---------- Feature / unfeature ----------

const featureRoute = createRoute({
  method: "put",
  path: "/me/featured/{mediaId}",
  tags,
  summary: "Feature a photo on your profile",
  description:
    `A photo (not a video) of a revealed rollo you are an active member of, yours or someone else's. Idempotent. ` +
    `404 if it does not exist or you are not an active member; 409 if the rollo is not revealed, if its author ` +
    `does not let others feature it (unless you took it) or if you already have ${MAX_FEATURED}; 400 for a video.`,
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { params: MediaParams },
  responses: { 204: { description: "Featured" }, ...errors(400, 401, 404, 409) },
});

featured.openapi(featureRoute, async (c) => {
  const user = c.get("user");
  const { mediaId } = c.req.valid("param");
  const { DB } = c.env;
  const now = Date.now();

  const row = await DB.prepare(
    `SELECT m.id, m.type, m.feature_blocked_at, author.user_id AS author_user_id,
            t.revealed_at, t.reveal_at
     FROM media m
     JOIN trips t ON t.id = m.trip_id
     JOIN members author ON author.id = m.member_id
     JOIN members me ON me.trip_id = m.trip_id AND me.user_id = ? AND me.removed_at IS NULL AND me.left_at IS NULL
     WHERE m.id = ? AND m.status = 'uploaded' AND m.deleted_at IS NULL`,
  )
    .bind(user.id, mediaId)
    .first<Pick<MediaRow, "id" | "type" | "feature_blocked_at"> & Pick<TripRow, "revealed_at" | "reveal_at"> & { author_user_id: string }>();
  if (!row) throw new HTTPException(404, { message: "No encontrado" });
  if (!isRevealed(row, now)) {
    throw new HTTPException(409, { message: "Este rollo todavía no se reveló" });
  }
  if (row.type !== "photo") throw new HTTPException(400, { message: "Solo se pueden destacar fotos" });

  const existing = await DB.prepare("SELECT 1 FROM featured WHERE user_id = ? AND media_id = ?").bind(user.id, row.id).first();
  if (existing) return c.body(null, 204);

  if (row.feature_blocked_at !== null && row.author_user_id !== user.id) {
    throw new HTTPException(409, { message: "Quien sacó esta foto no quiere que se destaque" });
  }

  // One statement, so two concurrent requests can't both slip past the cap.
  // Only photos that still show on the profile count: stale rows can't be removed from the app.
  const inserted = await DB.prepare(
    `INSERT OR IGNORE INTO featured (user_id, media_id, created_at)
     SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM ${VISIBLE_FROM} WHERE ${VISIBLE_WHERE} AND f.user_id = ?) < ?`,
  )
    .bind(user.id, row.id, now, now, user.id, MAX_FEATURED)
    .run();
  if (!inserted.meta.changes) {
    const raced = await DB.prepare("SELECT 1 FROM featured WHERE user_id = ? AND media_id = ?").bind(user.id, row.id).first();
    if (!raced) throw new HTTPException(409, { message: `Podés destacar hasta ${MAX_FEATURED} fotos` });
  }
  return c.body(null, 204);
});

const unfeatureRoute = createRoute({
  method: "delete",
  path: "/me/featured/{mediaId}",
  tags,
  summary: "Remove a photo from your profile",
  description: "204 also if it was not featured.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { params: MediaParams },
  responses: { 204: { description: "Not featured anymore" }, ...errors(401) },
});

featured.openapi(unfeatureRoute, async (c) => {
  await c.env.DB.prepare("DELETE FROM featured WHERE user_id = ? AND media_id = ?")
    .bind(c.get("user").id, c.req.valid("param").mediaId)
    .run();
  return c.body(null, 204);
});

// ---------- A user's featured photos ----------

/** The profile owner, or 404 if they don't exist / 403 if the viewer can't see their profile. */
async function visibleOwner(db: D1Database, viewerId: string, userId: string) {
  const owner = await db
    .prepare("SELECT id, profile_visibility FROM users WHERE id = ?")
    .bind(userId)
    .first<Pick<UserRow, "id" | "profile_visibility">>();
  if (!owner) throw new HTTPException(404, { message: "No existe" });
  if (!(await canSeeProfile(db, viewerId, owner))) throw new HTTPException(403, { message: PRIVATE_PROFILE });
  return owner;
}

const listRoute = createRoute({
  method: "get",
  path: "/users/{userId}/featured",
  tags,
  summary: "A user's featured photos",
  description:
    "Most recently featured first. Only if you can see the profile (it is you, a friend, or it is public); otherwise 403. " +
    "Each photo carries a ~5 km zone instead of its location, and its author when it is not the owner; never the rollo or the caption. " +
    "Photos that were deleted, blocked by their author, or whose rollo the owner left do not show up.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { params: UserParams },
  responses: { 200: json(FeaturedPhotosSchema, "Featured photos"), ...errors(401, 403, 404) },
});

featured.openapi(listRoute, async (c) => {
  const owner = await visibleOwner(c.env.DB, c.get("user").id, c.req.valid("param").userId);

  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.taken_at, m.width, m.height, m.thumbhash, m.lat, m.lng,
            author.user_id AS author_user_id, u.name AS author_name, u.username AS author_username, u.avatar_key AS author_avatar_key
     FROM ${VISIBLE_FROM} JOIN users u ON u.id = author.user_id
     WHERE ${VISIBLE_WHERE} AND f.user_id = ?
     ORDER BY f.created_at DESC, f.media_id`,
  )
    .bind(Date.now(), owner.id)
    .all<{
      id: string; taken_at: number; width: number | null; height: number | null; thumbhash: string | null;
      lat: number | null; lng: number | null;
      author_user_id: string; author_name: string | null; author_username: string | null; author_avatar_key: string | null;
    }>();

  const photos = results.map((r) => ({
    mediaId: r.id,
    takenAt: r.taken_at,
    width: r.width,
    height: r.height,
    thumbhash: r.thumbhash,
    author:
      r.author_user_id === owner.id
        ? null
        : {
            id: r.author_user_id,
            name: r.author_name ?? "",
            username: r.author_username,
            avatarUrl: avatarUrl(r.author_user_id, r.author_avatar_key),
          },
    zone: zoneOf(r.lat, r.lng),
    thumbPath: `/featured/${owner.id}/${r.id}/thumb`,
    originalPath: `/featured/${owner.id}/${r.id}/original`,
  }));
  return c.json({ photos }, 200);
});

// ---------- Files ----------

const fileRoute = createRoute({
  method: "get",
  path: "/featured/{userId}/{mediaId}/{variant}",
  tags,
  summary: "File of a featured photo",
  description:
    "Streamed from R2 under the profile's permission (not the rollo's): 403 if you can't see the profile, " +
    "404 if that user does not feature this photo (or it no longer shows on their profile). Same caching as the trip download.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { params: FeaturedFileParams },
  responses: {
    200: { description: "File", content: { "image/jpeg": { schema: z.string().openapi({ format: "binary" }) } } },
    ...errors(400, 401, 403, 404),
  },
});

featured.openapi(fileRoute, async (c) => {
  const { userId, mediaId, variant } = c.req.valid("param");
  const owner = await visibleOwner(c.env.DB, c.get("user").id, userId);
  const row = await c.env.DB.prepare(
    `SELECT m.original_key, m.thumb_key FROM ${VISIBLE_FROM} WHERE ${VISIBLE_WHERE} AND f.user_id = ? AND f.media_id = ?`,
  )
    .bind(Date.now(), owner.id, mediaId)
    .first<Pick<MediaRow, "original_key" | "thumb_key">>();
  if (!row) throw new HTTPException(404, { message: "No encontrado" });
  return serveMediaFile(c.env.MEDIA, variant === "thumb" ? row.thumb_key : row.original_key);
});

export default featured;
