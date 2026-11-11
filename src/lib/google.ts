import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { badRequest, unavailable } from "../shared/errors";
import type { Env } from "../types";

export const GOOGLE_ERROR = "No pudimos verificar tu cuenta de Google. Probá de nuevo.";
export const GOOGLE_UNAVAILABLE = "El inicio con Google no está disponible ahora.";

const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const CERTS_URL = new URL("https://www.googleapis.com/oauth2/v3/certs");

// jose caches Google's public keys per isolate and refetches them when a token comes with an unknown `kid`.
let remoteKeys: JWTVerifyGetKey | null = null;
let testKeys: JWTVerifyGetKey | null = null;

/** Tests sign their own tokens: they swap Google's keys for a local set (null goes back to Google's). */
export function setGoogleKeysForTests(keys: JWTVerifyGetKey | null): void {
  testKeys = keys;
}

function keys(): JWTVerifyGetKey {
  return testKeys ?? (remoteKeys ??= createRemoteJWKSet(CERTS_URL));
}

/** GOOGLE_CLIENT_IDS: comma-separated OAuth client ids whose tokens are accepted (web and iOS). */
function clientIds(env: Env): string[] {
  return (env.GOOGLE_CLIENT_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

/**
 * `name` is the Google profile's full name, untouched (may be missing). `emailIsGoogles`: Google owns that address (Gmail, or a
 * Workspace domain, `hd`), so it vouches for it today; any other address it only checked when the Google account was made.
 */
export type GoogleAccount = { subject: string; email: string; name: string | null; emailIsGoogles: boolean };

/** Google's guidance: trust the email to find an existing account only for Gmail or a Workspace domain matching `hd`. */
function googleOwnsEmail(email: string, hd: unknown): boolean {
  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (domain === "gmail.com" || domain === "googlemail.com") return true;
  return typeof hd === "string" && hd.toLowerCase() === domain;
}

/**
 * Checks a Google ID token (signature against Google's keys, issuer, audience = one of our clients, expiry) and that
 * Google verified its email. Any failure is the same 400: the reason only goes to the log.
 */
export async function verifyGoogleIdToken(env: Env, idToken: string): Promise<GoogleAccount> {
  const audience = clientIds(env);
  if (audience.length === 0) throw unavailable(GOOGLE_UNAVAILABLE);
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, keys(), { issuer: ISSUERS, audience, algorithms: ["RS256"], clockTolerance: 60 }));
  } catch (err) {
    console.warn("[google] invalid ID token", err instanceof Error ? err.message : err);
    throw badRequest(GOOGLE_ERROR);
  }
  const { sub, email, email_verified, name, hd } = payload as {
    sub?: unknown;
    email?: unknown;
    email_verified?: unknown;
    name?: unknown;
    hd?: unknown;
  };
  if (typeof sub !== "string" || !sub || typeof email !== "string" || email_verified !== true) {
    console.warn("[google] token without a verified email");
    throw badRequest(GOOGLE_ERROR);
  }
  const normalized = email.trim().toLowerCase();
  return { subject: sub, email: normalized, name: typeof name === "string" ? name : null, emailIsGoogles: googleOwnsEmail(normalized, hd) };
}
