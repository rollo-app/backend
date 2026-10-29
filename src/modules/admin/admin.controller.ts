import type { Context } from "hono";
import type { AppEnv } from "../../types";
import type { ReportRow } from "./admin.repository";
import { getUsage as readUsage } from "../../lib/cf-usage";
import { storageLimitBytes, storageUsage } from "../../lib/storage";
import { badRequest } from "../../shared/errors";
import { getMetrics as readMetrics } from "../metrics/metrics.service";
import { PageQuerySchema } from "../../lib/paging";
import { AdminEditUserSchema, DegradedModeBodySchema, MetricsQuerySchema } from "./admin.schemas";
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

export async function getDegradedMode(c: Context<AppEnv>) {
  return c.json(await service.getDegradedMode(c.env.DB));
}

export async function setDegradedMode(c: Context<AppEnv>) {
  const parsed = DegradedModeBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw badRequest("Cuerpo inválido");
  return c.json(await service.setDegradedMode(c.env.DB, parsed.data.on, c.get("adminUser")));
}

export async function getMetrics(c: Context<AppEnv>) {
  const parsed = MetricsQuerySchema.safeParse({ days: c.req.query("days") });
  if (!parsed.success) throw badRequest("Parámetros inválidos");
  return c.json(await readMetrics(c.env.DB, parsed.data.days));
}

export async function getUsage(c: Context<AppEnv>) {
  const [usage, usedBytes] = await Promise.all([readUsage(c.env.DB), storageUsage(c.env)]);
  return c.json({ usage, storage: { usedBytes, limitBytes: storageLimitBytes(c.env) } });
}

export async function listUsers(c: Context<AppEnv>) {
  const parsed = PageQuerySchema.safeParse(c.req.query());
  if (!parsed.success) throw badRequest("Parámetros inválidos");
  return c.json(await service.listUsers(c.env.DB, parsed.data));
}

export async function getUser(c: Context<AppEnv>) {
  return c.json(await service.getUser(c.env.DB, c.req.param("id")!, Date.now()));
}

export async function editUser(c: Context<AppEnv>) {
  const parsed = AdminEditUserSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (!issue) throw badRequest("Cuerpo inválido");
    if (issue.code === "unrecognized_keys") throw badRequest(`Campo no editable: ${issue.keys[0]}`);
    const field = issue?.path.join(".");
    throw badRequest(issue.code === "custom" || !field ? issue.message : `${field}: ${issue.message}`);
  }
  if (Object.values(parsed.data).every((v) => v === undefined)) throw badRequest("Mandá al menos un campo para editar");
  return c.json(await service.editUser(c.env.DB, c.req.param("id")!, parsed.data, Date.now()));
}
