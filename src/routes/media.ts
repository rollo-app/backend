import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { deleteTripMedia } from "../lib/account";
import { requireAdmin, requireMediaMember, requireTripMember, requireUser } from "../lib/auth";
import { rateLimit } from "../lib/rate-limit";
import { bearerAuth, createApp, errors, json } from "../lib/openapi";
import { hiddenMediaSql } from "../lib/moderation";
import { mediaKeys, presignPut, serveMediaFile } from "../lib/r2";
import { avatarUrl, isRevealed, localDate } from "../lib/util";
import {
  FeedResponseSchema,
  MediaFileParams,
  MediaParams,
  MediaRegisteredSchema,
  MAX_SIZE,
  MAX_THUMB_SIZE,
  MediaStatusSchema,
  PAST_TOLERANCE_MS,
  RegisterMediaSchema,
  TripParams,
} from "../schemas";
import type { AppEnv, MediaRow, MediaType } from "../types";

const media = createApp();
const tags = ["Media"];
const UPLOAD_URL_TTL = 15 * 60;

async function uploadResponse(
  env: AppEnv["Bindings"],
  origin: string,
  id: string,
  originalKey: string,
  thumbKey: string,
  sizes: { original: number | null; thumb: number | null },
) {
  const [original, thumb] = await Promise.all([
    presignPut(env, originalKey, origin, sizes.original),
    presignPut(env, thumbKey, origin, sizes.thumb),
  ]);
  return { id, status: "pending" as const, upload: { original, thumb }, expiresIn: UPLOAD_URL_TTL };
}

// ---------- Register ----------

const registerRoute = createRoute({
  method: "post",
  path: "/trips/{tripId}/media",
  tags,
  summary: "Register a photo or video",
  description:
    "Returns signed URLs to upload the original and the thumbnail straight to R2; each is signed for the exact byte size declared (`sizeBytes`, `thumbSizeBytes`). " +
    "Idempotent by `id`: retrying from the offline queue neither duplicates nor spends quota.",
  security: bearerAuth,
  middleware: [requireUser, rateLimit("RL_EXPENSIVE"), requireTripMember] as const,
  request: {
    params: TripParams,
    body: { content: { "application/json": { schema: RegisterMediaSchema } }, required: true },
  },
  responses: {
    201: json(MediaRegisteredSchema, "Registered; upload the files"),
    200: json(z.union([MediaRegisteredSchema, MediaStatusSchema]), "Retry: new URLs, or it was already uploaded"),
    ...errors(400, 401, 403, 409, 429),
  },
});

media.openapi(registerRoute, async (c) => {
  const trip = c.get("trip");
  const me = c.get("member");
  const b = c.req.valid("json");
  const now = Date.now();

  if (isRevealed(trip, now)) throw new HTTPException(409, { message: "El rollo ya se reveló" });
  if (b.takenAt > now + PAST_TOLERANCE_MS) throw new HTTPException(400, { message: "La hora de la foto está en el futuro" });

  const existing = await c.env.DB.prepare("SELECT * FROM media WHERE id = ?").bind(b.id).first<MediaRow>();
  if (existing) {
    if (existing.member_id !== me.id) throw new HTTPException(409, { message: "Ese id ya existe" });
    if (existing.deleted_at !== null) throw new HTTPException(409, { message: "El admin borró esta foto" });
    if (existing.status === "uploaded") return c.json({ id: existing.id, status: "uploaded" as const }, 200);
    return c.json(await uploadResponse(c.env, new URL(c.req.url).origin, existing.id, existing.original_key, existing.thumb_key, {
      original: existing.size_bytes,
      thumb: existing.thumb_size_bytes,
    }), 200);
  }

  // Validated against when the photo was taken, not against the upload time: the offline queue
  // may register photos taken during the rollo after it ended (as long as it isn't revealed).
  // Placed after the existing-id branch so a retry is never newly rejected (e.g. if the admin edited the dates).
  if (b.takenAt < trip.starts_at - PAST_TOLERANCE_MS) {
    throw new HTTPException(400, { message: "Este rollo todavía no empezó" });
  }
  if (b.takenAt > trip.ends_at + PAST_TOLERANCE_MS) {
    throw new HTTPException(400, { message: "Este rollo ya terminó" });
  }

  // Daily limit by the trip's local date. Also counts pending ones
  // (so you can't "reserve" more than allowed) and the ones deleted by the admin.
  const day = localDate(b.takenAt, trip.timezone);
  const limit = b.type === "photo" ? trip.daily_photo_limit : trip.daily_video_limit;
  const count = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM media WHERE member_id = ? AND local_date = ? AND type = ?",
  ).bind(me.id, day, b.type).first<{ n: number }>();
  if ((count?.n ?? 0) >= limit) {
    const what = b.type === "photo" ? "fotos" : "videos";
    throw new HTTPException(429, { message: `Ya usaste tus ${limit} ${what} de hoy` });
  }

  const keys = mediaKeys(trip.id, b.id, b.type as MediaType);
  await c.env.DB.prepare(
    `INSERT INTO media (id, trip_id, member_id, type, taken_at, local_date, lat, lng, accuracy_m,
                        caption, thumbhash, duration_s, width, height, size_bytes, thumb_size_bytes, original_key, thumb_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    b.id, trip.id, me.id, b.type, b.takenAt, day, b.lat ?? null, b.lng ?? null, b.accuracyM ?? null,
    b.caption || null, b.thumbhash ?? null, b.durationS ?? null, b.width ?? null, b.height ?? null, b.sizeBytes, b.thumbSizeBytes,
    keys.original, keys.thumb, now,
  ).run();

  return c.json(await uploadResponse(c.env, new URL(c.req.url).origin, b.id, keys.original, keys.thumb, {
    original: b.sizeBytes,
    thumb: b.thumbSizeBytes,
  }), 201);
});

// ---------- Confirm upload ----------

const completeRoute = createRoute({
  method: "post",
  path: "/media/{mediaId}/complete",
  tags,
  summary: "Confirm the files were uploaded",
  description:
    "Checks that the original and the thumbnail are in R2 and that their sizes match what was registered. " +
    "Only then does the photo show up in the feed. On a size mismatch both files are deleted and the media stays pending (register again for new URLs).",
  security: bearerAuth,
  middleware: [requireUser, rateLimit("RL_EXPENSIVE"), requireMediaMember] as const,
  request: { params: MediaParams },
  responses: { 200: json(MediaStatusSchema, "Upload confirmed"), ...errors(400, 401, 404, 429) },
});

media.openapi(completeRoute, async (c) => {
  const me = c.get("member");
  const { mediaId } = c.req.valid("param");
  const row = await c.env.DB.prepare("SELECT * FROM media WHERE id = ? AND member_id = ? AND deleted_at IS NULL")
    .bind(mediaId, me.id)
    .first<MediaRow>();
  if (!row) throw new HTTPException(404, { message: "No encontrado" });
  if (row.status === "uploaded") return c.json({ id: row.id, status: "uploaded" as const }, 200);

  const [original, thumb] = await Promise.all([c.env.MEDIA.head(row.original_key), c.env.MEDIA.head(row.thumb_key)]);
  if (!original || !thumb) {
    throw new HTTPException(400, { message: "Faltan archivos en el storage; volvé a subirlos" });
  }
  const mismatch =
    original.size !== row.size_bytes ||
    (row.thumb_size_bytes !== null && thumb.size !== row.thumb_size_bytes) ||
    original.size > MAX_SIZE[row.type] ||
    thumb.size > MAX_THUMB_SIZE;
  if (mismatch) {
    await c.env.MEDIA.delete([row.original_key, row.thumb_key]);
    throw new HTTPException(400, { message: "El archivo no coincide con el que registraste; volvé a subirlo" });
  }

  await c.env.DB.prepare("UPDATE media SET status = 'uploaded', uploaded_at = ?, size_bytes = ? WHERE id = ?")
    .bind(Date.now(), original.size, row.id)
    .run();
  return c.json({ id: row.id, status: "uploaded" as const }, 200);
});

// ---------- Feed ----------

const feedRoute = createRoute({
  method: "get",
  path: "/trips/{tripId}/feed",
  tags,
  summary: "Trip feed",
  description:
    "Before the reveal: metadata only (author, time, place, caption, thumbhash), no files, not even your own. " +
    "After: includes dimensions, the download paths, whether you featured each photo, whether its author blocked featuring, " +
    "and its likes (`likeCount`, `likedByMe`). " +
    "Every item carries the author's user id (`author.userId`). Photos you reported and photos by people you blocked are left out.",
  security: bearerAuth,
  middleware: [requireUser, requireTripMember] as const,
  request: { params: TripParams },
  responses: { 200: json(FeedResponseSchema, "Feed ordered by the time the shot was taken"), ...errors(401, 403) },
});

media.openapi(feedRoute, async (c) => {
  const trip = c.get("trip");
  const revealed = isRevealed(trip);
  const viewerId = c.get("user").id;

  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.type, m.taken_at, m.local_date, m.lat, m.lng, m.caption, m.thumbhash, m.duration_s,
            m.width, m.height, mem.id AS author_id, u.name AS author_name, u.username AS author_username, mem.user_id AS author_user_id, u.avatar_key AS author_avatar_key,
            m.feature_blocked_at, f.media_id IS NOT NULL AS featured_by_me,
            COALESCE(lc.n, 0) AS like_count, ml.media_id IS NOT NULL AS liked_by_me
     FROM media m JOIN members mem ON mem.id = m.member_id JOIN users u ON u.id = mem.user_id
     LEFT JOIN featured f ON f.media_id = m.id AND f.user_id = ?
     LEFT JOIN likes ml ON ml.media_id = m.id AND ml.user_id = ?
     LEFT JOIN (SELECT l.media_id, COUNT(*) AS n FROM likes l JOIN media lm ON lm.id = l.media_id
                WHERE lm.trip_id = ? GROUP BY l.media_id) lc ON lc.media_id = m.id
     WHERE m.trip_id = ? AND m.status = 'uploaded' AND m.deleted_at IS NULL AND ${hiddenMediaSql("m", "mem")}
     ORDER BY m.taken_at`,
  ).bind(viewerId, viewerId, trip.id, trip.id, viewerId, viewerId).all<{
    id: string; type: MediaType; taken_at: number; local_date: string; lat: number | null; lng: number | null;
    caption: string | null; thumbhash: string | null; duration_s: number | null; width: number | null; height: number | null;
    author_id: string; author_name: string | null; author_username: string | null; author_user_id: string; author_avatar_key: string | null;
    feature_blocked_at: number | null; featured_by_me: number; like_count: number; liked_by_me: number;
  }>();

  const items = results.map((r) => ({
    id: r.id,
    type: r.type,
    takenAt: r.taken_at,
    day: r.local_date,
    lat: r.lat,
    lng: r.lng,
    caption: r.caption,
    thumbhash: r.thumbhash,
    durationS: r.duration_s,
    author: {
      id: r.author_id,
      userId: r.author_user_id,
      name: r.author_name ?? "",
      username: r.author_username,
      avatarUrl: avatarUrl(r.author_user_id, r.author_avatar_key),
    },
    ...(revealed && {
      width: r.width,
      height: r.height,
      files: {
        thumb: `/trips/${trip.id}/media/${r.id}/thumb`,
        original: `/trips/${trip.id}/media/${r.id}/original`,
      },
      featuredByMe: r.featured_by_me === 1,
      featureBlocked: r.feature_blocked_at !== null,
      likeCount: r.like_count,
      likedByMe: r.liked_by_me === 1,
    }),
  }));

  return c.json({ revealed, revealAt: trip.reveal_at, items }, 200);
});

// ---------- Download ----------

const downloadRoute = createRoute({
  method: "get",
  path: "/trips/{tripId}/media/{mediaId}/{variant}",
  tags,
  summary: "Download a file (only after the reveal)",
  description: "Streamed from R2 with the same Bearer token.",
  security: bearerAuth,
  middleware: [requireUser, rateLimit("RL_FILES"), requireTripMember] as const,
  request: { params: MediaFileParams },
  responses: {
    200: {
      description: "File",
      content: {
        "image/jpeg": { schema: z.string().openapi({ format: "binary" }) },
        "video/mp4": { schema: z.string().openapi({ format: "binary" }) },
      },
    },
    ...errors(401, 403, 404, 429),
  },
});

media.openapi(downloadRoute, async (c) => {
  const trip = c.get("trip");
  if (!isRevealed(trip)) throw new HTTPException(403, { message: "Todavía no se reveló el rollo" });

  const { mediaId, variant } = c.req.valid("param");
  const row = await c.env.DB.prepare(
    "SELECT original_key, thumb_key FROM media WHERE id = ? AND trip_id = ? AND status = 'uploaded' AND deleted_at IS NULL",
  ).bind(mediaId, trip.id).first<Pick<MediaRow, "original_key" | "thumb_key">>();
  if (!row) throw new HTTPException(404, { message: "No encontrado" });

  return serveMediaFile(c.env.MEDIA, variant === "thumb" ? row.thumb_key : row.original_key);
});

// ---------- Delete ----------

const deleteRoute = createRoute({
  method: "delete",
  path: "/media/{mediaId}",
  tags,
  summary: "Delete a photo or video from the trip (admin, before the reveal)",
  description:
    "Once sent, a photo can be neither deleted nor retaken. The exception is the admin, in case someone " +
    "sends something inappropriate: they can delete any photo of the trip before the reveal. " +
    "The files are deleted but the quota is **not given back** to anyone, and the id cannot be registered again.",
  security: bearerAuth,
  middleware: [requireUser, requireMediaMember, requireAdmin] as const,
  request: { params: MediaParams },
  responses: { 204: { description: "Deleted" }, ...errors(401, 403, 404, 409) },
});

media.openapi(deleteRoute, async (c) => {
  const trip = c.get("trip");
  if (isRevealed(trip)) throw new HTTPException(409, { message: "El rollo ya se reveló" });

  const { mediaId } = c.req.valid("param");
  const inTrip = await c.env.DB.prepare("SELECT 1 FROM media WHERE id = ? AND trip_id = ?").bind(mediaId, trip.id).first();
  if (!inTrip || !(await deleteTripMedia(c.env, mediaId))) throw new HTTPException(404, { message: "No encontrado" });
  return c.body(null, 204);
});

// ---------- Feature block (author) ----------

/**
 * The photo must be yours (you took it) and not deleted. Authorship is the media's member → user, so it holds
 * even after you left the rollo or were removed from it. 404 if it doesn't exist (or you aren't in its rollo
 * and didn't take it), 403 if an active member who didn't take it.
 */
async function requireOwnMedia(c: Context<AppEnv>, mediaId: string): Promise<string> {
  const userId = c.get("user").id;
  const row = await c.env.DB.prepare(
    `SELECT m.id, m.trip_id, author.user_id AS author_user_id
     FROM media m JOIN members author ON author.id = m.member_id
     WHERE m.id = ? AND m.deleted_at IS NULL`,
  )
    .bind(mediaId)
    .first<Pick<MediaRow, "id" | "trip_id"> & { author_user_id: string }>();
  if (!row) throw new HTTPException(404, { message: "No encontrado" });
  if (row.author_user_id === userId) return row.id;

  const member = await c.env.DB.prepare(
    "SELECT 1 FROM members WHERE trip_id = ? AND user_id = ? AND removed_at IS NULL AND left_at IS NULL",
  )
    .bind(row.trip_id, userId)
    .first();
  if (!member) throw new HTTPException(404, { message: "No encontrado" });
  throw new HTTPException(403, { message: "Solo quien sacó la foto puede cambiar esto" });
}

const blockFeatureRoute = createRoute({
  method: "put",
  path: "/media/{mediaId}/feature-block",
  tags,
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { params: MediaParams },
  responses: { 204: { description: "Done" }, ...errors(401, 403, 404) },
  summary: "Don't let others feature this photo (author only)",
  description:
    "Removes it from everyone else's profile and stops new ones (they get 409). You can still feature it yourself. " +
    "Idempotent. Works even if you left the rollo or were removed from it. " +
    "403 if you did not take it; 404 if it does not exist or you neither took it nor are an active member of its rollo.",
});

media.openapi(blockFeatureRoute, async (c) => {
  const id = await requireOwnMedia(c, c.req.valid("param").mediaId);
  const { DB } = c.env;
  await DB.batch([
    DB.prepare("UPDATE media SET feature_blocked_at = COALESCE(feature_blocked_at, ?) WHERE id = ?").bind(Date.now(), id),
    DB.prepare("DELETE FROM featured WHERE media_id = ? AND user_id != ?").bind(id, c.get("user").id),
  ]);
  return c.body(null, 204);
});

const unblockFeatureRoute = createRoute({
  method: "delete",
  path: "/media/{mediaId}/feature-block",
  tags,
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { params: MediaParams },
  responses: { 204: { description: "Done" }, ...errors(401, 403, 404) },
  summary: "Let others feature this photo again (author only)",
  description:
    "Idempotent. Works even if you left the rollo or were removed from it. " +
    "Photos removed from other profiles while it was blocked do not come back.",
});

media.openapi(unblockFeatureRoute, async (c) => {
  const id = await requireOwnMedia(c, c.req.valid("param").mediaId);
  await c.env.DB.prepare("UPDATE media SET feature_blocked_at = NULL WHERE id = ?").bind(id).run();
  return c.body(null, 204);
});

export default media;
