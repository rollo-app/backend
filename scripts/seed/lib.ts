import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import { rgbaToThumbHash } from "thumbhash";
import { NO_AVATAR, renderAvatar } from "./avatars";
import { NO_USERNAME, PUBLIC_PROFILES, SEED_BADGES, SEED_BIOS } from "./people";

/** Seed helpers: API, local D1, images (disk-cached), times and daily quota. */

export const API = process.env.SEED_API_URL ?? "http://localhost:8787";
export const TZ = "America/Argentina/Buenos_Aires";
const TZ_OFFSET_H = -3; // Argentina has no daylight saving time
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export const rand = (min: number, max: number) => min + Math.random() * (max - min);
export const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]!;
export const jitter = (v: number, d: number) => v + rand(-d, d);

// ---------- API ----------

export async function api<T = any>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const init = {
    method,
    headers: {
      ...(body !== undefined && { "content-type": "application/json" }),
      ...(token && { authorization: `Bearer ${token}` }),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
  // The local rate limits (src/lib/rate-limit.ts) are real: on a 429 wait (Retry-After, else ~12 s) and retry, a bounded number of times.
  const MAX_ATTEMPTS = 8;
  for (let attempt = 1; ; attempt++) {
    // The synchronous wrangler calls can leave a keep-alive socket stale: retry once on a network error.
    const res = await fetch(`${API}${path}`, init).catch(() => fetch(`${API}${path}`, init));
    const data = await res.json().catch(() => null);
    if (res.status === 429 && attempt < MAX_ATTEMPTS) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 12_000;
      console.log(`  429 on ${method} ${path}: waiting ${Math.round(waitMs / 1000)} s (attempt ${attempt}/${MAX_ATTEMPTS})`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
    return data as T;
  }
}

// ---------- Local D1 (via wrangler) ----------

/** `SEED_PERSIST_TO=<dir>` runs against an isolated local state (same dir as `wrangler dev --persist-to`). */
export function d1<T = any>(sql: string): T[] {
  const persist = process.env.SEED_PERSIST_TO ? ["--persist-to", process.env.SEED_PERSIST_TO] : [];
  const out = execFileSync("./node_modules/.bin/wrangler", ["d1", "execute", "rollo", "--local", ...persist, "--json", "--command", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 50 * 1024 * 1024,
  });
  const parsed = JSON.parse(out);
  return (parsed[0]?.results ?? []) as T[];
}

// ---------- Seed users (created directly in D1, with a session each) ----------

const SESSION_TTL = 365 * DAY;
const sqlStr = (v: string) => `'${v.replace(/'/g, "''")}'`;
export const slug = (name: string) =>
  name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ".");
/** Seed username: "juanifraga" for Juani, otherwise the dotted slug of the name (e.g. "maria.florencia"). */
export const seedUsername = (name: string) => (name === "Juani" ? "juanifraga" : slug(name));
export const seedEmail = (name: string) => `${slug(name)}@rollo.test`;
const sessions = new Map<string, Promise<string>>();

/**
 * Returns a session token for the seed user with that display name. Creates the user if the email doesn't
 * exist (otherwise reuses it and refreshes its name) and inserts a fresh session. Cached per run.
 */
export function ensureUser(name: string): Promise<string> {
  let p = sessions.get(name);
  if (!p) {
    p = (async () => {
      const email = seedEmail(name);
      const now = Date.now();
      const [existing] = d1<{ id: string }>(`SELECT id FROM users WHERE email = ${sqlStr(email)}`);
      let userId = existing?.id;
      const username = NO_USERNAME.has(name) ? "NULL" : sqlStr(seedUsername(name));
      if (userId) d1(`UPDATE users SET name = ${sqlStr(name)}, username = ${username} WHERE id = ${sqlStr(userId)}`);
      else {
        userId = randomUUID();
        d1(`INSERT INTO users (id, email, name, username, created_at) VALUES (${sqlStr(userId)}, ${sqlStr(email)}, ${sqlStr(name)}, ${username}, ${now})`);
      }
      const badge = SEED_BADGES[name];
      d1(`UPDATE users SET badge = ${badge ? sqlStr(badge) : "NULL"} WHERE id = ${sqlStr(userId)}`);
      const token = randomBytes(32).toString("base64url");
      const hash = createHash("sha256").update(token).digest("hex");
      d1(
        `INSERT INTO sessions (id, user_id, token_hash, created_at, last_used_at, expires_at) VALUES (${sqlStr(randomUUID())}, ${sqlStr(userId)}, ${sqlStr(hash)}, ${now}, ${now}, ${now + SESSION_TTL})`,
      );
      if (!NO_AVATAR.has(name)) await uploadAvatar(name, token);
      // Through the API, so the bios go through the same validation as the app's. "" clears a bio from an earlier run.
      // Visibility is reset too, in case it was toggled while testing on the phone.
      await api("PATCH", "/me", { bio: SEED_BIOS[name] ?? "", profileVisibility: PUBLIC_PROFILES.has(name) ? "public" : "friends" }, token);
      return token;
    })();
    sessions.set(name, p);
  }
  return p;
}

/** Real avatar flow: POST /me/avatar → PUT the JPEG → POST /me/avatar/complete (the API deletes the previous avatar). */
async function uploadAvatar(name: string, token: string) {
  const jpeg = await renderAvatar(name, avatarIndex(name));
  const { upload } = await api<{ upload: string }>("POST", "/me/avatar", { sizeBytes: jpeg.length }, token);
  await put(upload, jpeg, "image/jpeg");
  await api("POST", "/me/avatar/complete", undefined, token);
}
const avatarNames: string[] = [];
const avatarIndex = (name: string) => {
  if (!avatarNames.includes(name)) avatarNames.push(name);
  return avatarNames.indexOf(name);
};

/** User id of a seed user (by display name), or undefined if it doesn't exist yet. */
export const seedUserId = (name: string) => d1<{ id: string }>(`SELECT id FROM users WHERE email = ${sqlStr(seedEmail(name))}`)[0]?.id;

function seedPair(nameA: string, nameB: string): [string, string] {
  const [a, b] = [seedUserId(nameA), seedUserId(nameB)];
  if (!a || !b) throw new Error(`Seed users not found: ${nameA}, ${nameB}`);
  return a < b ? [a, b] : [b, a];
}

/** Makes two seed users friends straight in D1 (idempotent). Both must already exist (see `ensureUser`). */
export function befriendSeed(nameA: string, nameB: string) {
  const [lo, hi] = seedPair(nameA, nameB);
  d1(`INSERT OR IGNORE INTO friendships (user_a, user_b, created_at) VALUES (${sqlStr(lo)}, ${sqlStr(hi)}, ${Date.now()})`);
}

/** Undoes a friendship made while testing (so a friend link can be redeemed again on the next run). */
export function unfriendSeed(nameA: string, nameB: string) {
  const [lo, hi] = seedPair(nameA, nameB);
  d1(`DELETE FROM friendships WHERE user_a = ${sqlStr(lo)} AND user_b = ${sqlStr(hi)}`);
}

/** Removes every friendship of a seed user (to keep an "empty" account empty across runs). */
export function clearFriendsSeed(name: string) {
  const id = seedUserId(name);
  if (id) d1(`DELETE FROM friendships WHERE user_a = ${sqlStr(id)} OR user_b = ${sqlStr(id)}`);
}

/** Deletes the seed users (`@rollo.test`) with their memberships, media, featured photos, friendships, friend links, claims, attempts, sessions and login codes (bios go with the users). */
export function resetUsers() {
  const users = `SELECT id FROM users WHERE email LIKE '%@rollo.test'`;
  const members = `SELECT id FROM members WHERE user_id IN (${users})`;
  d1(`DELETE FROM featured WHERE user_id IN (${users}) OR media_id IN (SELECT id FROM media WHERE member_id IN (${members}))`);
  d1(`DELETE FROM media WHERE member_id IN (${members})`);
  d1(`DELETE FROM members WHERE user_id IN (${users})`);
  d1(`DELETE FROM friendships WHERE user_a IN (${users}) OR user_b IN (${users})`);
  d1(`DELETE FROM friend_links WHERE user_id IN (${users})`);
  d1(`DELETE FROM friend_claims WHERE link_user_id IN (${users})`);
  d1(`DELETE FROM friend_attempts WHERE key IN (SELECT 'user:' || id FROM users WHERE email LIKE '%@rollo.test')`);
  d1(`DELETE FROM sessions WHERE user_id IN (${users})`);
  d1(`DELETE FROM auth_codes WHERE email LIKE '%@rollo.test'`);
  d1(`DELETE FROM users WHERE email LIKE '%@rollo.test'`);
}

// ---------- Dates (trip time zone: Buenos Aires) ----------

/** Local midnight of the day `daysAgo` days back (negative = in the future), in epoch ms. */
export function localMidnight(daysAgo: number): number {
  const local = new Date(Date.now() + TZ_OFFSET_H * HOUR);
  local.setUTCHours(0, 0, 0, 0);
  return local.getTime() - TZ_OFFSET_H * HOUR - daysAgo * DAY;
}

/** Local midnight of a fixed date (month 1-12). */
export const fixedMidnight = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) - TZ_OFFSET_H * HOUR;

export const localDate = (t: number) => new Date(t + TZ_OFFSET_H * HOUR).toISOString().slice(0, 10);

/** Random time between 08:00 and 22:00 local on that day (today: only up to now). null if there is no window. */
export function randomTime(midnight: number): number | null {
  const from = midnight + 8 * HOUR;
  const to = Math.min(midnight + 22 * HOUR, Date.now() - 60_000);
  return to - from < 5 * 60_000 ? null : Math.round(rand(from, to));
}

// ---------- Shot plan ----------

export type Shot = {
  member: number; // index into the scenario's member list
  type: "photo" | "video";
  takenAt: number;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  caption: string | null;
};

export type Spot = { lat: number; lng: number } | null;
/** Fixed spot, or a function of the day index the shot ended up on (for routes). */
export type SpotArg = Spot | ((dayIdx: number) => Spot);

/** Builds the shots respecting the daily quota per person and type (if a day doesn't fit, tries the others). */
export class Planner {
  shots: Shot[] = [];
  private used = new Map<string, number>();
  constructor(private days: number[], private photoLimit = 10, private videoLimit = 3) {}

  /** Adds a shot, preferably on day `dayIdx`; if there is no quota or time, tries the other days. */
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

// ---------- Images ----------

const CACHE_DIR = ".wrangler/seed-cache";
export const POOL_SIZE = 80;
type Img = { original: Buffer; thumb: Buffer; width: number; height: number; thumbhash: string };
const imgCache = new Map<string, Promise<Img>>();

/** Downloads (or reads from the disk cache) image `n` of the pool and builds an 800 px thumb + thumbhash. */
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
    throw new Error("URLs point at the real R2: set DEV_LOCAL_UPLOADS=1 in .dev.vars and restart `npm run dev`.");
  }
  const res = await fetch(url, { method: "PUT", headers: { "content-type": contentType }, body: data });
  if (!res.ok) throw new Error(`PUT ${res.status}`);
}

/**
 * Registers, uploads and confirms a shot.
 * VIDEOS: there is no ffmpeg, so the "original" is a placeholder (the jpeg bytes) uploaded as video/mp4;
 * the thumb and thumbhash come from a picsum image. They exercise the flow, they don't play.
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
      thumbSizeBytes: img.thumb.length,
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

/** Runs the jobs with `n` parallel workers. */
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
