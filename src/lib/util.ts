import type { TripRow } from "../types";

/** YYYY-MM-DD date of an instant, in the trip's time zone. */
export function localDate(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Decodable standard base64 (with or without padding). */
export function isBase64(s: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return false;
  try {
    atob(s);
    return true;
  } catch {
    return false;
  }
}

export function isRevealed(trip: TripRow, now = Date.now()): boolean {
  return trip.revealed_at !== null || now >= trip.reveal_at;
}

// No 0/O or 1/I/L so it can be read out loud.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateJoinCode(length = 6): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

/** Public shape of a trip (what the app sees). */
export function publicTrip(trip: TripRow, now = Date.now()) {
  return {
    id: trip.id,
    name: trip.name,
    joinCode: trip.join_code,
    timezone: trip.timezone,
    startsAt: trip.starts_at,
    endsAt: trip.ends_at,
    revealAt: trip.reveal_at,
    revealed: isRevealed(trip, now),
    dailyPhotoLimit: trip.daily_photo_limit,
    dailyVideoLimit: trip.daily_video_limit,
  };
}
