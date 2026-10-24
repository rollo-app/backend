import { Hono } from "hono";
import type { AppEnv } from "../../types";
import * as controller from "./admin.controller";

/**
 * Operator endpoints (curl with ADMIN_TOKEN). A plain Hono app on purpose: it is not part of openapi.json.
 * Every failure to authenticate is a 404, so the routes look like they do not exist.
 */
const admin = new Hono<AppEnv>();

const sha256 = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

/** Constant-time comparison: both sides are hashed to equal-length digests first. */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

admin.use("*", async (c, next) => {
  const token = c.env.ADMIN_TOKEN;
  const header = c.req.header("authorization") ?? "";
  // Always compare, so timing does not depend on whether the header is present.
  const ok = await safeEqual(header, `Bearer ${token ?? ""}`);
  if (!token || !ok) return c.json({ error: "No encontrado" }, 404);
  return next();
});

admin.delete("/media/:mediaId", controller.deleteMedia);
admin.delete("/users/:userId", controller.deleteUser);
admin.get("/reports", controller.listReports);

export default admin;
