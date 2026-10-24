import { Hono } from "hono";
import { deleteAccount } from "../lib/account";
import { deleteTripMedia } from "../modules/media/media.service";
import type { AppEnv, UserRow } from "../types";

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

admin.delete("/media/:mediaId", async (c) => {
  if (!(await deleteTripMedia(c.env, c.req.param("mediaId")))) return c.json({ error: "No encontrado" }, 404);
  return c.body(null, 204);
});

admin.delete("/users/:userId", async (c) => {
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(c.req.param("userId")).first<UserRow>();
  if (!user) return c.json({ error: "No encontrado" }, 404);
  await deleteAccount(c.env, user);
  return c.body(null, 204);
});

type Person = { id: string; name: string | null; username: string | null; email: string };
type ReportRow = {
  id: string;
  reason: string;
  created_at: number;
  media_id: string | null;
  trip_id: string | null;
  rid: string;
  rname: string | null;
  runame: string | null;
  remail: string;
  tid: string;
  tname: string | null;
  tuname: string | null;
  temail: string;
};

admin.get("/reports", async (c) => {
  const raw = Number(c.req.query("limit") ?? 50);
  const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, 200) : 50;
  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.reason, r.created_at, r.media_id, r.trip_id,
            rep.id AS rid, rep.name AS rname, rep.username AS runame, rep.email AS remail,
            tgt.id AS tid, tgt.name AS tname, tgt.username AS tuname, tgt.email AS temail
     FROM reports r JOIN users rep ON rep.id = r.reporter_id JOIN users tgt ON tgt.id = r.target_user_id
     ORDER BY r.created_at DESC, r.id DESC LIMIT ?`,
  )
    .bind(limit)
    .all<ReportRow>();
  const person = (id: string, name: string | null, username: string | null, email: string): Person => ({ id, name, username, email });
  return c.json({
    reports: results.map((r) => ({
      id: r.id,
      reason: r.reason,
      createdAt: r.created_at,
      reporter: person(r.rid, r.rname, r.runame, r.remail),
      target: person(r.tid, r.tname, r.tuname, r.temail),
      mediaId: r.media_id,
      tripId: r.trip_id,
    })),
  });
});

export default admin;
