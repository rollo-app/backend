import type { Env } from "../types";

const MIN_AGE_MS = 60 * 60 * 1000;
const TRIPS_PER_RUN = 50;
const REVEALED_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const STATE_KEY = "cover_sweep_after";

/**
 * Cron: deletes event cover files in R2 (`trips/{tripId}/cover/*`) that are neither the trip's `cover_key` nor its
 * `pending_cover_key` and were uploaded over 1 hour ago, so an upload that is about to be completed is never touched.
 * They appear from abandoned pending uploads, a presigned URL reused after `complete`, or concurrent completes.
 * Covers only exist under events, so it walks the event trips (ordered by id, `TRIPS_PER_RUN` per run) instead of
 * listing every media object, and only those not revealed or revealed less than 7 days ago (the cover is frozen after the
 * reveal: `cover.service.ts` refuses uploads then), to keep R2 list operations low. The cron calls it once an hour (`scheduled`); the last trip id it saw is kept in `cron_state` so the next run resumes after it, and the
 * position is cleared once the walk reaches the end.
 */
export async function sweepOrphanCovers(
  env: Pick<Env, "DB" | "MEDIA">,
  now = Date.now(),
  { tripsPerRun = TRIPS_PER_RUN } = {},
): Promise<void> {
  const state = await env.DB.prepare("SELECT value FROM cron_state WHERE key = ?").bind(STATE_KEY).first<{ value: string }>();
  const { results: trips } = await env.DB
    .prepare("SELECT id, cover_key, pending_cover_key FROM trips WHERE type = 'event' AND id > ? AND COALESCE(revealed_at, reveal_at) > ? ORDER BY id LIMIT ?")
    .bind(state?.value ?? "", now - REVEALED_GRACE_MS, tripsPerRun)
    .all<{ id: string; cover_key: string | null; pending_cover_key: string | null }>();

  for (const t of trips) {
    let cursor: string | undefined;
    do {
      const page = await env.MEDIA.list({ prefix: `trips/${t.id}/cover/`, ...(cursor ? { cursor } : {}) });
      cursor = page.truncated ? page.cursor : undefined;
      const orphans = page.objects
        .filter((o) => now - o.uploaded.getTime() > MIN_AGE_MS && o.key !== t.cover_key && o.key !== t.pending_cover_key)
        .map((o) => o.key);
      if (orphans.length) await env.MEDIA.delete(orphans);
    } while (cursor);
  }

  if (trips.length === tripsPerRun) {
    await env.DB
      .prepare("INSERT INTO cron_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(STATE_KEY, trips.at(-1)!.id)
      .run();
  } else {
    await env.DB.prepare("DELETE FROM cron_state WHERE key = ?").bind(STATE_KEY).run();
  }
}
