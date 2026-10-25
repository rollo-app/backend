import { pairKey } from "../../lib/friend-code";
import { isBlockedEitherWay } from "../../lib/moderation";
import { areFriends } from "../../lib/profile-access";
import { actorName, sendPush } from "../../lib/push";
import type { AfterResponse } from "../../shared/after-response";
import { badRequest, notFound, rateLimited } from "../../shared/errors";
import type { Env, UserRow } from "../../types";
import type { PublicFriendRow } from "../friends/friends.repository";
import * as repo from "./friend-requests.repository";
import type { ReceivedRequestRow } from "./friend-requests.repository";

const DAY = 86_400_000;
/** Sent requests per person in 24 hours. */
export const REQUESTS_PER_DAY = 30;
/** How long a rejected sender has to wait before the request can reach the receiver again. */
export const RESEND_AFTER_REJECTION = 30 * DAY;

type Actor = Pick<UserRow, "id" | "name" | "username">;

const newFriendPush = (env: Env, actor: Actor, recipientId: string): AfterResponse => () =>
  sendPush(env, [recipientId], "newFriend", { body: `${actorName(actor)} ahora es tu amigo`, url: `/user/${actor.id}` }, { actorId: actor.id });

/** Friendship plus clearing any request between them, atomically. */
function makeFriends(db: D1Database, a: string, b: string, now: number): D1PreparedStatement[] {
  const [x, y] = pairKey(a, b);
  return [repo.insertFriendship(db, x, y, now), repo.removeBetween(db, a, b)];
}

/**
 * Sends a request. `friends` if the other already asked you (crossed requests) or you already are friends;
 * otherwise `sent`. A request the receiver rejected stays "sent" for the sender but is neither renewed nor
 * notified until 30 days after the rejection.
 */
export async function sendRequest(env: Env, me: Actor, targetId: string): Promise<{ status: "sent" | "friends"; notify: AfterResponse }> {
  const db = env.DB;
  if (targetId === me.id) throw badRequest("No podés mandarte una solicitud a vos");
  if (!(await repo.findUser(db, targetId)) || (await isBlockedEitherWay(db, me.id, targetId))) throw notFound("No existe");
  if (await areFriends(db, me.id, targetId)) return { status: "friends", notify: null };

  const now = Date.now();
  // The other one asked first (even if their request was rejected: you want it now), so you are friends.
  if (await repo.find(db, targetId, me.id)) {
    await db.batch(makeFriends(db, me.id, targetId, now));
    return { status: "friends", notify: newFriendPush(env, me, targetId) };
  }

  const existing = await repo.find(db, me.id, targetId);
  if (existing) {
    const waiting = existing.rejected_at === null || now - existing.rejected_at < RESEND_AFTER_REJECTION;
    if (waiting) return { status: "sent", notify: null };
  }
  if ((await repo.countSentSince(db, me.id, now - DAY)) >= REQUESTS_PER_DAY) {
    throw rateLimited("Mandaste muchas solicitudes hoy. Probá de nuevo mañana");
  }
  await repo.upsert(db, me.id, targetId, now).run();
  return {
    status: "sent",
    notify: () =>
      sendPush(env, [targetId], "friendRequest", { body: `${actorName(me)} te mandó una solicitud de amistad`, url: "/friends" }, { actorId: me.id }),
  };
}

export async function cancelRequest(db: D1Database, me: string, targetId: string): Promise<void> {
  await repo.remove(db, me, targetId).run();
}

export function listReceived(db: D1Database, me: string): Promise<ReceivedRequestRow[]> {
  return repo.listReceived(db, me);
}

export async function acceptRequest(env: Env, me: Actor, fromId: string): Promise<{ friend: PublicFriendRow; notify: AfterResponse }> {
  const db = env.DB;
  const request = await repo.find(db, fromId, me.id);
  if (!request || request.rejected_at !== null) throw notFound("No hay una solicitud de esa persona");
  const friend = await repo.findUser(db, fromId);
  if (!friend) throw notFound("No hay una solicitud de esa persona");
  await db.batch(makeFriends(db, me.id, fromId, Date.now()));
  return { friend, notify: newFriendPush(env, me, fromId) };
}

/** Silent: the sender is not told, and keeps seeing "sent". */
export async function rejectRequest(db: D1Database, me: string, fromId: string): Promise<void> {
  await repo.markRejected(db, fromId, me, Date.now()).run();
}
