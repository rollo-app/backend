import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { AppEnv, MemberRow, TripRow } from "../types";

/** Token aleatorio de 256 bits en base64url. Se le da al celular una sola vez. */
export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** En la base solo guardamos el hash: si se filtra la DB, los tokens no sirven. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Exige `Authorization: Bearer <token>`. Carga el miembro y su viaje en el contexto.
 * Si la ruta tiene `:tripId`, valida que el token sea de ese viaje.
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

/** Usar después de requireMember. */
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get("member").role !== "admin") {
    throw new HTTPException(403, { message: "Solo el admin del viaje puede hacer esto" });
  }
  await next();
});
