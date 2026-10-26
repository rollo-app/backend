import type { TripRow } from "../../types";

// Reads execute and return rows; writes return an unexecuted statement so the service decides
// whether to `.run()` it or group it with others in `db.batch([...])`.

export type PublicFriendRow = { id: string; name: string | null; username: string | null; avatar_key: string | null; bio: string | null };

export type LinkCreatorRow = { user_id: string; name: string | null; username: string | null; avatar_key: string | null };

// ---------- Failed attempts ----------

export async function countFailedAttempts(db: D1Database, key: string, since: number): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM friend_attempts WHERE key = ? AND created_at > ?")
    .bind(key, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export function insertFailedAttempt(db: D1Database, key: string, now: number): D1PreparedStatement {
  return db.prepare("INSERT INTO friend_attempts (id, key, created_at) VALUES (?, ?, ?)").bind(crypto.randomUUID(), key, now);
}

export function deleteOldAttempts(db: D1Database, before: number): D1PreparedStatement {
  return db.prepare("DELETE FROM friend_attempts WHERE created_at <= ?").bind(before);
}

// ---------- Links and claims ----------

export function deleteLinksOfUser(db: D1Database, userId: string): D1PreparedStatement {
  return db.prepare("DELETE FROM friend_links WHERE user_id = ?").bind(userId);
}

export function deleteExpiredClaims(db: D1Database, now: number): D1PreparedStatement {
  return db.prepare("DELETE FROM friend_claims WHERE expires_at <= ?").bind(now);
}

export function insertLink(db: D1Database, userId: string, codeHash: string, now: number, expiresAt: number): D1PreparedStatement {
  return db
    .prepare("INSERT INTO friend_links (id, user_id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), userId, codeHash, now, expiresAt);
}

export async function findLinkWithCreator(db: D1Database, codeHash: string, now: number): Promise<LinkCreatorRow | null> {
  return db
    .prepare(
      `SELECT l.user_id, u.name, u.username, u.avatar_key
     FROM friend_links l JOIN users u ON u.id = l.user_id
     WHERE l.code_hash = ? AND l.expires_at > ?`,
    )
    .bind(codeHash, now)
    .first<LinkCreatorRow>();
}

export async function findLinkOwnerId(db: D1Database, codeHash: string, now: number): Promise<string | undefined> {
  const link = await db
    .prepare("SELECT user_id FROM friend_links WHERE code_hash = ? AND expires_at > ?")
    .bind(codeHash, now)
    .first<{ user_id: string }>();
  return link?.user_id;
}

export function insertClaim(db: D1Database, linkUserId: string, claimHash: string, now: number, expiresAt: number): D1PreparedStatement {
  return db
    .prepare("INSERT INTO friend_claims (id, link_user_id, claim_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), linkUserId, claimHash, now, expiresAt);
}

/** Marks the claim as used and returns its link owner. Executes: the single `UPDATE ... RETURNING` is what makes it single use. */
export async function consumeClaim(db: D1Database, claimHash: string, now: number): Promise<string | undefined> {
  const claim = await db
    .prepare("UPDATE friend_claims SET used_at = ? WHERE claim_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING link_user_id")
    .bind(now, claimHash, now)
    .first<{ link_user_id: string }>();
  return claim?.link_user_id;
}

// ---------- Friendships ----------

export async function findUser(db: D1Database, id: string): Promise<PublicFriendRow | null> {
  return db.prepare("SELECT id, name, username, avatar_key, bio FROM users WHERE id = ?").bind(id).first<PublicFriendRow>();
}

export function insertFriendship(db: D1Database, a: string, b: string, now: number): D1PreparedStatement {
  return db.prepare("INSERT OR IGNORE INTO friendships (user_a, user_b, created_at) VALUES (?, ?, ?)").bind(a, b, now);
}

/** Requests between the two users, both directions: a friendship (made or ended) leaves none behind. */
export function deleteFriendRequests(db: D1Database, a: string, b: string): D1PreparedStatement {
  return db
    .prepare("DELETE FROM friend_requests WHERE (from_user_id = ?1 AND to_user_id = ?2) OR (from_user_id = ?2 AND to_user_id = ?1)")
    .bind(a, b);
}

export function deleteFriendship(db: D1Database, a: string, b: string): D1PreparedStatement {
  return db.prepare("DELETE FROM friendships WHERE user_a = ? AND user_b = ?").bind(a, b);
}

export async function listFriends(db: D1Database, userId: string): Promise<PublicFriendRow[]> {
  const { results } = await db
    .prepare(
      `SELECT u.id, u.name, u.username, u.avatar_key, u.bio
     FROM users u
     WHERE u.id IN (SELECT user_b FROM friendships WHERE user_a = ?1 UNION SELECT user_a FROM friendships WHERE user_b = ?1)
     ORDER BY u.name COLLATE NOCASE, u.id`,
    )
    .bind(userId)
    .all<PublicFriendRow>();
  return results;
}

export async function listCommonTrips(db: D1Database, me: string, friendId: string): Promise<TripRow[]> {
  const { results } = await db
    .prepare(
      `SELECT t.*
     FROM trips t
     JOIN members mine ON mine.trip_id = t.id AND mine.user_id = ?1 AND mine.removed_at IS NULL AND mine.left_at IS NULL
     JOIN members theirs ON theirs.trip_id = t.id AND theirs.user_id = ?2 AND theirs.removed_at IS NULL AND theirs.left_at IS NULL
     ORDER BY t.starts_at DESC, t.id`,
    )
    .bind(me, friendId)
    .all<TripRow>();
  return results;
}
