import { generateToken, hashToken } from "../../lib/auth";
import { ipKey } from "../../lib/ip";
import { FRIEND_CLAIM_TTL, FRIEND_LINK_TTL, generateFriendCode, normalizeFriendCode, pairKey } from "../../lib/friend-code";
import { isBlockedEitherWay } from "../../lib/moderation";
import { areFriends } from "../../lib/profile-access";
import { isRevealed } from "../../lib/util";
import { badRequest, notFound, rateLimited } from "../../shared/errors";
import type { TripRow } from "../../types";
import * as repo from "./friends.repository";
import type { LinkCreatorRow, PublicFriendRow } from "./friends.repository";

const HOUR = 3_600_000;
const MAX_FAILED_ATTEMPTS = 10;
const BAD_CODE = "Código incorrecto o vencido";

// ---------- Rate limit (failed attempts per user and per IP) ----------

function attemptKeys(rawIp: string | undefined, userId?: string): string[] {
  const ip = rawIp ? ipKey(rawIp) : undefined;
  return [...(userId ? [`user:${userId}`] : []), ...(ip ? [`ip:${ip}`] : [])];
}

/** Throws 429 if any of the keys already has too many failed attempts in the last hour. */
async function assertNotLocked(db: D1Database, keys: string[]) {
  const since = Date.now() - HOUR;
  for (const key of keys) {
    if ((await repo.countFailedAttempts(db, key, since)) >= MAX_FAILED_ATTEMPTS) {
      throw rateLimited("Demasiados intentos, probá más tarde");
    }
  }
}

/** Records a failed attempt under every key and answers with the generic error (never says why it failed). */
async function failAttempt(db: D1Database, keys: string[]): Promise<never> {
  const now = Date.now();
  if (keys.length) {
    await db.batch(keys.map((key) => repo.insertFailedAttempt(db, key, now)));
  }
  throw badRequest(BAD_CODE);
}

// ---------- Generate a link ----------

export async function generateLink(db: D1Database, userId: string): Promise<{ code: string; expiresAt: number }> {
  const now = Date.now();
  const code = generateFriendCode();
  const expiresAt = now + FRIEND_LINK_TTL;
  await db.batch([
    repo.deleteLinksOfUser(db, userId),
    // Pending claims are NOT deleted when a new link is generated: on purpose, so whoever opened the old link in
    // time can still finish signing up. Only expired claims are cleaned up.
    repo.deleteExpiredClaims(db, now),
    repo.deleteOldAttempts(db, now - HOUR),
    repo.insertLink(db, userId, await hashToken(code), now, expiresAt),
  ]);
  return { code, expiresAt };
}

// ---------- Claim (no session) ----------

export async function claimLink(
  db: D1Database,
  rawIp: string | undefined,
  rawCode: string,
): Promise<{ claimToken: string; expiresAt: number; creator: LinkCreatorRow }> {
  const keys = attemptKeys(rawIp);
  await assertNotLocked(db, keys);
  const code = normalizeFriendCode(rawCode);
  if (code === null) return failAttempt(db, keys);

  const now = Date.now();
  const link = await repo.findLinkWithCreator(db, await hashToken(code), now);
  if (!link) return failAttempt(db, keys);

  const claimToken = generateToken();
  const expiresAt = now + FRIEND_CLAIM_TTL;
  await repo.insertClaim(db, link.user_id, await hashToken(claimToken), now, expiresAt).run();

  return { claimToken, expiresAt, creator: link };
}

// ---------- Redeem ----------

/** `newFriendOf` is the link creator's id when a friendship was just created (they get a push), else null. */
export async function redeem(
  db: D1Database,
  me: string,
  rawIp: string | undefined,
  body: { code?: string; claimToken?: string },
): Promise<{ friend: PublicFriendRow; newFriendOf: string | null }> {
  const keys = attemptKeys(rawIp, me);
  await assertNotLocked(db, keys);
  const now = Date.now();

  let creatorId: string | undefined;
  if (body.claimToken !== undefined) {
    // Single use, atomically: only one redeem can flip used_at.
    creatorId = await repo.consumeClaim(db, await hashToken(body.claimToken), now);
  } else {
    const code = normalizeFriendCode(body.code ?? "");
    if (code !== null) {
      creatorId = await repo.findLinkOwnerId(db, await hashToken(code), now);
    }
  }
  if (!creatorId) return failAttempt(db, keys);

  // A block in either direction fails exactly like an invalid link.
  if (creatorId !== me && (await isBlockedEitherWay(db, me, creatorId))) return failAttempt(db, keys);

  const creator = (await repo.findUser(db, creatorId))!;

  let newFriendOf: string | null = null;
  if (creatorId !== me) {
    const [a, b] = pairKey(me, creatorId);
    const inserted = await repo.insertFriendship(db, a, b, now).run();
    if (inserted.meta.changes > 0) newFriendOf = creatorId;
  }
  return { friend: creator, newFriendOf };
}

// ---------- List ----------

export function listFriends(db: D1Database, userId: string): Promise<PublicFriendRow[]> {
  return repo.listFriends(db, userId);
}

// ---------- Profile ----------

export async function getFriendProfile(
  db: D1Database,
  me: string,
  friendId: string,
): Promise<{ friend: PublicFriendRow; commonTrips: Array<{ trip: TripRow; revealed: boolean }> }> {
  // Yourself is never a friend, so it falls into the same 404.
  if (!(await areFriends(db, me, friendId))) throw notFound("No es tu amigo");
  const friend = await repo.findUser(db, friendId);
  if (!friend) throw notFound("No es tu amigo");

  const now = Date.now();
  const trips = await repo.listCommonTrips(db, me, friendId);
  return { friend, commonTrips: trips.map((trip) => ({ trip, revealed: isRevealed(trip, now) })) };
}

// ---------- Remove ----------

export async function removeFriend(db: D1Database, me: string, otherId: string): Promise<void> {
  const [a, b] = pairKey(me, otherId);
  await repo.deleteFriendship(db, a, b).run();
}
