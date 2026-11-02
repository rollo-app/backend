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

export type FriendRequestRow = { from_user_id: string; to_user_id: string; rejected_at: number | null; cancelled_at: number | null };

/** Friend request rows (either direction) between `viewerId` and each of `ownerIds`, in one read. */
export async function friendRequestRowsWith(db: D1Database, viewerId: string, ownerIds: string[]): Promise<FriendRequestRow[]> {
  if (ownerIds.length === 0) return [];
  const marks = ownerIds.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT from_user_id, to_user_id, rejected_at, cancelled_at FROM friend_requests
       WHERE (from_user_id = ? AND to_user_id IN (${marks})) OR (to_user_id = ? AND from_user_id IN (${marks}))`,
    )
    .bind(viewerId, ...ownerIds, viewerId, ...ownerIds)
    .all<FriendRequestRow>();
  return results;
}

/**
 * Pending friend request between viewer and owner from `rows`: `sent` by the viewer (rejected ones included, silently)
 * or `received` from the owner. Rows about other users are ignored.
 */
export function friendRequestStateFrom(
  rows: FriendRequestRow[],
  viewerId: string,
  ownerId: string,
  now: number,
): "none" | "sent" | "received" {
  // After 30 days a rejected request no longer shows as sent: the sender may ask again.
  const resendable = now - 30 * 86_400_000;
  const live = (r: FriendRequestRow) => r.cancelled_at === null && (r.rejected_at === null || r.rejected_at > resendable);
  if (rows.some((r) => r.from_user_id === viewerId && r.to_user_id === ownerId && live(r))) return "sent";
  if (rows.some((r) => r.from_user_id === ownerId && r.to_user_id === viewerId && r.rejected_at === null && r.cancelled_at === null)) return "received";
  return "none";
}

/** Pending friend request between viewer and owner: `sent` by the viewer (rejected ones included, silently) or `received` from the owner. */
export async function friendRequestState(db: D1Database, viewerId: string, ownerId: string): Promise<"none" | "sent" | "received"> {
  return friendRequestStateFrom(await friendRequestRowsWith(db, viewerId, [ownerId]), viewerId, ownerId, Date.now());
}

export type UserSearchHit = { id: string; name: string; username: string; avatar_key: string | null; mutual_count: number };

/** Escapes `%`, `_` and `\` so `q` is matched literally by `LIKE ... ESCAPE '\'`. */
const escapeLike = (q: string) => q.replace(/[\\%_]/g, "\\$&");

/**
 * Users whose username starts with `q` or whose name has a word starting with `q` (`q` already normalized; `name_search` is
 * the normalized name with a leading space). Skips the viewer, their friends, blocks in either direction and incomplete accounts.
 * Exact username first, then most mutual friends, then name; 20 at most.
 */
export async function searchUsers(db: D1Database, viewerId: string, q: string): Promise<UserSearchHit[]> {
  const like = escapeLike(q);
  const { results } = await db
    .prepare(
      `WITH my_friends(id) AS (${friendIdsOf(1)})
       SELECT u.id, u.name, u.username, u.avatar_key,
              (SELECT COUNT(*) FROM friendships f
                WHERE (f.user_a = u.id AND f.user_b IN (SELECT id FROM my_friends))
                   OR (f.user_b = u.id AND f.user_a IN (SELECT id FROM my_friends))) AS mutual_count
       FROM users u
       WHERE u.id <> ?1
         AND u.id NOT IN (SELECT id FROM my_friends)
         AND u.username IS NOT NULL
         AND TRIM(COALESCE(u.name, '')) <> ''
         AND NOT EXISTS (
           SELECT 1 FROM blocks b
           WHERE (b.blocker_id = ?1 AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = ?1)
         )
         AND (u.username LIKE ?2 || '%' ESCAPE '\\' OR u.name_search LIKE '% ' || ?2 || '%' ESCAPE '\\')
       ORDER BY (u.username = ?3) DESC, mutual_count DESC, u.name COLLATE NOCASE, u.id
       LIMIT 20`,
    )
    .bind(viewerId, like, q)
    .all<UserSearchHit>();
  return results;
}
