import { CREATOR_ONLY, isCreator } from "../../lib/creator";
import { actorName, sendPush } from "../../lib/push";
import { isRevealed, publicMember } from "../../lib/util";
import type { AfterResponse } from "../../shared/after-response";
import { badRequest, conflict, forbidden, notFound } from "../../shared/errors";
import type { Env, MemberRow, Role, TripRow, UserRow } from "../../types";
import { deleteFeaturedByOthersOfMember } from "../featured/featured.repository";
import { blockedIdsFor } from "../blocks/blocks.service";
import { completeUserIdsAmong, friendIdsAmong } from "../friends/friends.service";
import * as repo from "./trips.repository";

// ---------- Membership ----------

type AddResult =
  | { status: "added"; member: Pick<MemberRow, "id" | "user_id" | "role"> }
  | { status: "already_member"; member: MemberRow }
  | { status: "removed" }
  | { status: "full" };

/** What to do to make someone a member, given what the trip already has on them. */
type MembershipDecision =
  | { action: "insert" }
  | { action: "reactivate_left"; existing: MemberRow }
  | { action: "reactivate_removed"; existing: MemberRow }
  | { action: "already_member"; existing: MemberRow }
  | { action: "removed" };

/**
 * The membership rule, in one place (by code and when added by a friend): an active member stays as is;
 * someone who left gets their old membership back (same id, so their photos stay linked); someone the admin
 * removed only comes back when `reactivateRemoved` is set (an admin adding them as a friend). Pure.
 */
export function decideMembership(existing: MemberRow | null, reactivateRemoved: boolean): MembershipDecision {
  if (!existing) return { action: "insert" };
  if (existing.removed_at !== null) return reactivateRemoved ? { action: "reactivate_removed", existing } : { action: "removed" };
  if (existing.left_at === null) return { action: "already_member", existing };
  return { action: "reactivate_left", existing };
}

/**
 * Turns a decision into its write (unexecuted, to run alone or in a batch) and the result for the caller.
 * Does not check the reveal. The writes that take a spot (insert and both reactivations) are conditional on the
 * rollo having room, so `result` is what happens if the write goes through: the caller must check the write's
 * `meta.changes` and turn it into `full` when it is 0.
 */
function applyDecision(
  db: D1Database,
  decision: MembershipDecision,
  tripId: string,
  userId: string,
  addedBy: string | null,
  now: number,
): { result: AddResult; write: D1PreparedStatement | null } {
  switch (decision.action) {
    case "insert": {
      const member = { id: crypto.randomUUID(), user_id: userId, role: "member" as Role };
      return { result: { status: "added", member }, write: repo.insertMemberIfRoom(db, member.id, tripId, userId, now, addedBy) };
    }
    case "reactivate_left":
      return { result: { status: "added", member: decision.existing }, write: repo.reactivateLeftMember(db, decision.existing.id, addedBy) };
    case "reactivate_removed":
      return { result: { status: "added", member: decision.existing }, write: repo.reactivateRemovedMember(db, decision.existing.id, addedBy) };
    case "already_member":
      return { result: { status: "already_member", member: decision.existing }, write: null };
    case "removed":
      return { result: { status: "removed" }, write: null };
  }
}

/** Someone becomes a member of a trip by code (see `decideMembership`). Does not check the reveal. */
async function addMember(
  db: D1Database,
  tripId: string,
  userId: string,
  addedBy: string | null,
  now = Date.now(),
  reactivateRemoved = false,
): Promise<AddResult> {
  const existing = await repo.findMember(db, tripId, userId);
  const { result, write } = applyDecision(db, decideMembership(existing, reactivateRemoved), tripId, userId, addedBy, now);
  if (write && !(await write.run()).meta.changes) return { status: "full" };
  return result;
}

// ---------- Join ----------

/** Joins by invite code. `created` is false when `user` was already an active member. */
export async function joinTrip(
  db: D1Database,
  user: UserRow,
  code: string,
): Promise<{ created: boolean; trip: TripRow; member: Pick<MemberRow, "id" | "user_id" | "role"> }> {
  const now = Date.now();

  const trip = await repo.findTripByJoinCode(db, code);
  if (!trip) throw notFound("Código inválido");

  // Active members are answered before the reveal check (they get 200 even after it).
  const current = await repo.findMember(db, trip.id, user.id);
  if (current?.removed_at != null) throw forbidden("El admin te sacó de este rollo");
  if (current && current.left_at === null) return { created: false, trip, member: current };

  if (isRevealed(trip, now)) throw conflict("Este rollo ya se reveló");

  const added = await addMember(db, trip.id, user.id, null, now);
  // The joiner is not a member yet: the message must not reveal how many people the rollo holds.
  if (added.status === "full") throw conflict("Este rollo está lleno. Pedile a quien lo creó que haga lugar.");
  if (added.status !== "added") throw forbidden("El admin te sacó de este rollo");
  return { created: true, trip, member: added.member };
}

// ---------- Add friends ----------

export type AddMembersResult = { userId: string; status: "added" | "already_member" | "unavailable" | "full" };

/** Adds `friendIds` (a result per friend) and returns the "added to a rollo" push for those who were added. */
export async function addFriendsToTrip(
  env: Env,
  trip: TripRow,
  me: UserRow,
  myRole: Role,
  friendIds: string[],
): Promise<{ results: AddMembersResult[]; notify: AfterResponse }> {
  if (isRevealed(trip)) throw conflict("Este rollo ya se reveló");

  const now = Date.now();
  const userIds = [...new Set(friendIds)];
  const others = userIds.filter((id) => id !== me.id);
  // Three reads for the whole request (the friends module owns friendship and complete-user checks).
  // A friend who lost their name or @ is hidden from friend lists, so they can't be added either.
  const [friends, complete, memberships] = await Promise.all([
    friendIdsAmong(env.DB, me.id, others),
    completeUserIdsAmong(env.DB, others),
    repo.findMembersByUsers(env.DB, trip.id, others),
  ]);

  // Writes that take a spot are conditional on room (see `applyDecision`); `slots[i]` is the friend each write belongs to.
  const writes: D1PreparedStatement[] = [];
  const slots: number[] = [];
  const results: AddMembersResult[] = userIds.map((userId, i) => {
    if (userId === me.id) return { userId, status: "already_member" };
    if (!friends.has(userId) || !complete.has(userId)) return { userId, status: "unavailable" };
    const { result, write } = applyDecision(env.DB, decideMembership(memberships.get(userId) ?? null, myRole === "admin"), trip.id, userId, me.id, now);
    if (write) {
      writes.push(write);
      slots.push(i);
    }
    return { userId, status: result.status === "removed" || result.status === "full" ? "unavailable" : result.status };
  });
  // One atomic batch (D1 has no interactive transactions). Statements run in order, so each conditional write sees the
  // spots taken by the ones before it: the first friends that fit are added, the rest come back with changes = 0 (full).
  if (writes.length) {
    const outcomes = await env.DB.batch(writes);
    outcomes.forEach((o, n) => {
      if (!o.meta.changes) results[slots[n]!]!.status = "full";
    });
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
