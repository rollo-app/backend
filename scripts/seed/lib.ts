import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import { rgbaToThumbHash } from "thumbhash";

/** Helpers del seed: API, D1 local, imágenes (con cache en disco), horarios y cupo. */

export const API = process.env.SEED_API_URL ?? "http://localhost:8787";
export const TZ = "America/Argentina/Buenos_Aires";
const TZ_OFFSET_H = -3; // Argentina no tiene horario de verano
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export const rand = (min: number, max: number) => min + Math.random() * (max - min);
export const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]!;
export const jitter = (v: number, d: number) => v + rand(-d, d);

// ---------- API ----------

export async function api<T = any>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
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

// ---------- D1 local (vía wrangler) ----------

export function d1<T = any>(sql: string): T[] {
  const out = execFileSync("./node_modules/.bin/wrangler", ["d1", "execute", "rollo", "--local", "--json", "--command", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 50 * 1024 * 1024,
  });
  const parsed = JSON.parse(out);
  return (parsed[0]?.results ?? []) as T[];
}

// ---------- Fechas (zona del viaje: Buenos Aires) ----------

/** Medianoche local del día `daysAgo` atrás (negativo = en el futuro), en epoch ms. */
export function localMidnight(daysAgo: number): number {
  const local = new Date(Date.now() + TZ_OFFSET_H * HOUR);
  local.setUTCHours(0, 0, 0, 0);
  return local.getTime() - TZ_OFFSET_H * HOUR - daysAgo * DAY;
}

/** Medianoche local de una fecha fija (mes 1-12). */
export const fixedMidnight = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) - TZ_OFFSET_H * HOUR;

export const localDate = (t: number) => new Date(t + TZ_OFFSET_H * HOUR).toISOString().slice(0, 10);

/** Hora al azar entre las 8 y las 22 h locales de ese día (hoy, solo hasta ahora). null si no hay ventana. */
export function randomTime(midnight: number): number | null {
  const from = midnight + 8 * HOUR;
  const to = Math.min(midnight + 22 * HOUR, Date.now() - 60_000);
  return to - from < 5 * 60_000 ? null : Math.round(rand(from, to));
}

// ---------- Plan de fotos ----------

export type Shot = {
  member: number; // índice en la lista de miembros del escenario
  type: "photo" | "video";
  takenAt: number;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  caption: string | null;
};

export type Spot = { lat: number; lng: number } | null;
/** Lugar fijo, o función del índice de día en que terminó cayendo la toma (para recorridos). */
export type SpotArg = Spot | ((dayIdx: number) => Spot);

/** Arma las tomas respetando el cupo diario por persona y tipo (si un día no da, prueba los otros). */
export class Planner {
  shots: Shot[] = [];
  private used = new Map<string, number>();
  constructor(private days: number[], private photoLimit = 10, private videoLimit = 3) {}

  /** Agrega una toma preferentemente el día `dayIdx`; si no hay cupo u hora, prueba los demás. */
  add(member: number, dayIdx: number, type: "photo" | "video", spotArg: SpotArg, caption: string | null): boolean {
    const limit = type === "photo" ? this.photoLimit : this.videoLimit;
    for (let k = 0; k < this.days.length; k++) {
      const idx = (dayIdx + k) % this.days.length;
      const takenAt = randomTime(this.days[idx]!);
      if (takenAt === null) continue;
      const key = `${member}|${localDate(takenAt)}|${type}`;
      if ((this.used.get(key) ?? 0) >= limit) continue;
      this.used.set(key, (this.used.get(key) ?? 0) + 1);
      const spot = typeof spotArg === "function" ? spotArg(idx) : spotArg;
      this.shots.push({
        member,
        type,
        takenAt,
        lat: spot ? spot.lat : null,
        lng: spot ? spot.lng : null,
        accuracyM: spot ? Math.round(rand(4, 30)) : null,
        caption,
      });
      return true;
    }
    return false;
  }
}

// ---------- Imágenes ----------

const CACHE_DIR = ".wrangler/seed-cache";
export const POOL_SIZE = 80;
type Img = { original: Buffer; thumb: Buffer; width: number; height: number; thumbhash: string };
const imgCache = new Map<string, Promise<Img>>();

/** Baja (o lee del cache en disco) la imagen del pool `n` y arma thumb de 800 px + thumbhash. */
export function getImage(n: number): Promise<Img> {
  const seed = `rollo-pool-${n % POOL_SIZE}`;
  let p = imgCache.get(seed);
  if (!p) {
    p = (async () => {
      const file = `${CACHE_DIR}/${seed}.jpg`;
      let original: Buffer;
      if (existsSync(file)) original = readFileSync(file);
      else {
        const res = await fetch(`https://picsum.photos/seed/${seed}/1600/1200`);
        if (!res.ok) throw new Error(`picsum ${res.status}`);
        original = Buffer.from(await res.arrayBuffer());
        mkdirSync(CACHE_DIR, { recursive: true });
        writeFileSync(file, original);
      }
      const img = sharp(original);
      const meta = await img.metadata();
      const thumb = await img.clone().resize({ width: 800 }).jpeg({ quality: 80 }).toBuffer();
      const small = await img.clone().resize(100, 100, { fit: "inside" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const hash = rgbaToThumbHash(small.info.width, small.info.height, small.data);
      return { original, thumb, width: meta.width!, height: meta.height!, thumbhash: Buffer.from(hash).toString("base64") };
    })();
    imgCache.set(seed, p);
  }
  return p;
}

async function put(url: string, data: Buffer, contentType: string) {
  if (url.includes("r2.cloudflarestorage.com")) {
    throw new Error("Las URLs apuntan al R2 real: poné DEV_LOCAL_UPLOADS=1 en .dev.vars y reiniciá `npm run dev`.");
  }
  const res = await fetch(url, { method: "PUT", headers: { "content-type": contentType }, body: data });
  if (!res.ok) throw new Error(`PUT ${res.status}`);
}

/**
 * Registra, sube y confirma una toma.
 * VIDEOS: no hay ffmpeg, así que el "original" es un placeholder (los bytes del jpeg) subido como video/mp4;
 * el thumb y el thumbhash salen de una imagen de picsum. Sirven para probar el flujo, no para reproducir.
 */
export async function uploadShot(tripId: string, token: string, shot: Shot, imgIdx: number) {
  const img = await getImage(imgIdx);
  const id = crypto.randomUUID();
  const isVideo = shot.type === "video";
  const reg = await api<{ upload: { original: string; thumb: string } }>(
    "POST",
    `/trips/${tripId}/media`,
    {
      id,
      type: shot.type,
      takenAt: shot.takenAt,
      lat: shot.lat,
      lng: shot.lng,
      accuracyM: shot.accuracyM,
      caption: shot.caption,
      width: img.width,
      height: img.height,
      sizeBytes: img.original.length,
      thumbhash: img.thumbhash,
      ...(isVideo && { durationS: Math.round(rand(3, 14.5) * 10) / 10 }),
    },
    token,
  );
  await put(reg.upload.original, img.original, isVideo ? "video/mp4" : "image/jpeg");
  await put(reg.upload.thumb, img.thumb, "image/jpeg");
  await api("POST", `/media/${id}/complete`, undefined, token);
  return id;
}

/** Corre las tareas con `n` workers en paralelo. */
export async function pool<T>(jobs: (() => Promise<T>)[], n = 6, onProgress?: (done: number) => void): Promise<T[]> {
  const queue = jobs.map((job, i) => ({ job, i }));
  const results: T[] = new Array(jobs.length);
  let done = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (let it = queue.shift(); it; it = queue.shift()) {
        results[it.i] = await it.job();
        onProgress?.(++done);
      }
    }),
  );
  return results;
}
