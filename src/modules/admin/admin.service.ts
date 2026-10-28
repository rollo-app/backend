import { deleteAccount } from "../account/account.service";
import { DEGRADED_KEY, resetDegradedCache } from "../../lib/degraded";
import { notFound } from "../../shared/errors";
import type { Env, UserRow } from "../../types";
import { deleteTripMedia } from "../media/media.service";
import * as repo from "./admin.repository";

export async function deleteMedia(env: Env, mediaId: string): Promise<void> {
  if (!(await deleteTripMedia(env, mediaId))) throw notFound();
}

export async function deleteUser(env: Env, userId: string): Promise<void> {
  const user = await repo.findUser(env.DB, userId);
  if (!user) throw notFound();
  await deleteAccount(env, user);
}

export function listReports(db: D1Database, limit: number): Promise<repo.ReportRow[]> {
  return repo.listReports(db, limit);
}

export type DegradedMode = { on: boolean; updatedAt: number | null; updatedBy: { id: string; email: string } | null };

export async function getDegradedMode(db: D1Database): Promise<DegradedMode> {
  const s = await repo.getSetting(db, DEGRADED_KEY);
  if (!s) return { on: false, updatedAt: null, updatedBy: null };
  const updatedBy = s.updatedByUserId ? await repo.findUserEmail(db, s.updatedByUserId) : null;
  return { on: s.value === "1", updatedAt: s.updatedAt, updatedBy };
}

export async function setDegradedMode(db: D1Database, on: boolean, actor: UserRow | null): Promise<DegradedMode> {
  await repo.setSetting(db, { key: DEGRADED_KEY, value: on ? "1" : "0", updatedAt: Date.now(), updatedByUserId: actor?.id ?? null }).run();
  resetDegradedCache();
  return getDegradedMode(db);
}
