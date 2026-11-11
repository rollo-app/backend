import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { badRequest, unavailable } from "../shared/errors";
import type { Env } from "../types";

export const APPLE_ERROR = "No pudimos verificar tu cuenta de Apple. Probá de nuevo.";
export const APPLE_UNAVAILABLE = "El inicio con Apple no está disponible ahora.";

const ISSUER = "https://appleid.apple.com";
const KEYS_URL = new URL("https://appleid.apple.com/auth/keys");
/** Addresses Apple owns: iCloud and the Hide My Email relay (unique to this app). */
const APPLE_DOMAINS = new Set(["icloud.com", "me.com", "mac.com", "privaterelay.appleid.com"]);

// jose caches Apple's public keys per isolate and refetches them when a token comes with an unknown `kid`.
let remoteKeys: JWTVerifyGetKey | null = null;
let testKeys: JWTVerifyGetKey | null = null;

/** Tests sign their own tokens: they swap Apple's keys for a local set (null goes back to Apple's). */
export function setAppleKeysForTests(keys: JWTVerifyGetKey | null): void {
  testKeys = keys;
}

function keys(): JWTVerifyGetKey {
  return testKeys ?? (remoteKeys ??= createRemoteJWKSet(KEYS_URL));
}

/** APPLE_CLIENT_IDS: comma-separated bundle ids whose identity tokens are accepted. */
function clientIds(env: Env): string[] {
  return (env.APPLE_CLIENT_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

/**
 * `email` can be missing (Apple may leave it out after the first sign-in). `emailIsApples`: Apple owns the address (iCloud or its
 * relay), so it vouches for it today; any other address it only checked when the Apple ID was set up.
 */
export type AppleAccount = { subject: string; email: string | null; emailIsApples: boolean };

/**
 * Checks a Sign in with Apple identity token (signature against Apple's keys, issuer, audience = one of our bundle ids, expiry)
 * and, if it carries an email, that Apple verified it. Any failure is the same 400: the reason only goes to the log.
 */
export async function verifyAppleIdToken(env: Env, identityToken: string): Promise<AppleAccount> {
  const audience = clientIds(env);
  if (audience.length === 0) throw unavailable(APPLE_UNAVAILABLE);
  let payload;
  try {
    ({ payload } = await jwtVerify(identityToken, keys(), { issuer: ISSUER, audience, algorithms: ["RS256"], clockTolerance: 60 }));
  } catch (err) {
    console.warn("[apple] invalid identity token", err instanceof Error ? err.message : err);
    throw badRequest(APPLE_ERROR);
  }
  const { sub, email, email_verified } = payload as { sub?: unknown; email?: unknown; email_verified?: unknown };
  if (typeof sub !== "string" || !sub) throw badRequest(APPLE_ERROR);
  if (typeof email !== "string" || !email) return { subject: sub, email: null, emailIsApples: false };
  // Apple sends it as the string "true" (older tokens) or a boolean.
  if (email_verified !== true && email_verified !== "true") {
    console.warn("[apple] token with an unverified email");
    throw badRequest(APPLE_ERROR);
  }
  const normalized = email.trim().toLowerCase();
  return { subject: sub, email: normalized, emailIsApples: APPLE_DOMAINS.has(normalized.slice(normalized.lastIndexOf("@") + 1)) };
}
