import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { AppEnv, MemberRow, TripRow, UserRow } from "../types";

/** Random 256-bit token in base64url. Handed to the phone only once. */
export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Only the hash is stored in the DB: if it leaks, the tokens are useless. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const SESSION_TOUCH_INTERVAL = 60 * 60_000;

/**
 * Requires `Authorization: Bearer <token>` of a valid session. Loads the user into the context.
 * `last_used_at` is refreshed at most once per hour.
 */
export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new HTTPException(401, { message: "Falta el token" });

  const now = Date.now();
  const row = await c.env.DB.prepare(
    `SELECT s.id AS session_id, s.last_used_at, u.id, u.email, u.name, u.username, u.avatar_key, u.pending_avatar_key, u.created_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  )
    .bind(await hashToken(token), now)
    .first<UserRow & { session_id: string; last_used_at: number }>();
  if (!row) throw new HTTPException(401, { message: "Sesión inválida, volvé a entrar" });

  if (now - row.last_used_at > SESSION_TOUCH_INTERVAL) {
    await c.env.DB.prepare("UPDATE sessions SET last_used_at = ? WHERE id = ?").bind(now, row.session_id).run();
  }

  const { session_id, last_used_at: _, ...user } = row;
  c.set("user", user);
  c.set("sessionId", session_id);
  await next();
});

async function loadTripAndMember(c: Context<AppEnv>, tripId: string, notMember: () => HTTPException) {
  const trip = await c.env.DB.prepare("SELECT * FROM trips WHERE id = ?").bind(tripId).first<TripRow>();
  if (!trip) throw new HTTPException(404, { message: "Rollo no encontrado" });
  const member = await c.env.DB.prepare(
    "SELECT * FROM members WHERE trip_id = ? AND user_id = ? AND removed_at IS NULL",
  )
    .bind(tripId, c.get("user").id)
    .first<MemberRow>();
  if (!member) throw notMember();
  c.set("trip", trip);
  c.set("member", member);
}

/** Use after requireUser on routes with `{tripId}`: the user must be an active member of that trip. */
export const requireTripMember = createMiddleware<AppEnv>(async (c, next) => {
  await loadTripAndMember(c, c.req.param("tripId")!, () => new HTTPException(403, { message: "No sos parte de este rollo" }));
  await next();
});

/**
 * Use after requireUser on routes with `{mediaId}` and no trip: the trip is resolved from the media row
 * and the user must be an active member of it. Anything else looks like "not found".
 */
export const requireMediaMember = createMiddleware<AppEnv>(async (c, next) => {
  const row = await c.env.DB.prepare("SELECT trip_id FROM media WHERE id = ?")
    .bind(c.req.param("mediaId"))
    .first<{ trip_id: string }>();
  const notFound = () => new HTTPException(404, { message: "No encontrado" });
  if (!row) throw notFound();
  await loadTripAndMember(c, row.trip_id, notFound);
  await next();
});

/** Use after requireTripMember or requireMediaMember. */
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get("member").role !== "admin") {
    throw new HTTPException(403, { message: "Solo el admin del rollo puede hacer esto" });
  }
  await next();
});
