import type { ObjectStorage } from "../ports/storage";
import { unavailable } from "../shared/errors";
import type { Deps } from "../container";
import { sendStorageAlert } from "./email";

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

async function getState(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM cron_state WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

const setState = (db: D1Database, key: string, value: string) =>
  db.prepare("INSERT INTO cron_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value);

/**
 * Estimated bytes in the bucket: the larger of the D1 estimate (declared sizes of every non-deleted media row, pending
 * ones included since they reserve space, plus the avatar allowance) and the last real measurement made by the cron.
 */
export async function storageUsage(db: D1Database): Promise<number> {
  const [estimate, measured] = await Promise.all([
    db.batch<{ bytes: number }>([
      db.prepare("SELECT COALESCE(SUM(size_bytes + COALESCE(thumb_size_bytes, 0)), 0) AS bytes FROM media WHERE deleted_at IS NULL"),
      db.prepare("SELECT COUNT(*) * ? AS bytes FROM users WHERE avatar_key IS NOT NULL").bind(AVATAR_ALLOWANCE_BYTES),
    ]),
    getState(db, MEASURED_BYTES_KEY),
  ]);
  const estimated = estimate.reduce((sum, r) => sum + (r.results[0]?.bytes ?? 0), 0);
  return Math.max(estimated, Number(measured ?? 0) || 0);
}

/** Throws 503 when a new upload of `extraBytes` would pass the block threshold. Reads are never blocked. */
export async function assertStorageAvailable(deps: Pick<Deps, "db" | "config">, extraBytes: number): Promise<void> {
  const used = await storageUsage(deps.db);
  if (used + extraBytes > deps.config.storageLimitBytes * BLOCK_RATIO) {
    throw unavailable("Rollo llegó al límite de espacio por ahora. Avisale a Juani.");
  }
}

/** Sums the size of every object in the storage. */
async function measureBucket(storage: ObjectStorage): Promise<number> {
  let total = 0;
  let cursor: string | null = null;
  do {
    const page: Awaited<ReturnType<ObjectStorage["list"]>> = await storage.list({ limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const o of page.objects) total += o.size;
    cursor = page.cursor;
  } while (cursor);
  return total;
}

/**
 * Cron: measures the real bucket size at most once per hour (`cron_state`), then emails an alert the first time usage
 * crosses 70%, 85% or 95% of the limit. The highest threshold already alerted is remembered and forgotten when usage
 * drops under 70%, so a later crossing alerts again.
 */
export async function checkStorage(deps: Pick<Deps, "db" | "storage" | "mailer" | "config">, now = Date.now()): Promise<void> {
  const { db } = deps;
  const measuredAt = Number((await getState(db, MEASURED_AT_KEY)) ?? 0);
  if (now - measuredAt >= MEASURE_EVERY_MS) {
    const total = await measureBucket(deps.storage);
    await db.batch([setState(db, MEASURED_BYTES_KEY, String(total)), setState(db, MEASURED_AT_KEY, String(now))]);
  }

  const used = await storageUsage(db);
  const limit = deps.config.storageLimitBytes;
  const crossed = ALERT_THRESHOLDS.filter((t) => used >= (limit * t) / 100).at(-1);
  const alerted = Number((await getState(db, ALERTED_KEY)) ?? 0);

  if (crossed === undefined) {
    if (alerted) await db.prepare("DELETE FROM cron_state WHERE key = ?").bind(ALERTED_KEY).run();
    return;
  }
  if (crossed > alerted) {
    await sendStorageAlert(deps, { usedBytes: used, limitBytes: limit, threshold: crossed });
    await setState(db, ALERTED_KEY, String(crossed)).run();
  }
}
