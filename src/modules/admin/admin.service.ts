import { deleteAccount } from "../account/account.service";
import { DEGRADED_KEY, resetDegradedCache } from "../../lib/degraded";
import { REGISTRATIONS_CLOSED_KEY, resetRegistrationsCache } from "../../lib/registrations";
import { badRequest, notFound } from "../../shared/errors";
import { originalsExpireAt } from "../../lib/util";
import type { Env, UserRow } from "../../types";
import { deleteTripMedia } from "../media/media.service";
import { type Page, type PageQuery, paginate } from "../../lib/paging";
import { prepareProfileUpdate, withUsernameConflict } from "../me/me.service";
import type { AdminEditTrip, AdminEditUser } from "./admin.schemas";
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

export type RegistrationsSwitch = { open: boolean; updatedAt: number | null; updatedBy: { id: string; email: string } | null };

/** Registrations are open unless `registrations_closed` is "1" (no row = open). */
export async function getRegistrations(db: D1Database): Promise<RegistrationsSwitch> {
  const s = await repo.getSetting(db, REGISTRATIONS_CLOSED_KEY);
  if (!s) return { open: true, updatedAt: null, updatedBy: null };
  const updatedBy = s.updatedByUserId ? await repo.findUserEmail(db, s.updatedByUserId) : null;
  return { open: s.value !== "1", updatedAt: s.updatedAt, updatedBy };
}

export async function setRegistrations(db: D1Database, open: boolean, actor: UserRow | null): Promise<RegistrationsSwitch> {
  await repo.setSetting(db, { key: REGISTRATIONS_CLOSED_KEY, value: open ? "0" : "1", updatedAt: Date.now(), updatedByUserId: actor?.id ?? null }).run();
  resetRegistrationsCache();
  return getRegistrations(db);
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

export type TripStage = "upcoming" | "active" | "ended" | "revealed";

/** Same stages the app derives: revealed wins, then by the rollo's dates. */
export function tripStage(t: Pick<repo.AdminTripRow, "startsAt" | "endsAt" | "revealAt" | "revealedAt">, now: number): TripStage {
  if (t.revealedAt !== null || now >= t.revealAt) return "revealed";
  if (now < t.startsAt) return "upcoming";
  if (now > t.endsAt) return "ended";
  return "active";
}

function presentTrip({ revealedAt, keepOriginals, creatorId, creatorName, creatorUsername, ...t }: repo.AdminTripRow, now: number) {
  const stage = tripStage({ ...t, revealedAt }, now);
  return {
    ...t,
    keepOriginals: keepOriginals !== 0,
    originalsExpireAt: originalsExpireAt({ keep_originals: keepOriginals, revealed_at: revealedAt, reveal_at: t.revealAt }),
    revealed: stage === "revealed",
    stage,
    creator: creatorId ? { id: creatorId, name: creatorName, username: creatorUsername } : null,
  };
}

export async function listTrips(db: D1Database, query: PageQuery, now: number) {
  const q = query.q ? repo.tripSearch(query.q) : undefined;
  const page = await paginate<repo.AdminTripRow>(
    {
      rows: ({ orderBy, limit, offset }) => repo.listTrips(db, { search: q, orderBy, limit, offset }),
      count: () => repo.countTrips(db, { search: q }),
      sortable: repo.tripSortable,
      defaultSort: "createdAt",
    },
    query,
  );
  return { ...page, items: page.items.map((t) => presentTrip(t, now)) };
}

export async function getTrip(db: D1Database, tripId: string, now: number) {
  const trip = await repo.findAdminTrip(db, tripId);
  if (!trip) throw notFound();
  const members = await repo.listTripMembers(db, tripId);
  return { ...presentTrip(trip, now), members };
}

/**
 * Changes a rollo's member cap (a paid rollo/event gets more room; never below the people already in it) and/or
 * whether it keeps its originals (the paid pass will set the same flag later). The cap goes first, so an invalid one
 * rejects the request before anything is written. Turning `keepOriginals` on after the cron already purged some
 * originals restores nothing: it only stops further purges.
 */
export async function editTrip(db: D1Database, tripId: string, patch: AdminEditTrip, now: number) {
  const before = await repo.findTripCapacity(db, tripId);
  if (!before) throw notFound();
  if (patch.maxMembers !== undefined) {
    const tooLow = (active: number) =>
      badRequest(`El cupo no puede ser menor a la cantidad de participantes activos (${active}).`);
    if (patch.maxMembers < before.active) throw tooLow(before.active);
    const res = await repo.setTripMaxMembers(db, tripId, patch.maxMembers).run();
    const after = await repo.findTripCapacity(db, tripId);
    if (!after) throw notFound();
    // Zero changes with a valid value: someone joined between the read and the write.
    if (!res.meta.changes) throw tooLow(after.active);
  }
  if (patch.keepOriginals !== undefined) await repo.setTripKeepOriginals(db, tripId, patch.keepOriginals).run();
  return getTrip(db, tripId, now);
}
