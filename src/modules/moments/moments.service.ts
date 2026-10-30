import { MIN_DAY_WINDOW_MS, MOMENT_WINDOW_MS, dayWindow, drawNotifyAt } from "../../lib/moments";
import { getNotificationSettings } from "../settings/settings.service";
import { isRevealed, localDate } from "../../lib/util";
import { badRequest, conflict } from "../../shared/errors";
import type { MemberRow, TripRow } from "../../types";
import { findMediaById } from "../media/media.repository";
import type { RegisterMediaInput } from "../media/media.schemas";
import { findMoment, findMomentSlots, findPairedMediaId, insertMomentsIgnoringExisting, listMomentTrips, listUserMoments } from "./moments.repository";

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
): Promise<{ day: string; notifyAt: number; mode?: "photo" | "photo_selfie" }[]> {
  if (isRevealed(trip, now) || now >= trip.ends_at) return [];
  if (!(await getNotificationSettings(db, [userId])).get(userId)!.dailyMoment) return [];

  const today = localDate(now, trip.timezone);
  const lastDay = localDate(trip.ends_at, trip.timezone);
  const start = Date.parse(`${today}T00:00:00Z`);
  const days = Array.from({ length: MOMENT_DRAW_DAYS }, (_, i) => new Date(start + i * DAY_MS).toISOString().slice(0, 10)).filter(
    (day) => day <= lastDay,
  );
  const fresh = days.flatMap((day) => {
    // A config changed in a running rollo applies from the day it names, never to days before it.
    if (trip.moment_from_day && day < trip.moment_from_day) return [];
    const full = dayWindow(trip, day);
    // Today is never drawn in the past: it starts a minute from now, and a window under the minimum is dropped.
    const window = full && day === today ? { from: Math.max(full.from, now + 60_000), to: full.to } : full;
    if (window && window.to - window.from < MIN_DAY_WINDOW_MS) return [];
    return window ? [{ tripId: trip.id, userId, day, notifyAt: drawNotifyAt(window, random), createdAt: now, mode: trip.moment_mode }] : [];
  });
  // A trip with the moment off draws nothing new; the rows already drawn (today's) stay takeable.
  if (trip.moment_mode !== "off") await insertMomentsIgnoringExisting(db, fresh);

  const rows = await listUserMoments(db, trip.id, userId);
  return rows
    // With the moment off only today's already drawn row is still takeable.
    .filter((r) => (trip.moment_mode === "off" ? r.day === today : r.day >= today) && r.notify_at + MOMENT_WINDOW_MS > now)
    .flatMap((r) => {
      const mode = (r.mode ?? trip.moment_mode) as "photo" | "photo_selfie" | "off";
      return [{ day: r.day, notifyAt: r.notify_at, ...(mode === "off" ? {} : { mode }) }];
    });
}

export type MyTripMoments = {
  tripId: string;
  tripName: string;
  momentMode: "photo" | "photo_selfie";
  moments: { day: string; notifyAt: number; mode?: "photo" | "photo_selfie" }[];
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
    const moments = await getMyMoments(db, trip, userId, now, random);
    // The query lets an off trip through on any open row (it can't know the trip's local day): drop it when nothing is takeable today.
    if (trip.moment_mode === "off" && moments.length === 0) continue;
    // With the moment off, the trip only shows because of a row drawn earlier: report that row's mode.
    const momentMode = trip.moment_mode === "off" ? (moments[0]?.mode ?? "photo") : (trip.moment_mode as "photo" | "photo_selfie");
    out.push({ tripId: trip.id, tripName: trip.name, momentMode, moments });
  }
  return out;
}

/** Selfies of a moment (`media.paired_media_id`) travel inside their main photo: no likes, comments or featuring of their own. */
export function rejectSelfie(pairedMediaId: string | null): void {
  if (pairedMediaId !== null) throw badRequest("Esta foto es parte de un momento: usá la principal.");
}

/** For the endpoints that have no lookup of their own (unlike, unfeature). */
export async function rejectSelfieById(db: D1Database, mediaId: string): Promise<void> {
  rejectSelfie(await findPairedMediaId(db, mediaId));
}

/** Neither image of a moment (main or linked one) goes to a profile. */
export function rejectMomentFeaturing(row: { moment_day: string | null; paired_media_id: string | null }): void {
  if (row.moment_day !== null || row.paired_media_id !== null) throw badRequest("Las fotos del momento no se pueden agregar a tu perfil.");
}

export type MomentTarget = { day: string; notifyAt: number; pairedMediaId: string | null };

/**
 * Validates the moment fields of a new registration (not a retry). Null when it is an ordinary photo or video.
 * A main photo needs the member's moment row for `momentDay` with no photo yet (409); a selfie (`pairedMediaId`)
 * must pair with the member's own main moment photo of this rollo (400) and inherits its day.
 */
export async function resolveMoment(db: D1Database, trip: TripRow, member: MemberRow, input: RegisterMediaInput): Promise<MomentTarget | null> {
  // A moment already drawn survives the trip turning the moment off or changing its mode: the row decides.
  const existing = input.momentDay != null ? await findMoment(db, trip.id, member.user_id, input.momentDay) : null;
  if (input.momentDay != null && trip.moment_mode === "off" && !existing) throw badRequest("Este rollo no tiene momento del día");
  if (input.pairedMediaId) {
    const main = await findMediaById(db, input.pairedMediaId);
    const valid =
      main !== null &&
      main.deletedAt === null &&
      main.memberId === member.id &&
      main.tripId === trip.id &&
      main.momentDay !== null &&
      main.pairedMediaId === null;
    if (!valid || (input.momentDay != null && input.momentDay !== main.momentDay)) {
      throw badRequest("La foto del momento no corresponde");
    }
    const mainRow = await findMoment(db, trip.id, member.user_id, main.momentDay!);
    if ((mainRow?.mode ?? trip.moment_mode) !== "photo_selfie") throw badRequest("Este rollo no admite selfie del momento");
    const slots = await findMomentSlots(db, trip.id, member.user_id, main.momentDay!);
    if (!slots) throw badRequest("La foto del momento no corresponde");
    if (slots.media_id !== main.id) throw badRequest("La foto del momento no corresponde");
    if (slots.selfie_media_id !== null) throw conflict("Este momento ya tiene selfie");
    return { day: main.momentDay!, notifyAt: 0, pairedMediaId: main.id };
  }
  if (input.momentDay == null) return null;

  const row = existing;
  if (!row) throw conflict("No tenés un momento ese día");
  const slots = await findMomentSlots(db, trip.id, member.user_id, input.momentDay);
  if (slots?.media_id != null) throw conflict("Este momento ya tiene foto");
  return { day: input.momentDay, notifyAt: row.notify_at, pairedMediaId: null };
}
