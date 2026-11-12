import { sendPush, type PushMessage } from "../../lib/push";
import { ORIGINALS_TTL_MS } from "../../lib/util";
import type { Env, TripRow } from "../../types";
import * as repo from "./trips.repository";

/**
 * Original retention. Every photo is stored as original (<= 4000 px), display (2048 px, kept forever) and thumb.
 * A rollo's originals are deleted 30 days after its reveal unless `keep_originals` is set (rollos that existed before
 * the policy, and later the paid pass). Photos without a display (old app builds) and videos are never purged: the
 * original is all there is. Both jobs run from the cron (every 5 min) and are bounded and idempotent.
 */

/** The push goes out this long before the originals are deleted. */
export const ORIGINALS_NOTICE_MS = 5 * 24 * 60 * 60 * 1000;
const NOTICE_TRIPS_PER_RUN = 50;
const PURGE_TRIPS_PER_RUN = 20;
/** Originals queued per run (a few batches of D1 statements; the R2 deletes happen later in `purgeDeletedFiles`). */
const PURGE_MEDIA_PER_RUN = 1000;
/** D1 allows 100 bound parameters per statement; the purge statements bind 2 more besides the ids. */
const IDS_PER_STATEMENT = 80;

export function originalsExpiringMessage(trip: Pick<TripRow, "id" | "name">): PushMessage {
  return {
    title: `Las fotos en máxima calidad de ${trip.name} se borran en 5 días`,
    body: "Guardalas en tu celular antes de que se borren.",
    url: `/roll?trip=${trip.id}`,
  };
}

/**
 * Cron: from day 25 after the reveal, tells the active members once that the originals go in 5 days. The rollo is
 * claimed first (`originals_notice_at` set only while null, one statement), so concurrent runs send once.
 */
export async function runOriginalsNotices(env: Pick<Env, "DB">, now = Date.now()): Promise<void> {
  const db = env.DB;
  for (const trip of await repo.listTripsToNoticeOriginals(db, now, ORIGINALS_TTL_MS, ORIGINALS_NOTICE_MS, NOTICE_TRIPS_PER_RUN)) {
    if ((await repo.claimOriginalsNotice(db, trip.id, now).run()).meta.changes === 0) continue;
    await sendPush(env, await repo.listActiveMemberUserIds(db, trip.id), "originalsExpiring", originalsExpiringMessage(trip));
  }
}

/**
 * Cron: past the expiry, queues the originals of the rollo's photos that have a display in `r2_purge` (the existing
 * purge deletes them from R2 after its grace period) and marks them. Up to 1000 media per run; once a rollo has none
 * left it gets `originals_purged_at`.
 */
export async function runOriginalsPurge(env: Pick<Env, "DB">, now = Date.now()): Promise<void> {
  const db = env.DB;
  let budget = PURGE_MEDIA_PER_RUN;
  for (const trip of await repo.listTripsToPurgeOriginals(db, now, ORIGINALS_TTL_MS, PURGE_TRIPS_PER_RUN)) {
    if (budget <= 0) break;
    const ids = await repo.listPurgeableOriginalIds(db, trip.id, budget);
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < ids.length; i += IDS_PER_STATEMENT) {
      statements.push(...repo.purgeOriginalsStatements(db, trip.id, ids.slice(i, i + IDS_PER_STATEMENT), now));
    }
    // Fewer than asked for means none are left after this batch.
    if (ids.length < budget) statements.push(repo.markOriginalsPurged(db, trip.id, now));
    await db.batch(statements);
    budget -= ids.length;
  }
}
