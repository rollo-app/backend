import { sendPush, type PushMessage } from "./push";
import { isRevealed } from "./util";
import type { Env, TripRow } from "../types";

/**
 * "Arrancó" and "Se reveló" pushes. The cron (every 5 min) and the admin's manual reveal both claim the trip
 * first (`*_notified_at` set only if still null, in one statement), so whoever claims it is the only one who sends.
 */

export function tripStartedMessage(trip: Pick<TripRow, "id" | "name" | "daily_photo_limit" | "photo_limit_mode" | "total_photo_limit">): PushMessage {
  const total = trip.photo_limit_mode === "total";
  const n = total ? (trip.total_photo_limit ?? 0) : trip.daily_photo_limit;
  const when = total ? "en el rollo" : "hoy";
  return { body: `Arrancó ${trip.name}. Tenés ${n} ${n === 1 ? "foto" : "fotos"} ${when}.`, url: `/roll?trip=${trip.id}` };
}

export function tripRevealedMessage(trip: Pick<TripRow, "id" | "name">): PushMessage {
  return { body: `Se reveló ${trip.name}`, url: `/reveal?trip=${trip.id}` };
}

/**
 * Whether a trip whose start has come gets the "Arrancó" push: not if it was already revealed
 * (e.g. the admin revealed it before it started) or already ended (nothing can be shot anymore).
 */
export function shouldAnnounceStart(trip: Pick<TripRow, "ends_at" | "revealed_at" | "reveal_at">, now: number): boolean {
  return !isRevealed(trip, now) && now <= trip.ends_at;
}

/** Marks the trip as "started" notified. True only for the caller that flipped it. */
async function claimStarted(db: D1Database, tripId: string, now: number): Promise<boolean> {
  const res = await db.prepare("UPDATE trips SET started_notified_at = ? WHERE id = ? AND started_notified_at IS NULL").bind(now, tripId).run();
  return res.meta.changes > 0;
}

/** Statement that marks the trip as "revealed" notified; it changes a row only for the caller that flipped it. */
export function claimRevealedStatement(db: D1Database, tripId: string, now: number): D1PreparedStatement {
  return db.prepare("UPDATE trips SET revealed_notified_at = ? WHERE id = ? AND revealed_notified_at IS NULL").bind(now, tripId);
}

/** Marks the trip as "revealed" notified. True only for the caller that flipped it. */
async function claimRevealed(db: D1Database, tripId: string, now: number): Promise<boolean> {
  const res = await claimRevealedStatement(db, tripId, now).run();
  return res.meta.changes > 0;
}

/** User ids of the trip's active members (neither left nor removed): the only ones a push may name the trip to. */
export async function activeMemberIds(db: D1Database, tripId: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT user_id FROM members WHERE trip_id = ? AND removed_at IS NULL AND left_at IS NULL")
    .bind(tripId)
    .all<{ user_id: string }>();
  return results.map((r) => r.user_id);
}

/** Sends "Se reveló" to the active members (except the actor, when the admin revealed it). Call after claimRevealed. */
export async function sendTripRevealed(env: Pick<Env, "DB">, trip: Pick<TripRow, "id" | "name">, actorId?: string): Promise<void> {
  await sendPush(env, await activeMemberIds(env.DB, trip.id), "tripRevealed", tripRevealedMessage(trip), { actorId });
}

/** Cron: announces the trips that started or revealed since the last run. Idempotent. */
export async function runTripNotices(env: Pick<Env, "DB">, now = Date.now()): Promise<void> {
  const db = env.DB;

  // Started first, so a trip that started and revealed between two runs is marked without saying "Arrancó".
  const started = await db
    .prepare("SELECT * FROM trips WHERE started_notified_at IS NULL AND starts_at <= ?")
    .bind(now)
    .all<TripRow>();
  for (const trip of started.results) {
    if (!(await claimStarted(db, trip.id, now))) continue;
    if (!shouldAnnounceStart(trip, now)) continue;
    await sendPush(env, await activeMemberIds(db, trip.id), "tripStarted", tripStartedMessage(trip));
  }

  const revealed = await db
    .prepare("SELECT * FROM trips WHERE revealed_notified_at IS NULL AND (revealed_at IS NOT NULL OR reveal_at <= ?)")
    .bind(now)
    .all<TripRow>();
  for (const trip of revealed.results) {
    if (!(await claimRevealed(db, trip.id, now))) continue;
    await sendTripRevealed(env, trip);
  }
}
