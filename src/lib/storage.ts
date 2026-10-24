import { unavailable } from "../shared/errors";
import type { Env } from "../types";
import { sendStorageAlert } from "./email";

/** R2's free tier is 10 GB (decimal, to stay on the safe side). */
export const DEFAULT_STORAGE_LIMIT_BYTES = 10_000_000_000;
/** New uploads are refused from this share of the limit. */
export const BLOCK_RATIO = 0.95;
/** Shares of the limit that trigger an alert email, ascending. */
export const ALERT_THRESHOLDS = [70, 85, 95] as const;
/** Max avatar size (see `AvatarUploadRequestSchema`), reserved for every user with an avatar. */
const AVATAR_ALLOWANCE_BYTES = 2 * 1024 * 1024;
const MEASURE_EVERY_MS = 60 * 60 * 1000;

const MEASURED_BYTES_KEY = "storage_measured_bytes";
const MEASURED_AT_KEY = "storage_measured_at";
const ALERTED_KEY = "storage_alerted_threshold";

export function storageLimitBytes(env: Pick<Env, "STORAGE_LIMIT_BYTES">): number {
  const n = Number(env.STORAGE_LIMIT_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STORAGE_LIMIT_BYTES;
}

async function getState(env: Pick<Env, "DB">, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM cron_state WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

const setState = (env: Pick<Env, "DB">, key: string, value: string) =>
  env.DB.prepare("INSERT INTO cron_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value);

/**
 * Estimated bytes in the bucket: the larger of the D1 estimate (declared sizes of every non-deleted media row, pending
 * ones included since they reserve space, plus the avatar allowance) and the last real measurement made by the cron.
 */
export async function storageUsage(env: Pick<Env, "DB">): Promise<number> {
  const [estimate, measured] = await Promise.all([
    env.DB.batch<{ bytes: number }>([
      env.DB.prepare("SELECT COALESCE(SUM(size_bytes + COALESCE(thumb_size_bytes, 0)), 0) AS bytes FROM media WHERE deleted_at IS NULL"),
      env.DB.prepare("SELECT COUNT(*) * ? AS bytes FROM users WHERE avatar_key IS NOT NULL").bind(AVATAR_ALLOWANCE_BYTES),
    ]),
    getState(env, MEASURED_BYTES_KEY),
  ]);
  const estimated = estimate.reduce((sum, r) => sum + (r.results[0]?.bytes ?? 0), 0);
  return Math.max(estimated, Number(measured ?? 0) || 0);
}

/** Throws 503 when a new upload of `extraBytes` would pass the block threshold. Reads are never blocked. */
export async function assertStorageAvailable(env: Pick<Env, "DB" | "STORAGE_LIMIT_BYTES">, extraBytes: number): Promise<void> {
  const used = await storageUsage(env);
  if (used + extraBytes > storageLimitBytes(env) * BLOCK_RATIO) {
    throw unavailable("Rollo llegó al límite de espacio por ahora. Avisale a Juani.");
  }
}

/** Sums the size of every object in the bucket. */
async function measureBucket(bucket: R2Bucket): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const o of page.objects) total += o.size;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return total;
}

/**
 * Cron: measures the real bucket size at most once per hour (`cron_state`), then emails an alert the first time usage
 * crosses 70%, 85% or 95% of the limit. The highest threshold already alerted is remembered and forgotten when usage
 * drops under 70%, so a later crossing alerts again.
 */
export async function checkStorage(env: Env, now = Date.now()): Promise<void> {
  const measuredAt = Number((await getState(env, MEASURED_AT_KEY)) ?? 0);
  if (now - measuredAt >= MEASURE_EVERY_MS) {
    const total = await measureBucket(env.MEDIA);
    await env.DB.batch([setState(env, MEASURED_BYTES_KEY, String(total)), setState(env, MEASURED_AT_KEY, String(now))]);
  }

  const used = await storageUsage(env);
  const limit = storageLimitBytes(env);
  const crossed = ALERT_THRESHOLDS.filter((t) => used >= (limit * t) / 100).at(-1);
  const alerted = Number((await getState(env, ALERTED_KEY)) ?? 0);

  if (crossed === undefined) {
    if (alerted) await env.DB.prepare("DELETE FROM cron_state WHERE key = ?").bind(ALERTED_KEY).run();
    return;
  }
  if (crossed > alerted) {
    await sendStorageAlert(env, { usedBytes: used, limitBytes: limit, threshold: crossed });
    await setState(env, ALERTED_KEY, String(crossed)).run();
  }
}
