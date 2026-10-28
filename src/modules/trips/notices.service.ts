import { sendPush, type PushMessage } from "../../lib/push";
import { isRevealed } from "../../lib/util";
import type { Env, TripRow } from "../../types";
import * as repo from "./trips.repository";

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
  return (await repo.claimStartedNotice(db, tripId, now).run()).meta.changes > 0;
}

/** Marks the trip as "revealed" notified. True only for the caller that flipped it. */
async function claimRevealed(db: D1Database, tripId: string, now: number): Promise<boolean> {
  return (await repo.claimRevealedNotice(db, tripId, now).run()).meta.changes > 0;
}

/** Sends "Se reveló" to the active members (except the actor, when the admin revealed it). Call after claimRevealed. */
export async function sendTripRevealed(env: Pick<Env, "DB">, trip: Pick<TripRow, "id" | "name">, actorId?: string): Promise<void> {
  await sendPush(env, await repo.listActiveMemberUserIds(env.DB, trip.id), "tripRevealed", tripRevealedMessage(trip), { actorId });
}

/** Cron: announces the trips that started or revealed since the last run. Idempotent. */
export async function runTripNotices(env: Pick<Env, "DB">, now = Date.now()): Promise<void> {
  const db = env.DB;

  // Started first, so a trip that started and revealed between two runs is marked without saying "Arrancó".
  for (const trip of await repo.listTripsToAnnounceStart(db, now)) {
    if (!(await claimStarted(db, trip.id, now))) continue;
    if (!shouldAnnounceStart(trip, now)) continue;
    await sendPush(env, await repo.listActiveMemberUserIds(db, trip.id), "tripStarted", tripStartedMessage(trip));
  }

  for (const trip of await repo.listTripsToAnnounceReveal(db, now)) {
    if (!(await claimRevealed(db, trip.id, now))) continue;
    await sendTripRevealed(env, trip);
  }
}
