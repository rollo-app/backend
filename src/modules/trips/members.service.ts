import { actorName, sendPush } from "../../lib/push";
import { isRevealed, publicTrip } from "../../lib/util";
import type { AfterResponse } from "../../shared/after-response";
import { badRequest, conflict, forbidden, notFound } from "../../shared/errors";
import type { Env, MemberRow, Role, TripRow, UserRow } from "../../types";
import { deleteFeaturedByOthersOfMember } from "../featured/featured.repository";
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

  if (publicTrip(trip, now).revealed) throw conflict("Este rollo ya se reveló");

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
export async function setMyFeaturing(db: D1Database, member: MemberRow, allow: boolean): Promise<void> {
  await db.batch([
    repo.setMemberAllowFeaturing(db, member.id, allow),
    ...(allow ? [] : [deleteFeaturedByOthersOfMember(db, member.id, member.user_id)]),
  ]);
}

// ---------- Leave ----------

export async function leaveTrip(db: D1Database, member: MemberRow): Promise<void> {
  if (member.role === "admin") throw conflict("Sos el admin: no podés salirte del rollo");
  await repo.markLeft(db, member.id, Date.now()).run();
}

// ---------- Remove member (admin) ----------

export async function removeMember(db: D1Database, trip: TripRow, adminMember: MemberRow, memberId: string): Promise<void> {
  if (memberId === adminMember.id) throw badRequest("No te podés sacar a vos mismo");
  const res = await repo.markRemoved(db, memberId, trip.id, Date.now()).run();
  if (!res.meta.changes) throw notFound("Miembro no encontrado");
}
