import { createRoute } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { generateToken, hashToken, requireUser } from "../lib/auth";
import { sendLoginCode } from "../lib/email";
import { bearerAuth, createApp, errors, json } from "../lib/openapi";
import { publicUser } from "../lib/util";
import { AuthSessionSchema, EmailStartSchema, EmailVerifySchema } from "../schemas";
import type { UserRow } from "../types";

const auth = createApp();
const tags = ["Auth"];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CODE_TTL = 10 * MINUTE;
const MAX_ATTEMPTS = 5;
const SESSION_TTL = 365 * 24 * HOUR;
const EMAIL_MIN_GAP = MINUTE;
const EMAIL_PER_HOUR = 5;
const IP_PER_HOUR = 20;

const codeHash = (email: string, code: string) => hashToken(`${email}:${code}`);

function randomCode(): string {
  const n = new Uint32Array(1);
  crypto.getRandomValues(n);
  return String(n[0]! % 1_000_000).padStart(6, "0");
}

// ---------- Start ----------

const startRoute = createRoute({
  method: "post",
  path: "/email/start",
  tags,
  summary: "Request a login code by email",
  description:
    "Sends a 6-digit code (valid 10 minutes, 5 attempts). A new request invalidates the previous codes. " +
    "Rate limited per email and per IP. Works for new and existing users alike.",
  request: { body: { content: { "application/json": { schema: EmailStartSchema } }, required: true } },
  responses: { 204: { description: "Code sent" }, ...errors(400, 429, 502) },
});

auth.openapi(startRoute, async (c) => {
  const { email } = c.req.valid("json");
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
  const code = isReview ? c.env.REVIEW_CODE! : randomCode();
  const id = crypto.randomUUID();

  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE auth_codes SET used_at = ? WHERE email = ? AND used_at IS NULL").bind(now, email),
    c.env.DB.prepare(
      "INSERT INTO auth_codes (id, email, code_hash, ip, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id, email, await codeHash(email, code), ip, now, now + CODE_TTL),
  ]);

  if (!isReview) {
    try {
      await sendLoginCode(c.env, email, code);
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
  description: "Creates the user on the first successful verification. `isNew` is true while the user has no name.",
  request: { body: { content: { "application/json": { schema: EmailVerifySchema } }, required: true } },
  responses: { 200: json(AuthSessionSchema, "Signed in"), ...errors(400) },
});

auth.openapi(verifyRoute, async (c) => {
  const { email, code } = c.req.valid("json");
  const now = Date.now();
  const expired = () => new HTTPException(400, { message: "El código venció, pedí uno nuevo" });

  // Each guess consumes one attempt atomically *before* comparing, so concurrent requests
  // can't all slip past the attempt limit.
  const row = await c.env.DB.prepare(
    `UPDATE auth_codes SET attempts = attempts + 1
     WHERE id = (SELECT id FROM auth_codes WHERE email = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1)
       AND used_at IS NULL AND attempts < ? AND expires_at > ?
     RETURNING id, code_hash`,
  )
    .bind(email, MAX_ATTEMPTS, now)
    .first<{ id: string; code_hash: string }>();
  if (!row) throw expired();

  if (row.code_hash !== (await codeHash(email, code))) {
    throw new HTTPException(400, { message: "Código incorrecto" });
  }

  // Single use, even with concurrent requests: only one verify can flip used_at.
  const used = await c.env.DB.prepare("UPDATE auth_codes SET used_at = ? WHERE id = ? AND used_at IS NULL")
    .bind(now, row.id)
    .run();
  if (used.meta.changes !== 1) throw expired();

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

  return c.json({ token, user: publicUser(user), isNew: user.name === null || user.username === null }, 200);
});

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
  await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(c.get("sessionId")).run();
  return c.body(null, 204);
});

export default auth;
