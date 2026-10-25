import type { UserRow } from "../../types";

// Reads execute and return rows.

export type ProfileOwnerRow = Pick<UserRow, "id" | "name" | "username" | "avatar_key" | "bio" | "badge" | "profile_visibility">;
export type VisibilityOwnerRow = Pick<UserRow, "id" | "profile_visibility">;
export type UserFriendRow = Pick<UserRow, "id" | "name" | "username" | "avatar_key">;

/** Subquery: ids of the friends of the user bound at `?N`. */
const friendIdsOf = (n: number) =>
  `SELECT user_b FROM friendships WHERE user_a = ?${n} UNION SELECT user_a FROM friendships WHERE user_b = ?${n}`;

export async function findProfileOwner(db: D1Database, userId: string): Promise<ProfileOwnerRow | null> {
  return db
    .prepare("SELECT id, name, username, avatar_key, bio, badge, profile_visibility FROM users WHERE id = ?")
    .bind(userId)
    .first<ProfileOwnerRow>();
}

export async function findVisibilityOwner(db: D1Database, userId: string): Promise<VisibilityOwnerRow | null> {
  return db.prepare("SELECT id, profile_visibility FROM users WHERE id = ?").bind(userId).first<VisibilityOwnerRow>();
}

export async function hasBlocked(db: D1Database, blockerId: string, blockedId: string): Promise<boolean> {
  return (await db.prepare("SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?").bind(blockerId, blockedId).first()) !== null;
}

export async function hasReportedUser(db: D1Database, reporterId: string, targetUserId: string): Promise<boolean> {
  return (
    (await db
      .prepare("SELECT 1 FROM reports WHERE reporter_id = ? AND target_user_id = ? AND media_id IS NULL")
      .bind(reporterId, targetUserId)
      .first()) !== null
  );
}

export async function friendCounts(db: D1Database, viewerId: string, ownerId: string): Promise<{ friendCount: number; mutualCount: number }> {
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM (${friendIdsOf(1)})) AS friendCount,
              (SELECT COUNT(*) FROM (${friendIdsOf(1)}) WHERE user_b IN (${friendIdsOf(2)})) AS mutualCount`,
    )
    .bind(ownerId, viewerId)
    .first<{ friendCount: number; mutualCount: number }>();
  return { friendCount: row!.friendCount, mutualCount: row!.mutualCount };
}

/** Friends of `ownerId` sorted by name; with `mutualWith` only the ones that are also friends of that user. */
export async function listFriendsOf(db: D1Database, ownerId: string, mutualWith?: string): Promise<UserFriendRow[]> {
  const { results } = await db
    .prepare(
      `SELECT u.id, u.name, u.username, u.avatar_key
     FROM users u
     WHERE u.id IN (${friendIdsOf(1)})${mutualWith !== undefined ? ` AND u.id IN (${friendIdsOf(2)})` : ""}
     ORDER BY u.name COLLATE NOCASE, u.id`,
    )
    .bind(...(mutualWith !== undefined ? [ownerId, mutualWith] : [ownerId]))
    .all<UserFriendRow>();
  return results;
}

/** Pending friend request between viewer and owner: `sent` by the viewer (rejected ones included, silently) or `received` from the owner. */
export async function friendRequestState(db: D1Database, viewerId: string, ownerId: string): Promise<"none" | "sent" | "received"> {
  const row = await db
    .prepare(
      `SELECT from_user_id, rejected_at FROM friend_requests
       WHERE (from_user_id = ?1 AND to_user_id = ?2) OR (from_user_id = ?2 AND to_user_id = ?1)`,
    )
    .bind(viewerId, ownerId)
    .all<{ from_user_id: string; rejected_at: number | null }>();
  if (row.results.some((r) => r.from_user_id === viewerId)) return "sent";
  if (row.results.some((r) => r.from_user_id === ownerId && r.rejected_at === null)) return "received";
  return "none";
}
