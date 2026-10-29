import { deleteAccount } from "../account/account.service";
import { DEGRADED_KEY, resetDegradedCache } from "../../lib/degraded";
import { notFound } from "../../shared/errors";
import type { Env, UserRow } from "../../types";
import { deleteTripMedia } from "../media/media.service";
import { type Page, type PageQuery, paginate } from "../../lib/paging";
import { prepareProfileUpdate, withUsernameConflict } from "../me/me.service";
import type { AdminEditUser } from "./admin.schemas";
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

export function listUsers(db: D1Database, query: PageQuery): Promise<Page<repo.AdminUserRow>> {
  return paginate<repo.AdminUserRow>(
    {
      rows: ({ orderBy, limit, offset }) => repo.listUsers(db, { q: query.q, orderBy, limit, offset }),
      count: () => repo.countUsers(db, { q: query.q }),
      sortable: repo.userSortable,
      defaultSort: "createdAt",
    },
    query,
  );
}

export type TripState = "upcoming" | "open" | "ended" | "revealed";

export function tripState(t: Pick<repo.UserTripRow, "startsAt" | "endsAt" | "revealAt" | "revealedAt">, now: number): TripState {
  if (t.revealedAt !== null || t.revealAt <= now) return "revealed";
  if (t.startsAt > now) return "upcoming";
  if (t.endsAt < now) return "ended";
  return "open";
}

export async function getUser(db: D1Database, id: string, now: number) {
  const user = await repo.findAdminUser(db, id);
  if (!user) throw notFound();
  const trips = await repo.listUserTrips(db, id);
  return { ...user, trips: trips.map((t) => ({ id: t.id, name: t.name, role: t.role, state: tripState(t, now) })) };
}

/** Edits another account: profile fields with the same rules as `PATCH /me`, plus the badge and the rollo-limit exemption, in one atomic batch. */
export async function editUser(db: D1Database, id: string, patch: AdminEditUser, now: number) {
  const user = await repo.findUser(db, id);
  if (!user) throw notFound();
  const { badge, unlimitedRollos, ...profile } = patch;
  const statements: D1PreparedStatement[] = [];
  if (profile.name !== undefined || profile.username !== undefined || profile.bio !== undefined) {
    statements.push((await prepareProfileUpdate(db, user, profile)).statement);
  }
  if (badge !== undefined || unlimitedRollos !== undefined) statements.push(repo.updateUserFlags(db, id, { badge, unlimitedRollos }));
  await withUsernameConflict(() => db.batch(statements));
  return getUser(db, id, now);
}
