import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { AppEnv, MemberRow, TripRow } from "../types";

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

/**
 * Requires `Authorization: Bearer <token>`. Loads the member and their trip into the context.
 * If the route has `:tripId`, checks that the token belongs to that trip.
 */
export const requireMember = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new HTTPException(401, { message: "Falta el token" });

  const member = await c.env.DB.prepare(
    `SELECT id, trip_id, name, role FROM members
     WHERE token_hash = ? AND removed_at IS NULL`,
  )
    .bind(await hashToken(token))
    .first<MemberRow>();
  if (!member) throw new HTTPException(401, { message: "Token inválido" });

  const tripId = c.req.param("tripId");
  if (tripId && tripId !== member.trip_id) {
    throw new HTTPException(403, { message: "No sos parte de este viaje" });
  }

  const trip = await c.env.DB.prepare("SELECT * FROM trips WHERE id = ?")
    .bind(member.trip_id)
    .first<TripRow>();
  if (!trip) throw new HTTPException(404, { message: "Viaje no encontrado" });

  c.set("member", member);
  c.set("trip", trip);
  await next();
});

/** Use after requireMember. */
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get("member").role !== "admin") {
    throw new HTTPException(403, { message: "Solo el admin del viaje puede hacer esto" });
  }
  await next();
});
