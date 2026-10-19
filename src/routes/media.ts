import { createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { requireAdmin, requireMember } from "../lib/auth";
import { bearerAuth, createApp, errors, json } from "../lib/openapi";
import { mediaKeys, presignPut } from "../lib/r2";
import { isRevealed, localDate } from "../lib/util";
import {
  FeedResponseSchema,
  MediaFileParams,
  MediaParams,
  MediaRegisteredSchema,
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
) {
  const [original, thumb] = await Promise.all([
    presignPut(env, originalKey, origin),
    presignPut(env, thumbKey, origin),
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
    "Returns signed URLs to upload the original and the thumbnail straight to R2. " +
    "Idempotent by `id`: retrying from the offline queue neither duplicates nor spends quota.",
  security: bearerAuth,
  middleware: [requireMember] as const,
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
    return c.json(await uploadResponse(c.env, new URL(c.req.url).origin, existing.id, existing.original_key, existing.thumb_key), 200);
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
                        caption, thumbhash, duration_s, width, height, size_bytes, original_key, thumb_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    b.id, trip.id, me.id, b.type, b.takenAt, day, b.lat ?? null, b.lng ?? null, b.accuracyM ?? null,
    b.caption || null, b.thumbhash ?? null, b.durationS ?? null, b.width ?? null, b.height ?? null, b.sizeBytes,
    keys.original, keys.thumb, now,
  ).run();

  return c.json(await uploadResponse(c.env, new URL(c.req.url).origin, b.id, keys.original, keys.thumb), 201);
});

// ---------- Confirm upload ----------

const completeRoute = createRoute({
  method: "post",
  path: "/media/{mediaId}/complete",
  tags,
  summary: "Confirm the files were uploaded",
  description: "Checks that the original and the thumbnail are in R2. Only then does the photo show up in the feed.",
  security: bearerAuth,
  middleware: [requireMember] as const,
  request: { params: MediaParams },
  responses: { 200: json(MediaStatusSchema, "Upload confirmed"), ...errors(400, 401, 404) },
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
    "After: includes dimensions and the download paths.",
  security: bearerAuth,
  middleware: [requireMember] as const,
  request: { params: TripParams },
  responses: { 200: json(FeedResponseSchema, "Feed ordered by the time the shot was taken"), ...errors(401, 403) },
});

media.openapi(feedRoute, async (c) => {
  const trip = c.get("trip");
  const revealed = isRevealed(trip);

  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.type, m.taken_at, m.local_date, m.lat, m.lng, m.caption, m.thumbhash, m.duration_s,
            m.width, m.height, mem.id AS author_id, mem.name AS author_name
     FROM media m JOIN members mem ON mem.id = m.member_id
     WHERE m.trip_id = ? AND m.status = 'uploaded' AND m.deleted_at IS NULL
     ORDER BY m.taken_at`,
  ).bind(trip.id).all<{
    id: string; type: MediaType; taken_at: number; local_date: string; lat: number | null; lng: number | null;
    caption: string | null; thumbhash: string | null; duration_s: number | null; width: number | null; height: number | null;
    author_id: string; author_name: string;
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
    author: { id: r.author_id, name: r.author_name },
    ...(revealed && {
      width: r.width,
      height: r.height,
      files: {
        thumb: `/trips/${trip.id}/media/${r.id}/thumb`,
        original: `/trips/${trip.id}/media/${r.id}/original`,
      },
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
  middleware: [requireMember] as const,
  request: { params: MediaFileParams },
  responses: {
    200: {
      description: "File",
      content: {
        "image/jpeg": { schema: z.string().openapi({ format: "binary" }) },
        "video/mp4": { schema: z.string().openapi({ format: "binary" }) },
      },
    },
    ...errors(401, 403, 404),
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

  const key = variant === "thumb" ? row.thumb_key : row.original_key;
  const object = await c.env.MEDIA.get(key);
  if (!object) throw new HTTPException(404, { message: "Archivo no encontrado" });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", key.endsWith(".mp4") ? "video/mp4" : "image/jpeg");
  }
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, max-age=31536000, immutable");
  return new Response(object.body, { headers });
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
  middleware: [requireMember, requireAdmin] as const,
  request: { params: MediaParams },
  responses: { 204: { description: "Deleted" }, ...errors(401, 403, 404, 409) },
});

media.openapi(deleteRoute, async (c) => {
  const trip = c.get("trip");
  if (isRevealed(trip)) throw new HTTPException(409, { message: "El rollo ya se reveló" });

  const { mediaId } = c.req.valid("param");
  const row = await c.env.DB.prepare("SELECT * FROM media WHERE id = ? AND trip_id = ? AND deleted_at IS NULL")
    .bind(mediaId, trip.id)
    .first<MediaRow>();
  if (!row) throw new HTTPException(404, { message: "No encontrado" });

  await c.env.MEDIA.delete([row.original_key, row.thumb_key]);
  await c.env.DB.prepare("UPDATE media SET deleted_at = ? WHERE id = ?").bind(Date.now(), row.id).run();
  return c.body(null, 204);
});

export default media;
