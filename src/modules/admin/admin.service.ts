import { deleteAccount } from "../../lib/account";
import { notFound } from "../../shared/errors";
import type { Env } from "../../types";
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
