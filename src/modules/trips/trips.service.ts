import { badRequest, conflict, forbidden, notFound } from "../../shared/errors";
import { blockedIdsFor } from "../../lib/moderation";
import { actorName, sendPush } from "../../lib/push";
import { areFriends } from "../../lib/profile-access";
import { claimRevealedStatement, sendTripRevealed } from "../../lib/trip-notices";
import { generateJoinCode, isRevealed, localDate, publicTrip } from "../../lib/util";
import { PAST_TOLERANCE_MS } from "../../schemas";
import type { Env, MemberRow, Role, TripRow, UserRow } from "../../types";
import * as repo from "./trips.repository";
import type { ActiveMemberRow } from "./trips.repository";
import type { CreateTripInput, UpdateTripInput } from "./trips.schemas";

/**
 * Work to run after the response is sent (a push). The service builds it; the controller defers it with
 * `deferPush(c, notify())`, so services never need the Hono context. `null` when there is nothing to send.
 */
export type AfterResponse = (() => Promise<unknown>) | null;

function requireName(user: Pick<UserRow, "name" | "username">) {
  if (!user.name) throw conflict("Completá tu nombre en el perfil");
  if (!user.username) throw conflict("Elegí tu nombre de usuario en el perfil");
}

// ---------- Create ----------

/** Creates the trip with `user` as admin. `null` when no free join code could be generated. */
export async function createTrip(
  db: D1Database,
  user: UserRow,
  body: CreateTripInput,
): Promise<{ trip: TripRow; member: Pick<MemberRow, "id" | "user_id" | "role"> } | null> {
  requireName(user);
  const now = Date.now();

  // Unique code (collisions are very unlikely, but we retry just in case).
  let joinCode = "";
  for (let i = 0; i < 5 && !joinCode; i++) {
    const candidate = generateJoinCode();
    if (!(await repo.joinCodeExists(db, candidate))) joinCode = candidate;
  }
  if (!joinCode) return null;

  const tripId = crypto.randomUUID();
  const memberId = crypto.randomUUID();

  await db.batch([
    repo.insertTrip(db, {
      id: tripId,
      name: body.name,
      join_code: joinCode,
      timezone: body.timezone,
      starts_at: body.startsAt,
      ends_at: body.endsAt,
      reveal_at: body.revealAt,
      daily_photo_limit: body.dailyPhotoLimit,
      daily_video_limit: body.dailyVideoLimit,
      created_at: now,
      // Starting now ("Empezar ahora"): the creator is the only member and just did it, so no "Arrancó" push.
      started_notified_at: body.startsAt <= now ? now : null,
    }),
    repo.insertAdminMember(db, memberId, tripId, user.id, now),
  ]);

  const trip = await repo.findTripById(db, tripId);
  return { trip: trip!, member: { id: memberId, user_id: user.id, role: "admin" as Role } };
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

// ---------- Detail ----------

export type TripDetail = {
  members: ActiveMemberRow[];
  blocked: Set<string>;
  today: { date: string; photosLeft: number; videosLeft: number };
  totalUploaded: number;
};

/** Active members, how many photos and videos `me` has left today, and how much has been uploaded. */
export async function getTripDetail(db: D1Database, trip: TripRow, me: MemberRow, userId: string): Promise<TripDetail> {
  const now = Date.now();
  const today = localDate(now, trip.timezone);

  const [members, usage, totals, blocked] = await Promise.all([
    repo.listActiveMembers(db, trip.id),
    repo.countMediaByType(db, me.id, today),
    repo.countUploadedMedia(db, trip.id),
    blockedIdsFor(db, userId),
  ]);

  // Outside the rollo's dates (or once revealed) nothing can be shot.
  const active = now >= trip.starts_at && now <= trip.ends_at && !isRevealed(trip, now);
  const used = (type: string) => usage.results.find((r) => r.type === type)?.n ?? 0;

  return {
    members: members.results,
    blocked,
    today: {
      date: today,
      photosLeft: !active ? 0 : Math.max(0, trip.daily_photo_limit - used("photo")),
      videosLeft: !active ? 0 : Math.max(0, trip.daily_video_limit - used("video")),
    },
    totalUploaded: totals?.n ?? 0,
  };
}

// ---------- Edit (admin) ----------

/** Applies the edit and returns the updated trip. */
export async function updateTrip(db: D1Database, trip: TripRow, b: UpdateTripInput): Promise<TripRow> {
  // Only the fields being changed are checked, so a trip that already started can still be edited.
  const earliest = Date.now() - PAST_TOLERANCE_MS;
  if (b.endsAt !== undefined && b.endsAt < earliest) throw badRequest("El fin no puede ser en el pasado");
  if (b.revealAt !== undefined && b.revealAt < earliest) throw badRequest("El revelado no puede ser en el pasado");
  const next = {
    name: b.name ?? trip.name,
    ends_at: b.endsAt ?? trip.ends_at,
    reveal_at: b.revealAt ?? trip.reveal_at,
    daily_photo_limit: b.dailyPhotoLimit ?? trip.daily_photo_limit,
    daily_video_limit: b.dailyVideoLimit ?? trip.daily_video_limit,
  };
  if (next.ends_at <= trip.starts_at) throw badRequest("El rollo tiene que terminar después de empezar");
  if (next.reveal_at < next.ends_at) throw badRequest("El revelado no puede ser antes del fin");

  await repo.updateTrip(db, trip.id, next).run();

  return { ...trip, ...next };
}

// ---------- Reveal (admin) ----------

/** Reveals now. Returns the revealed trip and, the first time, the "revealed" push to send after the response. */
export async function revealTrip(env: Env, trip: TripRow, actorId: string): Promise<{ trip: TripRow; notify: AfterResponse }> {
  const now = Date.now();
  // Claim the notice and write revealed_at in one batch (a transaction), claim first: a cron run can never see
  // the trip revealed but unclaimed and notify the admin about their own reveal. Sent after the response.
  const [claim] = await env.DB.batch([claimRevealedStatement(env.DB, trip.id, now), repo.markRevealed(env.DB, trip.id, now)]);
  return {
    trip: { ...trip, revealed_at: trip.revealed_at ?? now },
    notify: claim!.meta.changes > 0 ? () => sendTripRevealed(env, trip, actorId) : null,
  };
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
