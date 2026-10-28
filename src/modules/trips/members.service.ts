import { CREATOR_ONLY, isCreator } from "../../lib/creator";
import { actorName, sendPush } from "../../lib/push";
import { isRevealed, publicMember } from "../../lib/util";
import type { AfterResponse } from "../../shared/after-response";
import { badRequest, conflict, forbidden, notFound } from "../../shared/errors";
import type { Env, MemberRow, Role, TripRow, UserRow } from "../../types";
import { deleteFeaturedByOthersOfMember } from "../featured/featured.repository";
import { blockedIdsFor } from "../blocks/blocks.service";
import { areFriends } from "../friends/friends.service";
import * as repo from "./trips.repository";

export function requireName(user: Pick<UserRow, "name" | "username">) {
  if (!user.name) throw conflict("Completá tu nombre en el perfil");
  if (!user.username) throw conflict("Elegí tu nombre de usuario en el perfil");
}

// ---------- Membership ----------

type AddResult =
  | { status: "added"; member: Pick<MemberRow, "id" | "user_id" | "role"> }
  | { status: "already_member"; member: MemberRow }
  | { status: "removed" };

/**
 * Single place where someone becomes a member of a trip (by code or added by a friend).
 * An active member stays as is; someone who left gets their old membership back (same id, so their
 * photos stay linked); someone the admin removed only comes back when `reactivateRemoved` is set
 * (an admin adding them as a friend). Does not check the reveal.
 */
async function addMember(
  db: D1Database,
  tripId: string,
  userId: string,
  addedBy: string | null,
  now = Date.now(),
  reactivateRemoved = false,
): Promise<AddResult> {
  const existing = await repo.findMember(db, tripId, userId);
  if (existing) {
    if (existing.removed_at !== null) {
      if (!reactivateRemoved) return { status: "removed" };
      await repo.reactivateRemovedMember(db, existing.id, addedBy).run();
      return { status: "added", member: existing };
    }
    if (existing.left_at === null) return { status: "already_member", member: existing };
    await repo.reactivateLeftMember(db, existing.id, addedBy).run();
    return { status: "added", member: existing };
  }
  const member = { id: crypto.randomUUID(), user_id: userId, role: "member" as Role };
  await repo.insertMember(db, member.id, tripId, userId, now, addedBy).run();
  return { status: "added", member };
}

// ---------- Join ----------

/** Joins by invite code. `created` is false when `user` was already an active member. */
export async function joinTrip(
  db: D1Database,
  user: UserRow,
  code: string,
): Promise<{ created: boolean; trip: TripRow; member: Pick<MemberRow, "id" | "user_id" | "role"> }> {
  requireName(user);
  const now = Date.now();

  const trip = await repo.findTripByJoinCode(db, code);
  if (!trip) throw notFound("Código inválido");

  // Active members are answered before the reveal check (they get 200 even after it).
  const current = await repo.findMember(db, trip.id, user.id);
  if (current?.removed_at != null) throw forbidden("El admin te sacó de este rollo");
  if (current && current.left_at === null) return { created: false, trip, member: current };

  if (isRevealed(trip, now)) throw conflict("Este rollo ya se reveló");

  const added = await addMember(db, trip.id, user.id, null, now);
  if (added.status !== "added") throw forbidden("El admin te sacó de este rollo");
  return { created: true, trip, member: added.member };
}

// ---------- Add friends ----------

export type AddMembersResult = { userId: string; status: "added" | "already_member" | "unavailable" };

/** Adds `friendIds` (a result per friend) and returns the "added to a rollo" push for those who were added. */
export async function addFriendsToTrip(
  env: Env,
  trip: TripRow,
  me: UserRow,
  myRole: Role,
  friendIds: string[],
): Promise<{ results: AddMembersResult[]; notify: AfterResponse }> {
  if (isRevealed(trip)) throw conflict("Este rollo ya se reveló");

  const results: AddMembersResult[] = [];
  for (const userId of new Set(friendIds)) {
    if (userId === me.id) {
      results.push({ userId, status: "already_member" });
      continue;
    }
    if (!(await areFriends(env.DB, me.id, userId))) {
      results.push({ userId, status: "unavailable" });
      continue;
    }
    const added = await addMember(env.DB, trip.id, userId, me.id, Date.now(), myRole === "admin");
    results.push({ userId, status: added.status === "removed" ? "unavailable" : added.status });
  }
  const addedIds = results.filter((r) => r.status === "added").map((r) => r.userId);
  const notify: AfterResponse = addedIds.length
    ? () => sendPush(env, addedIds, "addedToTrip", { body: `${actorName(me)} te sumó a ${trip.name}`, url: `/roll?trip=${trip.id}` }, { actorId: me.id })
    : null;
  return { results, notify };
}

// ---------- My membership ----------

/**
 * Whether others may feature my photos of this rollo. Turning it off removes them from other profiles
 * (mine stay); turning it on restores nothing.
 */
async function setMyFeaturing(db: D1Database, member: MemberRow, allow: boolean): Promise<void> {
  await db.batch([
    repo.setMemberAllowFeaturing(db, member.id, allow),
    ...(allow ? [] : [deleteFeaturedByOthersOfMember(db, member.id, member.user_id)]),
  ]);
}

/** Applies the given fields of my membership; archiving is only for revealed rollos and only affects me. */
export async function updateMyMembership(
  db: D1Database,
  trip: TripRow,
  member: MemberRow,
  patch: { allowFeaturing?: boolean; archived?: boolean },
): Promise<{ allowFeaturing: boolean; archived: boolean }> {
  if (patch.archived !== undefined && !isRevealed(trip)) throw conflict("Solo podés archivar rollos revelados");
  if (patch.allowFeaturing !== undefined) await setMyFeaturing(db, member, patch.allowFeaturing);
  if (patch.archived !== undefined) await repo.setMemberArchived(db, member.id, patch.archived ? Date.now() : null).run();
  return {
    allowFeaturing: patch.allowFeaturing ?? member.allow_featuring !== 0,
    archived: patch.archived ?? member.archived_at !== null,
  };
}

// ---------- Leave ----------

/** The creator can't leave; any other admin can (and comes back as a regular member). */
export async function leaveTrip(db: D1Database, trip: TripRow, member: MemberRow): Promise<void> {
  if (isCreator(trip, member.user_id)) throw conflict("Creaste este rollo: no podés salirte");
  await repo.markLeft(db, member.id, Date.now()).run();
}

// ---------- Remove member (admin) ----------

/** Admins remove regular members; only the creator removes other admins; nobody removes the creator. */
export async function removeMember(db: D1Database, trip: TripRow, actor: MemberRow, memberId: string): Promise<void> {
  if (memberId === actor.id) throw badRequest("No te podés sacar a vos mismo");
  const target = await repo.findActiveMemberById(db, trip.id, memberId);
  if (target) {
    if (isCreator(trip, target.user_id)) throw forbidden("No podés sacar a quien creó el rollo");
    if (target.role === "admin" && !isCreator(trip, actor.user_id)) throw forbidden(CREATOR_ONLY);
  }
  const res = await repo.markRemoved(db, memberId, trip.id, Date.now()).run();
  if (!res.meta.changes) throw notFound("Miembro no encontrado");
}

// ---------- Admin role ----------

/** Any admin makes an active member admin (already admin: no change). */
export async function makeAdmin(db: D1Database, trip: TripRow, memberId: string): Promise<MemberRow> {
  const target = await repo.findActiveMemberById(db, trip.id, memberId);
  if (!target) throw notFound("Miembro no encontrado");
  if (target.role !== "admin") await repo.setMemberRole(db, target.id, "admin").run();
  return { ...target, role: "admin" };
}

/** Only the creator takes the admin role away; their own is permanent. */
export async function removeAdmin(db: D1Database, trip: TripRow, memberId: string): Promise<MemberRow> {
  const target = await repo.findActiveMemberById(db, trip.id, memberId);
  if (!target) throw notFound("Miembro no encontrado");
  if (isCreator(trip, target.user_id)) throw badRequest("El creador siempre es admin");
  if (target.role === "admin") await repo.setMemberRole(db, target.id, "member").run();
  return { ...target, role: "member" };
}

/** Public shape of `target` as `viewerId` sees it. */
export async function memberView(db: D1Database, trip: TripRow, viewerId: string, target: MemberRow) {
  const [user, blocked] = await Promise.all([repo.findUserCard(db, target.user_id), blockedIdsFor(db, viewerId)]);
  return publicMember(target, user ?? { name: null, username: null, avatar_key: null }, blocked.has(target.user_id), isCreator(trip, target.user_id));
}
