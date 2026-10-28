import type { Env } from "../types";

const MAX_KEYS = 1000;
/** A presigned PUT lives 15 min: wait longer than that so an upload that lands after the delete is purged too. */
export const PURGE_GRACE_MS = 60 * 60_000;

/**
 * Cron: deletes from R2 the files of deleted rollos (queued in `r2_purge` when the rollo was deleted).
 * Only keys queued over `PURGE_GRACE_MS` ago. Up to 1000 keys per run, one R2 delete call; their rows go away only after R2 accepted the delete,
 * so a failed run retries the same keys next time. Deleting a missing key in R2 is a no-op.
 */
export async function purgeDeletedFiles(env: Pick<Env, "DB" | "MEDIA">, now = Date.now()): Promise<void> {
  const { results } = await env.DB.prepare("SELECT key FROM r2_purge WHERE created_at < ? ORDER BY created_at, key LIMIT ?").bind(now - PURGE_GRACE_MS, MAX_KEYS).all<{ key: string }>();
  if (results.length === 0) return;
  const keys = results.map((r) => r.key);
  await env.MEDIA.delete(keys);
  // D1 allows 100 bound parameters per statement.
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    stmts.push(env.DB.prepare(`DELETE FROM r2_purge WHERE key IN (${chunk.map(() => "?").join(",")})`).bind(...chunk));
  }
  await env.DB.batch(stmts);
}
