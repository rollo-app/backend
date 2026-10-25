import { deleteAccount } from "../../lib/account";
import { notFound } from "../../shared/errors";
import type { Deps } from "../../container";
import { deleteTripMedia } from "../media/media.service";
import * as repo from "./admin.repository";

export async function deleteMedia(deps: Pick<Deps, "db" | "storage">, mediaId: string): Promise<void> {
  if (!(await deleteTripMedia(deps, mediaId))) throw notFound();
}

export async function deleteUser(deps: Pick<Deps, "db" | "storage">, userId: string): Promise<void> {
  const user = await repo.findUser(deps.db, userId);
  if (!user) throw notFound();
  await deleteAccount(deps, user);
}

export function listReports(db: D1Database, limit: number): Promise<repo.ReportRow[]> {
  return repo.listReports(db, limit);
}
