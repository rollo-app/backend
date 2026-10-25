import type { PublicFriendRow } from "../friends/friends.repository";

// Reads execute and return rows; writes return an unexecuted statement so the service decides
// whether to `.run()` it or group it with others in `db.batch([...])`.

export type FriendRequestRow = { from_user_id: string; to_user_id: string; created_at: number; rejected_at: number | null; cancelled_at: number | null };
export type ReceivedRequestRow = PublicFriendRow & { requested_at: number };

export async function findUser(db: D1Database, id: string): Promise<PublicFriendRow | null> {
  return db.prepare("SELECT id, name, username, avatar_key, bio FROM users WHERE id = ?").bind(id).first<PublicFriendRow>();
}

export async function find(db: D1Database, fromId: string, toId: string): Promise<FriendRequestRow | null> {
  return db
    .prepare("SELECT from_user_id, to_user_id, created_at, rejected_at, cancelled_at FROM friend_requests WHERE from_user_id = ? AND to_user_id = ?")
    .bind(fromId, toId)
    .first<FriendRequestRow>();
}

/** Requests the user sent since `since`, rejected ones included (they still count against the daily cap). */
export async function countSentSince(db: D1Database, fromId: string, since: number): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM friend_requests WHERE from_user_id = ? AND created_at > ?")
    .bind(fromId, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Creates the request, or renews an old one (new date, no longer rejected or cancelled). */
export function upsert(db: D1Database, fromId: string, toId: string, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO friend_requests (from_user_id, to_user_id, created_at, rejected_at) VALUES (?, ?, ?, NULL)
       ON CONFLICT (from_user_id, to_user_id) DO UPDATE SET created_at = excluded.created_at, rejected_at = NULL, cancelled_at = NULL`,
    )
    .bind(fromId, toId, now);
}

/** Takes back a pending request (a rejected one stays: its 30 days still count). The row stays as a tombstone. */
export function markCancelled(db: D1Database, fromId: string, toId: string, now: number): D1PreparedStatement {
  return db
    .prepare("UPDATE friend_requests SET cancelled_at = ? WHERE from_user_id = ? AND to_user_id = ? AND rejected_at IS NULL AND cancelled_at IS NULL")
    .bind(now, fromId, toId);
}

/** Brings a request cancelled less than a day ago back, with its old date (and no new notification). */
export function revive(db: D1Database, fromId: string, toId: string): D1PreparedStatement {
  return db.prepare("UPDATE friend_requests SET cancelled_at = NULL WHERE from_user_id = ? AND to_user_id = ?").bind(fromId, toId);
}

/** Both directions: once they are friends no request between them makes sense. */
export function removeBetween(db: D1Database, a: string, b: string): D1PreparedStatement {
  return db
    .prepare("DELETE FROM friend_requests WHERE (from_user_id = ?1 AND to_user_id = ?2) OR (from_user_id = ?2 AND to_user_id = ?1)")
    .bind(a, b);
}

export function markRejected(db: D1Database, fromId: string, toId: string, now: number): D1PreparedStatement {
  return db
    .prepare("UPDATE friend_requests SET rejected_at = ? WHERE from_user_id = ? AND to_user_id = ? AND rejected_at IS NULL AND cancelled_at IS NULL")
    .bind(now, fromId, toId);
}

export function insertFriendship(db: D1Database, a: string, b: string, now: number): D1PreparedStatement {
  return db.prepare("INSERT OR IGNORE INTO friendships (user_a, user_b, created_at) VALUES (?, ?, ?)").bind(a, b, now);
}

export async function listReceived(db: D1Database, toId: string): Promise<ReceivedRequestRow[]> {
  const { results } = await db
    .prepare(
      `SELECT u.id, u.name, u.username, u.avatar_key, u.bio, r.created_at AS requested_at
       FROM friend_requests r JOIN users u ON u.id = r.from_user_id
       WHERE r.to_user_id = ? AND r.rejected_at IS NULL AND r.cancelled_at IS NULL
       ORDER BY r.created_at DESC, u.id`,
    )
    .bind(toId)
    .all<ReceivedRequestRow>();
  return results;
}
