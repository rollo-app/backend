import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, vi } from "vitest";
import { flushPendingPushes } from "../src/lib/push";

// Tests never reach the real Expo Push API: without `mockExpo()` (test/helpers.ts) any call to it fails.
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith("https://exp.host/")) return Promise.reject(new Error(`Expo called without mockExpo(): ${url}`));
  return realFetch(input, init);
}) as typeof fetch;

// Each test starts with an empty database and bucket, and an up-to-date schema.
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

// Pushes deferred with waitUntil finish inside their own test, not on top of the next test's reset.
afterEach(async () => {
  await flushPendingPushes();
  vi.restoreAllMocks();
});
