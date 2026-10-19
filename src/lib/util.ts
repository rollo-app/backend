import type { TripRow } from "../types";

/** Fecha YYYY-MM-DD de un instante, en la zona horaria del viaje. */
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

export function isRevealed(trip: TripRow, now = Date.now()): boolean {
  return trip.revealed_at !== null || now >= trip.reveal_at;
}

// Sin 0/O ni 1/I/L para que se pueda dictar en voz alta.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateJoinCode(length = 6): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

/** Forma pública de un viaje (lo que ve la app). */
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
