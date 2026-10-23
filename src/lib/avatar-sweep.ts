import type { Env } from "../types";

const MIN_AGE_MS = 60 * 60 * 1000;
const PAGE = 500;
const MAX_OBJECTS = 1000;

/**
 * Cron: deletes avatar files in R2 that no user references (neither `avatar_key` nor `pending_avatar_key`) and that were
 * uploaded over 1 hour ago, so an upload that is about to be completed is never touched. These appear when a presigned
 * URL is reused after `complete` consumed the pending file. Looks at up to 1000 objects per run (R2 lists by key, so
 * a run starts over from the beginning; orphans are cleaned as they are found and the referenced ones stay).
 * One D1 query per page: the referenced keys of the users whose prefixes show up in it.
 */
export async function sweepOrphanAvatars(env: Pick<Env, "DB" | "MEDIA">, now = Date.now()): Promise<void> {
  let cursor: string | undefined;
  let seen = 0;
  do {
    const page = await env.MEDIA.list({ prefix: "avatars/", cursor, limit: PAGE });
    seen += page.objects.length;
    cursor = page.truncated ? page.cursor : undefined;

    const old = page.objects.filter((o) => now - o.uploaded.getTime() > MIN_AGE_MS);
    if (!old.length) continue;

    const userIds = [...new Set(old.map((o) => o.key.split("/")[1]))];
    const { results } = await env.DB
      .prepare(
        `SELECT avatar_key, pending_avatar_key FROM users WHERE id IN (${userIds.map(() => "?").join(",")})`,
      )
      .bind(...userIds)
      .all<{ avatar_key: string | null; pending_avatar_key: string | null }>();
    const referenced = new Set(results.flatMap((r) => [r.avatar_key, r.pending_avatar_key]));

    const orphans = old.map((o) => o.key).filter((k) => !referenced.has(k));
    if (orphans.length) await env.MEDIA.delete(orphans);
  } while (cursor && seen < MAX_OBJECTS);
}
