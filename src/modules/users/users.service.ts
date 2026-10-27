import { isBlockedEitherWay } from "../blocks/blocks.service";
import { areFriends } from "../friends/friends.service";
import { notFound } from "../../shared/errors";
import type { UserRow } from "../../types";
import * as repo from "./users.repository";
import type { ProfileOwnerRow, UserFriendRow } from "./users.repository";

export type UserProfile = {
  owner: ProfileOwnerRow;
  isFriend: boolean;
  blockedByMe: boolean;
  reportedByMe: boolean;
  canSee: boolean;
  friendCount: number;
  mutualCount: number;
  friendRequest: "none" | "sent" | "received";
};

export async function getProfile(db: D1Database, viewerId: string, userId: string): Promise<UserProfile> {
  const owner = await repo.findProfileOwner(db, userId);
  if (!owner) throw notFound("No existe");

  const [blocked, blockedByMe, reportedByMe, counts] = await Promise.all([
    isBlockedEitherWay(db, viewerId, owner.id),
    repo.hasBlocked(db, viewerId, owner.id),
    repo.hasReportedUser(db, viewerId, owner.id),
    repo.friendCounts(db, viewerId, owner.id),
  ]);
  // A blocked pair (either direction) sees a header-only profile: no access, no friendship, no mutual friends.
  const canSee = !blocked && (await canSeeProfile(db, viewerId, owner));
  const isFriend = !blocked && (await areFriends(db, viewerId, owner.id));
  const friendRequest = blocked || isFriend || viewerId === owner.id ? "none" : await repo.friendRequestState(db, viewerId, owner.id);
  return {
    owner,
    isFriend,
    friendRequest,
    blockedByMe,
    reportedByMe,
    canSee,
    friendCount: counts.friendCount,
    mutualCount: blocked || viewerId === owner.id ? 0 : counts.mutualCount,
  };
}

export async function listFriends(
  db: D1Database,
  viewerId: string,
  userId: string,
): Promise<{ scope: "all" | "mutual"; friends: UserFriendRow[] }> {
  const owner = await repo.findVisibilityOwner(db, userId);
  if (!owner) throw notFound("No existe");

  if (await isBlockedEitherWay(db, viewerId, owner.id)) return { scope: "mutual", friends: [] };

  const scope = (await canSeeProfile(db, viewerId, owner)) ? "all" : "mutual";
  return { scope, friends: await repo.listFriendsOf(db, owner.id, scope === "mutual" ? viewerId : undefined) };
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
