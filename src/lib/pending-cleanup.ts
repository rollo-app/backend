import type { Env } from "../types";

const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const BATCH = 100;

/**
 * Cron: deletes media that was registered but never confirmed for over 7 days, with their R2 objects
 * (deleting a missing key is fine). Dependent rows (likes, featured, reports) go away by ON DELETE CASCADE.
 * Works in bounded batches; the rest is picked up by the next runs.
 */
export async function cleanupStalePending(env: Pick<Env, "DB" | "MEDIA">, now = Date.now()): Promise<void> {
  const { results } = await env.DB
    .prepare("SELECT id, original_key, thumb_key FROM media WHERE status = 'pending' AND created_at < ? ORDER BY created_at LIMIT ?")
    .bind(now - STALE_AFTER_MS, BATCH)
    .all<{ id: string; original_key: string; thumb_key: string }>();
  if (!results.length) return;

  await env.MEDIA.delete(results.flatMap((r) => [r.original_key, r.thumb_key]));
  await env.DB.batch(
    results.map((r) => env.DB.prepare("DELETE FROM media WHERE id = ? AND status = 'pending'").bind(r.id)),
  );
}
