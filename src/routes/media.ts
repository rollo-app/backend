import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { requireMember } from "../lib/auth";
import { mediaKeys, presignPut } from "../lib/r2";
import { isRevealed, localDate } from "../lib/util";
import { validate } from "../lib/validate";
import type { AppEnv, MediaRow } from "../types";

const media = new Hono<AppEnv>();

const MB = 1024 * 1024;
const MAX_SIZE = { photo: 25 * MB, video: 60 * MB } as const;
const MAX_VIDEO_SECONDS = 15.5; // 15 s + margen de redondeo
const UPLOAD_URL_TTL = 15 * 60;

const registerSchema = z
  .object({
    id: z.string().uuid(),
    type: z.enum(["photo", "video"]),
    takenAt: z.number().int().positive(),
    lat: z.number().min(-90).max(90).nullish(),
    lng: z.number().min(-180).max(180).nullish(),
    accuracyM: z.number().nonnegative().nullish(),
    caption: z.string().trim().max(280).nullish(),
    durationS: z.number().positive().nullish(),
    width: z.number().int().positive().nullish(),
    height: z.number().int().positive().nullish(),
    sizeBytes: z.number().int().positive(),
  })
  .refine((d) => d.type !== "video" || (d.durationS != null && d.durationS <= MAX_VIDEO_SECONDS), {
    message: "los videos tienen que durar 15 segundos o menos",
    path: ["durationS"],
  })
  .refine((d) => d.sizeBytes <= MAX_SIZE[d.type], { message: "archivo demasiado grande", path: ["sizeBytes"] });

/**
 * Registrar una foto/video y obtener URLs para subirla.
 * Idempotente por `id` (lo genera el celular): reintentar desde la cola offline es seguro.
 */
media.post("/trips/:tripId/media", requireMember, validate("json", registerSchema), async (c) => {
  const trip = c.get("trip");
  const me = c.get("member");
  const b = c.req.valid("json");
  const now = Date.now();

  if (isRevealed(trip, now)) throw new HTTPException(409, { message: "El rollo ya se reveló" });
  if (b.takenAt > now + 5 * 60_000) throw new HTTPException(400, { message: "La hora de la foto está en el futuro" });
  if (b.takenAt < trip.starts_at - 24 * 3600_000) {
    throw new HTTPException(400, { message: "La foto es de antes del viaje" });
  }

  const existing = await c.env.DB.prepare("SELECT * FROM media WHERE id = ?").bind(b.id).first<MediaRow>();
  if (existing) {
    if (existing.member_id !== me.id) throw new HTTPException(409, { message: "Ese id ya existe" });
    if (existing.status === "uploaded") return c.json({ id: existing.id, status: "uploaded" });
    return c.json(await uploadResponse(c.env, existing.id, existing.original_key, existing.thumb_key));
  }

  // Límite diario según la fecha local del viaje. Cuenta también las pendientes,
  // así no se puede "reservar" más de la cuenta.
  const day = localDate(b.takenAt, trip.timezone);
  const limit = b.type === "photo" ? trip.daily_photo_limit : trip.daily_video_limit;
  const count = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM media WHERE member_id = ? AND local_date = ? AND type = ?",
  ).bind(me.id, day, b.type).first<{ n: number }>();
  if ((count?.n ?? 0) >= limit) {
    const what = b.type === "photo" ? "fotos" : "videos";
    throw new HTTPException(429, { message: `Ya usaste tus ${limit} ${what} de hoy` });
  }

  const keys = mediaKeys(trip.id, b.id, b.type);
  await c.env.DB.prepare(
    `INSERT INTO media (id, trip_id, member_id, type, taken_at, local_date, lat, lng, accuracy_m,
                        caption, duration_s, width, height, size_bytes, original_key, thumb_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    b.id, trip.id, me.id, b.type, b.takenAt, day, b.lat ?? null, b.lng ?? null, b.accuracyM ?? null,
    b.caption || null, b.durationS ?? null, b.width ?? null, b.height ?? null, b.sizeBytes,
    keys.original, keys.thumb, now,
  ).run();

  return c.json(await uploadResponse(c.env, b.id, keys.original, keys.thumb), 201);
});

async function uploadResponse(env: AppEnv["Bindings"], id: string, originalKey: string, thumbKey: string) {
  const [original, thumb] = await Promise.all([presignPut(env, originalKey), presignPut(env, thumbKey)]);
  return { id, status: "pending" as const, upload: { original, thumb }, expiresIn: UPLOAD_URL_TTL };
}

/** El celular avisa que terminó de subir. Verificamos que los archivos estén en R2. */
media.post("/media/:mediaId/complete", requireMember, async (c) => {
  const me = c.get("member");
  const row = await c.env.DB.prepare("SELECT * FROM media WHERE id = ? AND member_id = ?")
    .bind(c.req.param("mediaId"), me.id)
    .first<MediaRow>();
  if (!row) throw new HTTPException(404, { message: "No encontrado" });
  if (row.status === "uploaded") return c.json({ id: row.id, status: "uploaded" });

  const [original, thumb] = await Promise.all([c.env.MEDIA.head(row.original_key), c.env.MEDIA.head(row.thumb_key)]);
  if (!original || !thumb) {
    throw new HTTPException(400, { message: "Faltan archivos en el storage; volvé a subirlos" });
  }

  await c.env.DB.prepare("UPDATE media SET status = 'uploaded', uploaded_at = ?, size_bytes = ? WHERE id = ?")
    .bind(Date.now(), original.size, row.id)
    .run();
  return c.json({ id: row.id, status: "uploaded" });
});

/**
 * Feed del viaje.
 * Antes del revelado: solo metadata (autor, hora, lugar, epígrafe). Ni una foto, ni siquiera las tuyas.
 * Después: incluye los paths para pedir cada archivo.
 */
media.get("/trips/:tripId/feed", requireMember, async (c) => {
  const trip = c.get("trip");
  const revealed = isRevealed(trip);

  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.type, m.taken_at, m.local_date, m.lat, m.lng, m.caption, m.duration_s,
            m.width, m.height, mem.id AS author_id, mem.name AS author_name
     FROM media m JOIN members mem ON mem.id = m.member_id
     WHERE m.trip_id = ? AND m.status = 'uploaded'
     ORDER BY m.taken_at`,
  ).bind(trip.id).all<{
    id: string; type: string; taken_at: number; local_date: string; lat: number | null; lng: number | null;
    caption: string | null; duration_s: number | null; width: number | null; height: number | null;
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

  return c.json({ revealed, revealAt: trip.reveal_at, items });
});

/**
 * Descarga de un archivo, solo después del revelado.
 * El Worker hace streaming desde R2 (casi no usa CPU), con el mismo Bearer token.
 */
media.get("/trips/:tripId/media/:mediaId/:variant{thumb|original}", requireMember, async (c) => {
  const trip = c.get("trip");
  if (!isRevealed(trip)) throw new HTTPException(403, { message: "Todavía no se reveló el rollo" });

  const row = await c.env.DB.prepare(
    "SELECT original_key, thumb_key FROM media WHERE id = ? AND trip_id = ? AND status = 'uploaded'",
  ).bind(c.req.param("mediaId"), trip.id).first<Pick<MediaRow, "original_key" | "thumb_key">>();
  if (!row) throw new HTTPException(404, { message: "No encontrado" });

  const key = c.req.param("variant") === "thumb" ? row.thumb_key : row.original_key;
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

/** Borrar una foto propia, solo antes del revelado. */
media.delete("/media/:mediaId", requireMember, async (c) => {
  const me = c.get("member");
  const trip = c.get("trip");
  if (isRevealed(trip)) throw new HTTPException(409, { message: "El rollo ya se reveló" });

  const row = await c.env.DB.prepare("SELECT * FROM media WHERE id = ? AND member_id = ?")
    .bind(c.req.param("mediaId"), me.id)
    .first<MediaRow>();
  if (!row) throw new HTTPException(404, { message: "No encontrado" });

  await c.env.MEDIA.delete([row.original_key, row.thumb_key]);
  await c.env.DB.prepare("DELETE FROM media WHERE id = ?").bind(row.id).run();
  return c.body(null, 204);
});

export default media;
