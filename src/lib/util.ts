import type { MemberRow, TripRow, UserRow } from "../types";

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

/** Public path of a user's avatar (the app prefixes the API base URL), or null if they have none. */
export function avatarUrl(userId: string, avatarKey: string | null): string | null {
  return avatarKey ? `/avatars/${userId}/${avatarKey.split("/").pop()}` : null;
}

/** Public shape of a user. */
export function publicUser(user: Pick<UserRow, "id" | "email" | "name" | "username" | "avatar_key">) {
  return { id: user.id, email: user.email, name: user.name, username: user.username, avatarUrl: avatarUrl(user.id, user.avatar_key) };
}

/** Public shape of a membership (what the app sees as a trip member). */
export function publicMember(member: Pick<MemberRow, "id" | "user_id" | "role">, user: Pick<UserRow, "name" | "username" | "avatar_key">) {
  return {
    id: member.id,
    userId: member.user_id,
    name: user.name ?? "",
    username: user.username,
    avatarUrl: avatarUrl(member.user_id, user.avatar_key),
    role: member.role,
  };
}

/** Pragmatic email check (a code is sent anyway, so this only filters typos). */
export function isEmail(s: string): boolean {
  return s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
