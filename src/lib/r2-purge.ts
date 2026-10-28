import type { Env } from "../types";

const MAX_KEYS = 1000;

/**
 * Cron: deletes from R2 the files of deleted rollos (queued in `r2_purge` when the rollo was deleted).
 * Up to 1000 keys per run, one R2 delete call; their rows go away only after R2 accepted the delete,
 * so a failed run retries the same keys next time. Deleting a missing key in R2 is a no-op.
 */
export async function purgeDeletedFiles(env: Pick<Env, "DB" | "MEDIA">, _now = Date.now()): Promise<void> {
  const { results } = await env.DB.prepare("SELECT key FROM r2_purge ORDER BY created_at, key LIMIT ?").bind(MAX_KEYS).all<{ key: string }>();
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
