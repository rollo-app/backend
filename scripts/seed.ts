import sharp from "sharp";
import { rgbaToThumbHash } from "thumbhash";

/**
 * Viaje de prueba con fotos reales contra el server local: `npm run seed`.
 * Necesita `npm run dev` corriendo con DEV_LOCAL_UPLOADS=1 en `.dev.vars`
 * (si no, las URLs de subida apuntan al R2 real).
 */

const API = process.env.SEED_API_URL ?? "http://localhost:8787";
const TZ = "America/Argentina/Buenos_Aires";
const TZ_OFFSET_H = -3; // Argentina no tiene horario de verano
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PHOTO_LIMIT = 10;

const PEOPLE = ["Cami", "Tomi", "Fede"];

const PLACES = [
  { lat: -49.3315, lng: -72.8863 }, // El Chaltén
  { lat: -49.2714, lng: -73.0431 }, // Fitz Roy
  { lat: -49.2721, lng: -73.0045 }, // Laguna de los Tres
  { lat: -49.2937, lng: -72.959 }, // Laguna Capri
  { lat: -49.327, lng: -73.096 }, // Laguna Torre
];

const CAPTIONS = [
  "no puedo creer este viento",
  "el Fitz se dejó ver, ni una nube",
  "última subida, me muero",
  "mate con vista, no se negocia",
  "Tomi se comió tres alfajores antes de las 10",
  "la laguna está más celeste que en las fotos",
  "acá nos perdimos (un poco)",
  "cerveza artesanal en el pueblo, merecida",
  "amanecer rojo, valió el despertador",
  "las piernas ya no responden",
  "guanaco a dos metros, ni se inmutó",
  "picada de campeones",
  "nadie me avisó que hacía tanto frío",
  "el glaciar cruje y da miedo",
  "selfie grupal fallida número 4",
];

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

async function api<T = any>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body !== undefined && { "content-type": "application/json" }),
      ...(token && { authorization: `Bearer ${token}` }),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data as T;
}

/** Medianoche local (zona del viaje) del día `daysAgo` atrás, en epoch ms. */
function localMidnight(daysAgo: number): number {
  const local = new Date(Date.now() + TZ_OFFSET_H * HOUR);
  local.setUTCHours(0, 0, 0, 0);
  return local.getTime() - TZ_OFFSET_H * HOUR - daysAgo * DAY;
}

async function makeImages(seed: number) {
  const res = await fetch(`https://picsum.photos/seed/rollo-${seed}/1600/1200`);
  if (!res.ok) throw new Error(`picsum ${res.status}`);
  const original = Buffer.from(await res.arrayBuffer());
  const img = sharp(original);
  const meta = await img.metadata();
  const thumb = await img.clone().resize({ width: 800 }).jpeg({ quality: 80 }).toBuffer();
  const small = await img
    .clone()
    .resize(100, 100, { fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const hash = rgbaToThumbHash(small.info.width, small.info.height, small.data);
  return {
    original,
    thumb,
    width: meta.width!,
    height: meta.height!,
    thumbhash: Buffer.from(hash).toString("base64"),
  };
}

async function put(url: string, data: Buffer) {
  if (url.includes("r2.cloudflarestorage.com")) {
    throw new Error("Las URLs apuntan al R2 real: poné DEV_LOCAL_UPLOADS=1 en .dev.vars y reiniciá `npm run dev`.");
  }
  const res = await fetch(url, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: data });
  if (!res.ok) throw new Error(`PUT ${res.status}`);
}

type Shot = { token: string; takenAt: number };

async function upload(tripId: string, shot: Shot, seed: number) {
  const img = await makeImages(seed);
  const place = pick(PLACES);
  const id = crypto.randomUUID();
  const reg = await api<{ upload: { original: string; thumb: string } }>(
    "POST",
    `/trips/${tripId}/media`,
    {
      id,
      type: "photo",
      takenAt: shot.takenAt,
      lat: place.lat + rand(-0.005, 0.005),
      lng: place.lng + rand(-0.005, 0.005),
      accuracyM: Math.round(rand(4, 30)),
      caption: Math.random() < 0.5 ? pick(CAPTIONS) : null,
      width: img.width,
      height: img.height,
      sizeBytes: img.original.length,
      thumbhash: img.thumbhash,
    },
    shot.token,
  );
  await put(reg.upload.original, img.original);
  await put(reg.upload.thumb, img.thumb);
  await api("POST", `/media/${id}/complete`, undefined, shot.token);
}

async function main() {
  const now = Date.now();
  const created = await api("POST", "/trips", {
    name: "Sur (prueba)",
    adminName: PEOPLE[0],
    timezone: TZ,
    startsAt: localMidnight(4),
    endsAt: now + 8 * DAY,
    revealAt: now + 8 * DAY,
    dailyPhotoLimit: PHOTO_LIMIT,
  });
  const tripId: string = created.trip.id;
  const tokens = [created.token as string];
  for (const name of PEOPLE.slice(1)) tokens.push((await api("POST", "/trips/join", { code: created.trip.joinCode, name })).token);

  // 4 días pasados + hoy; entre 9 y 22 h locales, hoy solo hasta ahora.
  const shots: Shot[] = [];
  for (let daysAgo = 4; daysAgo >= 0; daysAgo--) {
    const from = localMidnight(daysAgo) + 9 * HOUR;
    const to = Math.min(localMidnight(daysAgo) + 22 * HOUR, now - 60_000);
    if (to <= from) continue;
    for (const token of tokens) {
      const n = Math.min(PHOTO_LIMIT, Math.floor(rand(5, 9)));
      for (let i = 0; i < n; i++) shots.push({ token, takenAt: Math.round(rand(from, to)) });
    }
  }

  console.log(`Subiendo ${shots.length} fotos a ${API}...`);
  let done = 0;
  const queue = shots.map((shot, i) => () => upload(tripId, shot, i + Math.floor(now / 1000)));
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        await job();
        if (++done % 10 === 0) console.log(`  ${done}/${shots.length}`);
      }
    }),
  );

  console.log(`\nListo: "${created.trip.name}" con ${done} fotos de ${PEOPLE.join(", ")}.`);
  console.log(`Código para sumarte desde el iPhone: ${created.trip.joinCode}`);
  console.log(`Token de admin (${PEOPLE[0]}), por si querés revelar con curl: ${created.token}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
