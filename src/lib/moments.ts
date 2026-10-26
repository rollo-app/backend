import { localDate } from "./util";

export const MOMENT_WINDOW_MS = 15 * 60_000;
export const MIN_DAY_WINDOW_MS = 30 * 60_000;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export type MomentTrip = {
  starts_at: number;
  ends_at: number;
  timezone: string;
  moment_window_start: number;
  moment_window_end: number;
};

/** UTC offset (ms, local minus UTC) of `timeZone` at the instant `ms`. */
function offsetAt(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** UTC ms of `minutes` after local midnight of `day` (YYYY-MM-DD), using that day's own offset. */
function localToUtc(day: string, minutes: number, timeZone: string): number {
  const naive = Date.parse(`${day}T00:00:00Z`) + minutes * MINUTE_MS;
  // Two passes settle the offset when the guess lands on the other side of a DST change.
  let guess = naive - offsetAt(naive, timeZone);
  guess = naive - offsetAt(guess, timeZone);
  return guess;
}

/** Local dates (YYYY-MM-DD) from starts_at to ends_at, inclusive. */
export function tripDays(trip: MomentTrip): string[] {
  const last = localDate(trip.ends_at, trip.timezone);
  const days: string[] = [];
  let cursor = Date.parse(`${localDate(trip.starts_at, trip.timezone)}T00:00:00Z`);
  for (;;) {
    const day = new Date(cursor).toISOString().slice(0, 10);
    if (day > last) break;
    days.push(day);
    cursor += DAY_MS;
  }
  return days;
}

/** The slice of the day's moment band that fits inside the trip; null if shorter than MIN_DAY_WINDOW_MS. */
export function dayWindow(trip: MomentTrip, day: string): { from: number; to: number } | null {
  const from = Math.max(localToUtc(day, trip.moment_window_start, trip.timezone), trip.starts_at);
  const to = Math.min(localToUtc(day, trip.moment_window_end, trip.timezone), trip.ends_at - MOMENT_WINDOW_MS);
  return to - from < MIN_DAY_WINDOW_MS ? null : { from, to };
}

/** Uniform pick inside the window, on a whole minute. */
export function drawNotifyAt(window: { from: number; to: number }, random: () => number): number {
  const lo = Math.ceil(window.from / MINUTE_MS);
  const hi = Math.floor(window.to / MINUTE_MS);
  if (hi < lo) return window.from;
  return (lo + Math.floor(random() * (hi - lo + 1))) * MINUTE_MS;
}
