import type { Deps } from "../container";

const MIN_AGE_MS = 60 * 60 * 1000;
const PAGE = 500;
const MAX_OBJECTS = 1000;

const D1_MAX_PARAMS = 100;
const STATE_KEY = "avatar_sweep_after";

/**
 * Cron: deletes avatar files in the storage that no user references (neither `avatar_key` nor `pending_avatar_key`) and that were
 * uploaded over 1 hour ago, so an upload that is about to be completed is never touched. These appear when a presigned
 * URL is reused after `complete` consumed the pending file. Looks at up to `maxObjects` objects (rounded up to whole pages) per run and remembers the
 * last key it saw (`cron_state`), so the next run resumes after it; when the listing reaches the end the position is
 * cleared and the next run starts over. Orphans are cleaned as they are found and the referenced ones stay.
 * D1 queries per page: the referenced keys of the users whose prefixes show up in it, in chunks of 100 ids (D1's
 * bound-parameter limit).
 */
export async function sweepOrphanAvatars(
  deps: Pick<Deps, "db" | "storage">,
  now = Date.now(),
  { maxObjects = MAX_OBJECTS, pageSize = PAGE } = {},
): Promise<void> {
  const state = await deps.db.prepare("SELECT value FROM cron_state WHERE key = ?").bind(STATE_KEY).first<{ value: string }>();
  let startAfter = state?.value;
  let cursor: string | null = null;
  let lastKey: string | undefined;
  let seen = 0;
  let more = false;
  do {
    const page: Awaited<ReturnType<Deps["storage"]["list"]>> = await deps.storage.list({
      prefix: "avatars/",
      limit: pageSize,
      ...(cursor ? { cursor } : { startAfter }),
    });
    seen += page.objects.length;
    cursor = page.cursor;
    more = page.cursor !== null;
    if (page.objects.length) lastKey = page.objects.at(-1)!.key;

    const old = page.objects.filter((o) => now - o.uploaded.getTime() > MIN_AGE_MS);
    if (!old.length) continue;

    const userIds = [...new Set(old.map((o) => o.key.split("/")[1]))];
    const referenced = new Set<string | null>();
    for (let i = 0; i < userIds.length; i += D1_MAX_PARAMS) {
      const chunk = userIds.slice(i, i + D1_MAX_PARAMS);
      const { results } = await deps.db
        .prepare(`SELECT avatar_key, pending_avatar_key FROM users WHERE id IN (${chunk.map(() => "?").join(",")})`)
        .bind(...chunk)
        .all<{ avatar_key: string | null; pending_avatar_key: string | null }>();
      for (const r of results) referenced.add(r.avatar_key).add(r.pending_avatar_key);
    }

    const orphans = old.map((o) => o.key).filter((k) => !referenced.has(k));
    if (orphans.length) await deps.storage.delete(orphans);
  } while (cursor && seen < maxObjects);

  if (more && lastKey) {
    await deps.db
      .prepare("INSERT INTO cron_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(STATE_KEY, lastKey)
      .run();
  } else {
    await deps.db.prepare("DELETE FROM cron_state WHERE key = ?").bind(STATE_KEY).run();
  }
}
