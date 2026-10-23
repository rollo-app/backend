import { createRoute } from "@hono/zod-openapi";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { generateToken, hashToken, requireUser, SESSION_TTL } from "../lib/auth";
import { sendLoginCode } from "../lib/email";
import { LOGIN_CODE_TTL, generateLoginCode, normalizeLoginCode } from "../lib/login-code";
import { bearerAuth, createApp, errors, json } from "../lib/openapi";
import { publicUser } from "../lib/util";
import { AuthSessionSchema, EmailStartSchema, EmailVerifyLinkSchema, EmailVerifySchema } from "../schemas";
import type { AppEnv, UserRow } from "../types";

const auth = createApp();
const tags = ["Auth"];

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

// ---------- Start ----------

const startRoute = createRoute({
  method: "post",
  path: "/email/start",
  tags,
  summary: "Request a login code by email",
  description:
    "Sends a 6-character code (letters and digits, no 0/O/1/I/L; valid 5 minutes, 5 attempts) and, only when `linkChallenge` is sent, " +
    "a magic link for the same attempt (`<LOGIN_LINK_URL>#t=<token>&e=<email>`, see `/auth/email/verify-link`), bound to that challenge. " +
    "Using either one consumes both. A new request invalidates the previous codes. " +
    "Rate limited per email and per IP. Works for new and existing users alike.",
  request: { body: { content: { "application/json": { schema: EmailStartSchema } }, required: true } },
  responses: { 204: { description: "Code sent" }, ...errors(400, 429, 502) },
});

auth.openapi(startRoute, async (c) => {
  const { email, linkChallenge } = c.req.valid("json");
  const now = Date.now();
  const ip = c.req.header("cf-connecting-ip") ?? null;
  const tooMany = () => new HTTPException(429, { message: "Esperá un momento antes de pedir otro código" });

  const count = async (column: "email" | "ip", value: string, since: number) =>
    (
      await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM auth_codes WHERE ${column} = ? AND created_at > ?`)
        .bind(value, since)
        .first<{ n: number }>()
    )?.n ?? 0;

  if ((await count("email", email, now - EMAIL_MIN_GAP)) > 0) throw tooMany();
  if ((await count("email", email, now - HOUR)) >= EMAIL_PER_HOUR) throw tooMany();
  if (ip && (await count("ip", ip, now - HOUR)) >= IP_PER_HOUR) throw tooMany();

  const isReview = !!c.env.REVIEW_EMAIL && !!c.env.REVIEW_CODE && email === c.env.REVIEW_EMAIL.trim().toLowerCase();
  const code = isReview ? c.env.REVIEW_CODE! : generateLoginCode();
  // No challenge (old app builds): no magic link at all, only the code.
  const linkToken = linkChallenge ? generateToken() : null;
  const id = crypto.randomUUID();

  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE auth_codes SET used_at = ? WHERE email = ? AND used_at IS NULL").bind(now, email),
    c.env.DB.prepare(
      "INSERT INTO auth_codes (id, email, code_hash, link_hash, link_challenge, ip, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      id,
      email,
      await codeHash(email, code),
      linkToken ? await hashToken(linkToken) : null,
      linkToken ? linkChallenge : null,
      ip,
      now,
      now + LOGIN_CODE_TTL,
    ),
  ]);

  if (!isReview) {
    try {
      await sendLoginCode(c.env, email, code, linkToken);
    } catch (err) {
      console.error(err);
      // Don't burn the user's rate limit for an email we couldn't send.
      await c.env.DB.prepare("DELETE FROM auth_codes WHERE id = ?").bind(id).run();
      throw new HTTPException(502, { message: "No pudimos mandar el email, probá de nuevo" });
    }
  }
  return c.body(null, 204);
});

// ---------- Verify ----------

const verifyRoute = createRoute({
  method: "post",
  path: "/email/verify",
  tags,
  summary: "Exchange the emailed code for a session token",
  description:
    "Creates the user on the first successful verification. `isNew` is true while the user has no name. " +
    "The code is case-insensitive and spaces or dashes are ignored; a malformed code is answered like a wrong one.",
  request: { body: { content: { "application/json": { schema: EmailVerifySchema } }, required: true } },
  responses: { 200: json(AuthSessionSchema, "Signed in"), ...errors(400) },
});

auth.openapi(verifyRoute, async (c) => {
  const { email, code: typed } = c.req.valid("json");
  const now = Date.now();
  const code = normalizeLoginCode(typed);
  if (code === null) throw new HTTPException(400, { message: "Código incorrecto" });
  const expired = () => new HTTPException(400, { message: "El código venció, pedí uno nuevo" });

  const row = await takeAttempt(c, email, now);
  if (!row) throw expired();

  if (row.code_hash !== (await codeHash(email, code))) {
    throw new HTTPException(400, { message: "Código incorrecto" });
  }

  if (!(await consume(c, row.id, now))) throw expired();
  return c.json(await signIn(c, email, now), 200);
});

// ---------- Verify link ----------

const verifyLinkRoute = createRoute({
  method: "post",
  path: "/email/verify-link",
  tags,
  summary: "Exchange the emailed magic-link token for a session token",
  description:
    "Same result as `/auth/email/verify`, with the token from the link's fragment instead of the code. Needs the `verifier` whose " +
    "SHA-256 was sent as `linkChallenge` to `/auth/email/start`: the link only signs in the phone that asked for it. Shares the code's " +
    "expiry, attempts and single use: a wrong or missing token or verifier uses up an attempt, and after the link or the code is used " +
    "neither works again. Attempts started without a challenge have no link, so this always fails for them. " +
    "Every failure answers the same 400. Only POST: the token is never accepted in a URL.",
  request: { body: { content: { "application/json": { schema: EmailVerifyLinkSchema } }, required: true } },
  responses: { 200: json(AuthSessionSchema, "Signed in"), ...errors(400) },
});

auth.openapi(verifyLinkRoute, async (c) => {
  const { email, token, verifier } = c.req.valid("json");
  const now = Date.now();
  const invalid = () => new HTTPException(400, { message: LINK_ERROR });
  if (!LINK_TOKEN.test(token)) throw invalid();

  // Take the attempt before checking the verifier, so a wrong or missing one counts as a failure too.
  const row = await takeAttempt(c, email, now);
  if (!row || !row.link_hash || !row.link_challenge) throw invalid();
  const tokenOk = timingSafeEqual(row.link_hash, await hashToken(token));
  const verifierOk =
    verifier !== undefined && LINK_VERIFIER.test(verifier) && timingSafeEqual(row.link_challenge, await linkChallengeOf(verifier));
  if (!tokenOk || !verifierOk) throw invalid();
  if (!(await consume(c, row.id, now))) throw invalid();
  return c.json(await signIn(c, email, now), 200);
});

/**
 * Consumes one attempt of the email's current login code atomically *before* comparing, so concurrent
 * requests can't all slip past the attempt limit. Null when there is no usable code.
 */
async function takeAttempt(c: Context<AppEnv>, email: string, now: number) {
  return c.env.DB.prepare(
    `UPDATE auth_codes SET attempts = attempts + 1
     WHERE id = (SELECT id FROM auth_codes WHERE email = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1)
       AND used_at IS NULL AND attempts < ? AND expires_at > ?
     RETURNING id, code_hash, link_hash, link_challenge`,
  )
    .bind(email, MAX_ATTEMPTS, now)
    .first<{ id: string; code_hash: string; link_hash: string | null; link_challenge: string | null }>();
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
async function consume(c: Context<AppEnv>, id: string, now: number): Promise<boolean> {
  const used = await c.env.DB.prepare("UPDATE auth_codes SET used_at = ? WHERE id = ? AND used_at IS NULL").bind(now, id).run();
  return used.meta.changes === 1;
}

/** Creates the user on first sign-in and a new session. */
async function signIn(c: Context<AppEnv>, email: string, now: number) {
  await c.env.DB.prepare("INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .bind(crypto.randomUUID(), email, now)
    .run();
  const user = (await c.env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<UserRow>())!;

  const token = generateToken();
  await c.env.DB.prepare(
    "INSERT INTO sessions (id, user_id, token_hash, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(crypto.randomUUID(), user.id, await hashToken(token), now, now, now + SESSION_TTL)
    .run();

  return { token, user: publicUser(user), isNew: user.name === null || user.username === null };
}

// ---------- Logout ----------

const logoutRoute = createRoute({
  method: "post",
  path: "/logout",
  tags,
  summary: "Sign out (deletes the current session)",
  security: bearerAuth,
  middleware: [requireUser] as const,
  responses: { 204: { description: "Signed out" }, ...errors(401) },
});

auth.openapi(logoutRoute, async (c) => {
  // The session's push tokens go with it (explicit, besides the FK cascade): the phone stops getting this account's pushes.
  const sessionId = c.get("sessionId");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM push_tokens WHERE session_id = ?").bind(sessionId),
    c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId),
  ]);
  return c.body(null, 204);
});

export default auth;
