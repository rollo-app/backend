import { MOMENT_WINDOW_MS, dayWindow, drawNotifyAt, tripDays } from "../../lib/moments";
import { getNotificationSettings } from "../../lib/settings";
import { isRevealed, localDate } from "../../lib/util";
import type { TripRow } from "../../types";
import { insertMomentsIgnoringExisting, listUserMoments } from "./moments.repository";

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
  const fresh = tripDays(trip).flatMap((day) => {
    if (day < today) return [];
    const window = dayWindow(trip, day);
    return window ? [{ tripId: trip.id, userId, day, notifyAt: drawNotifyAt(window, random), createdAt: now }] : [];
  });
  await insertMomentsIgnoringExisting(db, fresh);

  const rows = await listUserMoments(db, trip.id, userId);
  return rows
    .filter((r) => r.day >= today && r.notify_at + MOMENT_WINDOW_MS > now)
    .map((r) => ({ day: r.day, notifyAt: r.notify_at }));
}
