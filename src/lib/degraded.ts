import { unavailable } from "../shared/errors";
import type { Env } from "../types";

export const DEGRADED_MESSAGE = "Rollo está en mantenimiento, probá más tarde";
export const DEGRADED_CACHE_MS = 60_000;
export const DEGRADED_KEY = "degraded_mode";

// Per isolate: other isolates see a change within DEGRADED_CACHE_MS.
let cache: { value: boolean; at: number } | null = null;

export async function isDegraded(env: Pick<Env, "DB">, now = Date.now()): Promise<boolean> {
  if (cache && now - cache.at < DEGRADED_CACHE_MS) return cache.value;
  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind(DEGRADED_KEY).first<{ value: string }>();
  const value = row?.value === "1";
  cache = { value, at: now };
  return value;
}

export async function assertNotDegraded(env: Pick<Env, "DB">): Promise<void> {
  if (await isDegraded(env)) throw unavailable(DEGRADED_MESSAGE);
}

export function resetDegradedCache(): void {
  cache = null;
}
