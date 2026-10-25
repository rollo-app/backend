// Reads execute and return rows; writes return an unexecuted statement so the service decides
// whether to `.run()` it or group it with others in `db.batch([...])`.

export type BlockedUserRow = { id: string; name: string | null; username: string | null; avatar_key: string | null; bio: string | null };
export type BlockTargetRow = { id: string; email: string; name: string | null; username: string | null };

export async function listBlocked(db: D1Database, blockerId: string): Promise<BlockedUserRow[]> {
  const { results } = await db
    .prepare(
      `SELECT u.id, u.name, u.username, u.avatar_key, u.bio
     FROM blocks b JOIN users u ON u.id = b.blocked_id
     WHERE b.blocker_id = ?
     ORDER BY u.name COLLATE NOCASE, u.id`,
    )
    .bind(blockerId)
    .all<BlockedUserRow>();
  return results;
}

export function findBlockTarget(db: D1Database, userId: string): Promise<BlockTargetRow | null> {
  return db.prepare("SELECT id, email, name, username FROM users WHERE id = ?").bind(userId).first<BlockTargetRow>();
}

export function insertBlock(db: D1Database, blockerId: string, blockedId: string, now: number): D1PreparedStatement {
  return db.prepare("INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at, unemailed) VALUES (?, ?, ?, 1)").bind(blockerId, blockedId, now);
}

export function deleteFriendship(db: D1Database, userA: string, userB: string): D1PreparedStatement {
  return db.prepare("DELETE FROM friendships WHERE user_a = ? AND user_b = ?").bind(userA, userB);
}

/** Pending friend requests between the two users, in both directions. */
export function deleteFriendRequests(db: D1Database, userA: string, userB: string): D1PreparedStatement {
  return db
    .prepare("DELETE FROM friend_requests WHERE (from_user_id = ?1 AND to_user_id = ?2) OR (from_user_id = ?2 AND to_user_id = ?1)")
    .bind(userA, userB);
}

/** Their photos leave the blocker's featured list too (and its cap). */
export function deleteFeaturedByAuthor(db: D1Database, blockerId: string, authorUserId: string): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM featured WHERE user_id = ? AND media_id IN (
         SELECT m.id FROM media m JOIN members mem ON mem.id = m.member_id WHERE mem.user_id = ?)`,
    )
    .bind(blockerId, authorUserId);
}

export function markBlockEmailed(db: D1Database, blockerId: string, blockedId: string): D1PreparedStatement {
  return db.prepare("UPDATE blocks SET unemailed = 0 WHERE blocker_id = ? AND blocked_id = ?").bind(blockerId, blockedId);
}

export function deleteBlock(db: D1Database, blockerId: string, blockedId: string): D1PreparedStatement {
  return db.prepare("DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?").bind(blockerId, blockedId);
}
