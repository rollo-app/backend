import { MIN_DAY_WINDOW_MS, MOMENT_WINDOW_MS, dayWindow, drawNotifyAt } from "../../lib/moments";
import { getNotificationSettings } from "../../lib/settings";
import { isRevealed, localDate } from "../../lib/util";
import type { TripRow } from "../../types";
import { insertMomentsIgnoringExisting, listMomentTrips, listUserMoments } from "./moments.repository";

/** Days (trip local, starting today) drawn per request; later days are drawn by later requests. */
export const MOMENT_DRAW_DAYS = 31;
const DAY_MS = 86_400_000;
/** How long before a trip starts its moments are already handed out (same window as the app). */
export const MOMENT_PREFETCH_MS = 3 * DAY_MS;

function secureRandom(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
}

/**
 * The member's moments from today (trip local date) to the end of the trip. Draws and stores the missing days
 * the first time they are asked for (existing rows are never re-drawn) and returns only the ones that can
 * still be taken.
 */
export async function getMyMoments(
  db: D1Database,
  trip: TripRow,
  userId: string,
  now: number,
  random: () => number = secureRandom,
): Promise<{ day: string; notifyAt: number }[]> {
  if (trip.moment_mode === "off" || isRevealed(trip, now) || now >= trip.ends_at) return [];
  if (!(await getNotificationSettings(db, [userId])).get(userId)!.dailyMoment) return [];

  const today = localDate(now, trip.timezone);
  const lastDay = localDate(trip.ends_at, trip.timezone);
  const start = Date.parse(`${today}T00:00:00Z`);
  const days = Array.from({ length: MOMENT_DRAW_DAYS }, (_, i) => new Date(start + i * DAY_MS).toISOString().slice(0, 10)).filter(
    (day) => day <= lastDay,
  );
  const fresh = days.flatMap((day) => {
    const full = dayWindow(trip, day);
    // Today is never drawn in the past: it starts a minute from now, and a window under the minimum is dropped.
    const window = full && day === today ? { from: Math.max(full.from, now + 60_000), to: full.to } : full;
    if (window && window.to - window.from < MIN_DAY_WINDOW_MS) return [];
    return window ? [{ tripId: trip.id, userId, day, notifyAt: drawNotifyAt(window, random), createdAt: now }] : [];
  });
  await insertMomentsIgnoringExisting(db, fresh);

  const rows = await listUserMoments(db, trip.id, userId);
  return rows
    .filter((r) => r.day >= today && r.notify_at + MOMENT_WINDOW_MS > now)
    .map((r) => ({ day: r.day, notifyAt: r.notify_at }));
}

export type MyTripMoments = {
  tripId: string;
  tripName: string;
  momentMode: "photo" | "photo_selfie";
  moments: { day: string; notifyAt: number }[];
};

/**
 * The moments of every trip the user can schedule notifications for, in one call: one SELECT of the candidate
 * trips, then the same per-trip logic as `getMyMoments` (draws and stores only the first time).
 */
export async function getAllMyMoments(
  db: D1Database,
  userId: string,
  now: number,
  random: () => number = secureRandom,
): Promise<MyTripMoments[]> {
  const trips = await listMomentTrips(db, userId, now, MOMENT_PREFETCH_MS);
  const out: MyTripMoments[] = [];
  for (const trip of trips) {
    out.push({
      tripId: trip.id,
      tripName: trip.name,
      momentMode: trip.moment_mode as "photo" | "photo_selfie",
      moments: await getMyMoments(db, trip, userId, now, random),
    });
  }
  return out;
}
