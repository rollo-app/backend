import { pairKey } from "./friend-code";
import { isBlockedEitherWay } from "./moderation";
import type { UserRow } from "../types";

/** Whether the two users are friends (order does not matter). Nobody is their own friend. */
export async function areFriends(db: D1Database, a: string, b: string): Promise<boolean> {
  if (a === b) return false;
  const [userA, userB] = pairKey(a, b);
  const row = await db.prepare("SELECT 1 FROM friendships WHERE user_a = ? AND user_b = ?").bind(userA, userB).first();
  return row !== null;
}

/**
 * Whether `viewerId` can see the private parts of `owner`'s profile (bio and featured photos):
 * the owner themselves, their friends, or anyone signed in when the profile is public.
 * A block in either direction makes the profile private, whatever its visibility.
 */
export async function canSeeProfile(
  db: D1Database,
  viewerId: string,
  owner: Pick<UserRow, "id" | "profile_visibility">,
): Promise<boolean> {
  if (viewerId === owner.id) return true;
  if (await isBlockedEitherWay(db, viewerId, owner.id)) return false;
  if (owner.profile_visibility === "public") return true;
  return areFriends(db, viewerId, owner.id);
}
