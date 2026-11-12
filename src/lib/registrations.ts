import { forbidden } from "../shared/errors";
import type { Env } from "../types";

export const REGISTRATIONS_CLOSED_MESSAGE = "Por ahora no estamos sumando cuentas nuevas. Anotate en la lista y te avisamos cuando abramos.";
/** The `code` of the 403 the app shows the waitlist for. */
export const REGISTRATIONS_CLOSED_CODE = "REGISTRATIONS_CLOSED";
/** `app_settings` key: "1" = closed. No row (the default) = open. */
export const REGISTRATIONS_CLOSED_KEY = "registrations_closed";
export const REGISTRATIONS_CACHE_MS = 60_000;

// Per isolate, like degraded mode: other isolates see a change within REGISTRATIONS_CACHE_MS.
let cache: { value: boolean; at: number } | null = null;

export async function areRegistrationsOpen(env: Pick<Env, "DB">, now = Date.now()): Promise<boolean> {
  if (cache && now - cache.at < REGISTRATIONS_CACHE_MS) return cache.value;
  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind(REGISTRATIONS_CLOSED_KEY).first<{ value: string }>();
  const value = row?.value !== "1";
  cache = { value, at: now };
  return value;
}

export const registrationsClosed = () => forbidden(REGISTRATIONS_CLOSED_MESSAGE, REGISTRATIONS_CLOSED_CODE);

export function resetRegistrationsCache(): void {
  cache = null;
}
