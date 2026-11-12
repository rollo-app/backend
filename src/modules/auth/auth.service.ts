import { generateToken, hashToken, SESSION_TTL } from "../../lib/auth";
import { sendLoginCode } from "../../lib/email";
import {
  alertCapReached,
  type EmailKind,
  LOGIN_EMAILS_PER_DAY,
  LOGIN_NEW_USER_EMAILS_PER_DAY,
  LOGIN_NEW_USER_EMAILS_PER_IP_PER_DAY,
  releaseEmailSlot,
  reserveEmailSlot,
} from "../../lib/email-caps";
import { DEGRADED_MESSAGE, isDegraded } from "../../lib/degraded";
import { APPLE_ERROR, verifyAppleIdToken } from "../../lib/apple";
import { GOOGLE_ERROR, verifyGoogleIdToken } from "../../lib/google";
import { ipKey } from "../../lib/ip";
import { areRegistrationsOpen, registrationsClosed } from "../../lib/registrations";
import { LOGIN_CODE_TTL, generateLoginCode, normalizeLoginCode } from "../../lib/login-code";
import { badRequest, conflict, rateLimited, unavailable } from "../../shared/errors";
import type { Env, UserRow } from "../../types";
import * as repo from "./auth.repository";
import type { IdentityProvider } from "./auth.repository";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MAX_ATTEMPTS = 5;
const EMAIL_MIN_GAP = MINUTE;
const EMAIL_PER_HOUR = 5;
const IP_PER_HOUR = 20;

const codeHash = (email: string, code: string) => hashToken(`${email}:${code}`);
/** A magic-link token: 32 random bytes in base64url (`generateToken`). */
const LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** A PKCE code verifier (RFC 7636): 43–128 unreserved characters. */
const LINK_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const LINK_ERROR = "El link venció o ya se usó. Pedí otro código.";
export const USE_EMAIL_CODE = "Ya tenés una cuenta con este email. Entrá con el código que te mandamos por mail.";

const isReviewEmail = (env: Env, email: string) => !!env.REVIEW_EMAIL && !!env.REVIEW_CODE && email === env.REVIEW_EMAIL.trim().toLowerCase();

/**
 * With registrations closed nobody gets a new account by any path; an email that already has one (complete or not) signs in as
 * always. It runs only after the caller proved they own the email (right code or link, or a verified provider token), so the 403
 * does not reveal whether an address has an account to someone who just typed it (`/auth/email/start` answers the same either way).
 * The App Review account is exempt: closing the doors must not lock Apple out.
 */
async function assertMayHaveAccount(env: Env, email: string): Promise<void> {
  if (await areRegistrationsOpen(env)) return;
  if (isReviewEmail(env, email) || (await repo.userExists(env.DB, email))) return;
  throw registrationsClosed();
}

/** "send_failed" means the email provider failed (the controller answers 502). */
export type StartResult = "sent" | "send_failed";

export async function startLogin(
  env: Env,
  input: { email: string; linkChallenge?: string; rawIp: string | undefined },
): Promise<StartResult> {
  const { email, linkChallenge } = input;
  const now = Date.now();
  const ip = input.rawIp ? ipKey(input.rawIp) : null;
  const tooMany = () => rateLimited("Esperá un momento antes de pedir otro código");

  if ((await repo.countCodes(env.DB, "email", email, now - EMAIL_MIN_GAP)) > 0) throw tooMany();
  if ((await repo.countCodes(env.DB, "email", email, now - HOUR)) >= EMAIL_PER_HOUR) throw tooMany();
  if (ip && (await repo.countCodes(env.DB, "ip", ip, now - HOUR)) >= IP_PER_HOUR) throw tooMany();

  const isReview = isReviewEmail(env, email);
  const code = isReview ? env.REVIEW_CODE! : generateLoginCode();
  // Global daily caps, to keep room for support emails within Resend's free quota. Emails with no account yet get only part
  // of the budget, so spam of fake addresses cannot lock out existing users. The App Review account sends nothing.
  let isNewUser = false;
  let ipKind: EmailKind | null = null;
  if (!isReview) {
    isNewUser = !(await repo.userExists(env.DB, email));
    if (isNewUser) {
      // The new-user caps answer 204 like a success and send nothing: a 429 only for new emails would reveal whether an account exists.
      if (ip) {
        ipKind = `login_new_ip:${ip}`;
        if (!(await reserveEmailSlot(env.DB, ipKind, LOGIN_NEW_USER_EMAILS_PER_IP_PER_DAY))) {
          console.warn("[auth] daily new-user login email cap reached for an IP");
          return "sent";
        }
      }
      // Degraded mode blocks new accounts. It is checked after the per-IP slot (which stays spent), so probing emails costs the IP its daily budget.
      if (await isDegraded(env)) throw unavailable(DEGRADED_MESSAGE);
      if (!(await reserveEmailSlot(env.DB, "login_new", LOGIN_NEW_USER_EMAILS_PER_DAY))) {
        console.warn("[auth] daily login_new email cap reached");
        await alertCapReached(env, "login_new");
        return "sent";
      }
    }
    if (!(await reserveEmailSlot(env.DB, "login", LOGIN_EMAILS_PER_DAY))) {
      if (isNewUser) await releaseEmailSlot(env.DB, "login_new");
      if (ipKind) await releaseEmailSlot(env.DB, ipKind);
      console.warn("[auth] daily login email cap reached");
      await alertCapReached(env, "login");
      throw rateLimited("Hay muchos pedidos de código ahora. Probá en un rato.");
    }
  }
  // No challenge (old app builds): no magic link at all, only the code.
  const linkToken = linkChallenge ? generateToken() : null;
  const id = crypto.randomUUID();

  await env.DB.batch([
    repo.invalidateOpenCodes(env.DB, email, now),
    repo.insertCode(env.DB, {
      id,
      email,
      codeHash: await codeHash(email, code),
      linkHash: linkToken ? await hashToken(linkToken) : null,
      linkChallenge: linkToken ? (linkChallenge ?? null) : null,
      ip,
      createdAt: now,
      expiresAt: now + LOGIN_CODE_TTL,
    }),
  ]);

  if (!isReview) {
    try {
      await sendLoginCode(env, email, code, linkToken);
    } catch (err) {
      console.error(err);
      // Don't burn the user's rate limit for an email we couldn't send.
      await repo.deleteCode(env.DB, id).run();
      await releaseEmailSlot(env.DB, "login");
      if (isNewUser) await releaseEmailSlot(env.DB, "login_new");
      if (ipKind) await releaseEmailSlot(env.DB, ipKind);
      return "send_failed";
    }
  }
  return "sent";
}

export type SignedIn = { token: string; user: UserRow; isNew: boolean };

export async function verifyCode(env: Env, email: string, typed: string): Promise<SignedIn> {
  const db = env.DB;
  const now = Date.now();
  const code = normalizeLoginCode(typed);
  if (code === null) throw badRequest("Código incorrecto");
  const expired = () => badRequest("El código venció, pedí uno nuevo");

  const row = await takeAttempt(db, email, now);
  if (!row) throw expired();

  if (row.code_hash !== (await codeHash(email, code))) {
    throw badRequest("Código incorrecto");
  }

  // Before consuming: the code stays valid, and nothing is created.
  await assertMayHaveAccount(env, email);
  if (!(await consume(db, row.id, now))) throw expired();
  return signIn(db, email, now);
}

export async function verifyLink(env: Env, input: { email: string; token: string; verifier?: string }): Promise<SignedIn> {
  const db = env.DB;
  const { email, token, verifier } = input;
  const now = Date.now();
  const invalid = () => badRequest(LINK_ERROR);
  if (!LINK_TOKEN.test(token)) throw invalid();

  // Take the attempt before checking the verifier, so a wrong or missing one counts as a failure too.
  const row = await takeAttempt(db, email, now);
  if (!row || !row.link_hash || !row.link_challenge) throw invalid();
  const tokenOk = timingSafeEqual(row.link_hash, await hashToken(token));
  const verifierOk =
    verifier !== undefined && LINK_VERIFIER.test(verifier) && timingSafeEqual(row.link_challenge, await linkChallengeOf(verifier));
  if (!tokenOk || !verifierOk) throw invalid();
  await assertMayHaveAccount(env, email);
  if (!(await consume(db, row.id, now))) throw invalid();
  return signIn(db, email, now);
}

/**
 * Consumes one attempt of the email's current login code atomically *before* comparing, so concurrent
 * requests can't all slip past the attempt limit. Null when there is no usable code.
 */
function takeAttempt(db: D1Database, email: string, now: number) {
  return repo.takeAttempt(db, email, MAX_ATTEMPTS, now);
}

/** base64url (no padding) of SHA-256(verifier): the PKCE S256 challenge. */
async function linkChallengeOf(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Compares two strings without leaking, through timing, how much of them matches. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Single use, even with concurrent requests: only one verify (code or link) can flip used_at. */
async function consume(db: D1Database, id: string, now: number): Promise<boolean> {
  const used = await repo.markCodeUsed(db, id, now).run();
  return used.meta.changes === 1;
}

/** Creates the user on first sign-in and a new session. */
async function signIn(db: D1Database, email: string, now: number): Promise<SignedIn> {
  await repo.insertUserIfMissing(db, crypto.randomUUID(), email, now).run();
  return newSession(db, (await repo.findUserByEmail(db, email))!, now);
}

/** Signs in with a Google ID token (see `signInWithProvider`). Google sends the profile name in the token. */
export async function signInWithGoogle(env: Env, idToken: string): Promise<SignedIn> {
  const { subject, email, name, emailIsGoogles } = await verifyGoogleIdToken(env, idToken);
  return signInWithProvider(env, { provider: "google", subject, email, name, emailIsProviders: emailIsGoogles }, GOOGLE_ERROR);
}

/**
 * Signs in with a Sign in with Apple identity token (see `signInWithProvider`). Apple gives the name only to the app and only on
 * the first sign-in, so the app sends it along (it is just a suggestion for the user's own profile, like `PATCH /me`).
 */
export async function signInWithApple(env: Env, input: { identityToken: string; name?: string }): Promise<SignedIn> {
  const { subject, email, emailIsApples } = await verifyAppleIdToken(env, input.identityToken);
  return signInWithProvider(env, { provider: "apple", subject, email, name: input.name ?? null, emailIsProviders: emailIsApples }, APPLE_ERROR);
}

/**
 * The provider's account id (`sub`) finds a linked user even if its email changed; if none, the email the provider verified signs
 * into that email's account (or creates it) and links it, in one batch.
 */
async function signInWithProvider(
  env: Env,
  account: { provider: IdentityProvider; subject: string; email: string | null; name: string | null; emailIsProviders: boolean },
  invalidMessage: string,
): Promise<SignedIn> {
  const { provider, subject, email, name, emailIsProviders } = account;
  const now = Date.now();

  const linked = await repo.findUserByIdentity(env.DB, provider, subject);
  if (linked) return newSession(env.DB, linked, now);
  // Without a link, the email is what finds or makes the account.
  if (!email) throw badRequest(invalidMessage);

  const exists = await repo.userExists(env.DB, email);
  // A provider vouches for an address it doesn't own (not Gmail/Workspace, not iCloud/its relay) only from when that provider account
  // was made: it may have changed hands since. Linking it to the Rollo account with that email could hand someone else's account
  // over, so that owner signs in with the code.
  if (exists && !emailIsProviders) throw conflict(USE_EMAIL_CODE);
  // Closed registrations and degraded mode block new accounts; existing ones still get in. (The token proves the email, so no enumeration concern.)
  if (!exists && !(await areRegistrationsOpen(env))) throw registrationsClosed();
  if (!exists && (await isDegraded(env))) throw unavailable(DEGRADED_MESSAGE);
  // The provider's name prefills "Completá tu perfil" (the user can change it there); an account that already has a name keeps it.
  const suggested = profileNameFrom(name);
  await env.DB.batch([
    repo.insertUserIfMissing(env.DB, crypto.randomUUID(), email, now),
    ...(suggested ? [repo.setNameIfMissing(env.DB, email, suggested)] : []),
    repo.linkIdentityByEmail(env.DB, { provider, subject, email, now }),
  ]);
  return newSession(env.DB, (await repo.findUserByEmail(env.DB, email))!, now);
}

/** A provider's full name as a profile name: single spaces, at most 30 characters (the `PATCH /me` limit); null if empty. */
function profileNameFrom(raw: string | null): string | null {
  if (!raw) return null;
  const name = [...raw.trim().replace(/\s+/g, " ")].slice(0, 30).join("").trim();
  return name || null;
}

async function newSession(db: D1Database, user: UserRow, now: number): Promise<SignedIn> {
  const token = generateToken();
  await repo
    .insertSession(db, { id: crypto.randomUUID(), userId: user.id, tokenHash: await hashToken(token), now, expiresAt: now + SESSION_TTL })
    .run();

  return { token, user, isNew: user.name === null || user.username === null };
}

export async function logout(db: D1Database, sessionId: string): Promise<void> {
  // The session's push tokens go with it (explicit, besides the FK cascade): the phone stops getting this account's pushes.
  await db.batch([repo.deletePushTokensOfSession(db, sessionId), repo.deleteSession(db, sessionId)]);
}
