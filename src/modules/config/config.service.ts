import { areRegistrationsOpen } from "../../lib/registrations";
import type { Env } from "../../types";

/** What the app needs before sign-in. Cached 60 s per isolate (like degraded mode), so a switch from the panel takes up to a minute. */
export async function getPublicConfig(env: Env): Promise<{ registrationsOpen: boolean }> {
  return { registrationsOpen: await areRegistrationsOpen(env) };
}
