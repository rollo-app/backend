import type { Context } from "hono";
import type { AppEnv } from "../../types";
import type { ReportRow } from "./admin.repository";
import * as service from "./admin.service";

type Person = { id: string; name: string | null; username: string | null; email: string };

const person = (id: string, name: string | null, username: string | null, email: string): Person => ({ id, name, username, email });

function presentReport(r: ReportRow) {
  return {
    id: r.id,
    reason: r.reason,
    createdAt: r.created_at,
    reporter: person(r.rid, r.rname, r.runame, r.remail),
    target: person(r.tid, r.tname, r.tuname, r.temail),
    mediaId: r.media_id,
    tripId: r.trip_id,
  };
}

export async function deleteMedia(c: Context<AppEnv>) {
  await service.deleteMedia(c.env, c.req.param("mediaId")!);
  return c.body(null, 204);
}

export async function deleteUser(c: Context<AppEnv>) {
  await service.deleteUser(c.env, c.req.param("userId")!);
  return c.body(null, 204);
}

export async function listReports(c: Context<AppEnv>) {
  const raw = Number(c.req.query("limit") ?? 50);
  const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, 200) : 50;
  const reports = await service.listReports(c.env.DB, limit);
  return c.json({ reports: reports.map(presentReport) });
}

export function me(c: Context<AppEnv>) {
  const user = c.get("adminUser");
  if (!user) return c.json({ id: null, email: null, name: null, appRole: "token" });
  return c.json({ id: user.id, email: user.email, name: user.name, appRole: user.app_role });
}
