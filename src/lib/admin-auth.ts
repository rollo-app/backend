import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../types";
import { findSessionUser } from "./auth";

const sha256 = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

/** Constant-time comparison: both sides are hashed to equal-length digests first. */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

/**
 * Guards `/admin/*`. Accepts `Bearer <ADMIN_TOKEN>` and, with `session: true`, also the session of a superadmin.
 * Sets `adminUser` (null for the token). Every failure is a 404, so the routes look like they do not exist.
 */
export function adminAuth(opts: { session: boolean }) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const token = c.env.ADMIN_TOKEN;
    const header = c.req.header("authorization") ?? "";
    // Always compare, so timing does not depend on whether the header is present.
    const isToken = await safeEqual(header, `Bearer ${token ?? ""}`);
    if (token && isToken) {
      c.set("adminUser", null);
      return next();
    }
    if (opts.session && header.startsWith("Bearer ")) {
      const session = await findSessionUser(c.env.DB, header.slice(7).trim(), Date.now());
      if (session && session.app_role === "superadmin") {
        const { session_id: _s, last_used_at: _l, ...user } = session;
        c.set("adminUser", user);
        return next();
      }
    }
    return c.json({ error: "No encontrado" }, 404);
  });
}
