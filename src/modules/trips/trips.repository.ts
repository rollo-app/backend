import type { MemberRow, Role, TripRow } from "../../types";

// Reads execute and return rows; writes return an unexecuted statement so the service decides
// whether to `.run()` it or group it with others in `db.batch([...])`.

export type ActiveMemberRow = {
  id: string; user_id: string; role: Role; name: string | null; username: string | null; avatar_key: string | null;
};

export type NewTrip = Pick<
  TripRow,
  "id" | "name" | "join_code" | "timezone" | "starts_at" | "ends_at" | "reveal_at" | "daily_photo_limit" | "daily_video_limit" | "photo_limit_mode" | "total_photo_limit" | "created_at"
> & { started_notified_at: number | null };

export type TripEdit = Pick<TripRow, "name" | "ends_at" | "reveal_at" | "daily_photo_limit" | "daily_video_limit" | "total_photo_limit">;

export async function joinCodeExists(db: D1Database, joinCode: string): Promise<boolean> {
  return (await db.prepare("SELECT 1 FROM trips WHERE join_code = ?").bind(joinCode).first()) !== null;
}

export function findTripById(db: D1Database, id: string): Promise<TripRow | null> {
  return db.prepare("SELECT * FROM trips WHERE id = ?").bind(id).first<TripRow>();
}

export function findTripByJoinCode(db: D1Database, joinCode: string): Promise<TripRow | null> {
  return db.prepare("SELECT * FROM trips WHERE join_code = ?").bind(joinCode).first<TripRow>();
}

export function insertTrip(db: D1Database, t: NewTrip): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO trips (id, name, join_code, timezone, starts_at, ends_at, reveal_at,
                          daily_photo_limit, daily_video_limit, photo_limit_mode, total_photo_limit, created_at, started_notified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      t.id, t.name, t.join_code, t.timezone, t.starts_at, t.ends_at, t.reveal_at,
      t.daily_photo_limit, t.daily_video_limit, t.photo_limit_mode, t.total_photo_limit, t.created_at, t.started_notified_at,
    );
}

export function insertAdminMember(db: D1Database, id: string, tripId: string, userId: string, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO members (id, trip_id, user_id, role, created_at)
       VALUES (?, ?, ?, 'admin', ?)`,
    )
    .bind(id, tripId, userId, now);
}

export function findMember(db: D1Database, tripId: string, userId: string): Promise<MemberRow | null> {
  return db.prepare("SELECT * FROM members WHERE trip_id = ? AND user_id = ?").bind(tripId, userId).first<MemberRow>();
}

export function insertMember(db: D1Database, id: string, tripId: string, userId: string, now: number, addedBy: string | null): D1PreparedStatement {
  return db
    .prepare("INSERT INTO members (id, trip_id, user_id, role, created_at, added_by_user_id) VALUES (?, ?, ?, 'member', ?, ?)")
    .bind(id, tripId, userId, now, addedBy);
}

/** Brings back someone the admin removed (clears `left_at` too). */
export function reactivateRemovedMember(db: D1Database, memberId: string, addedBy: string | null): D1PreparedStatement {
  return db.prepare("UPDATE members SET removed_at = NULL, left_at = NULL, added_by_user_id = ? WHERE id = ?").bind(addedBy, memberId);
}

/** Brings back someone who left. */
export function reactivateLeftMember(db: D1Database, memberId: string, addedBy: string | null): D1PreparedStatement {
  return db.prepare("UPDATE members SET left_at = NULL, added_by_user_id = ? WHERE id = ?").bind(addedBy, memberId);
}

export function listActiveMembers(db: D1Database, tripId: string): Promise<{ results: ActiveMemberRow[] }> {
  return db
    .prepare(
      `SELECT m.id, m.user_id, m.role, u.name, u.username, u.avatar_key
       FROM members m JOIN users u ON u.id = m.user_id
       WHERE m.trip_id = ? AND m.removed_at IS NULL AND m.left_at IS NULL ORDER BY m.created_at`,
    )
    .bind(tripId)
    .all<ActiveMemberRow>();
}

/** How many media of each type the member registered on a local date (pending ones count). */
export function countMediaByType(db: D1Database, memberId: string, localDate: string): Promise<{ results: { type: string; n: number }[] }> {
  return db
    .prepare(
      `SELECT type, COUNT(*) AS n FROM media
       WHERE member_id = ? AND local_date = ? GROUP BY type`,
    )
    .bind(memberId, localDate)
    .all<{ type: string; n: number }>();
}

/** All the media of a member in the whole rollo (pending and admin-deleted ones count, like the daily quota). */
export function countMediaByTypeTotal(db: D1Database, memberId: string): Promise<{ results: { type: string; n: number }[] }> {
  return db
    .prepare("SELECT type, COUNT(*) AS n FROM media WHERE member_id = ? GROUP BY type")
    .bind(memberId)
    .all<{ type: string; n: number }>();
}

export function countUploadedMedia(db: D1Database, tripId: string): Promise<{ n: number } | null> {
  return db
    .prepare(`SELECT COUNT(*) AS n FROM media WHERE trip_id = ? AND status = 'uploaded' AND deleted_at IS NULL`)
    .bind(tripId)
    .first<{ n: number }>();
}

export function updateTrip(db: D1Database, tripId: string, next: TripEdit): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE trips SET name = ?, ends_at = ?, reveal_at = ?, daily_photo_limit = ?, daily_video_limit = ?, total_photo_limit = ?
     WHERE id = ?`,
    )
    .bind(next.name, next.ends_at, next.reveal_at, next.daily_photo_limit, next.daily_video_limit, next.total_photo_limit, tripId);
}

export function markRevealed(db: D1Database, tripId: string, now: number): D1PreparedStatement {
  return db.prepare("UPDATE trips SET revealed_at = ? WHERE id = ? AND revealed_at IS NULL").bind(now, tripId);
}

export function markLeft(db: D1Database, memberId: string, now: number): D1PreparedStatement {
  return db.prepare("UPDATE members SET left_at = ? WHERE id = ?").bind(now, memberId);
}

export function markRemoved(db: D1Database, memberId: string, tripId: string, now: number): D1PreparedStatement {
  return db
    .prepare("UPDATE members SET removed_at = ? WHERE id = ? AND trip_id = ? AND removed_at IS NULL")
    .bind(now, memberId, tripId);
}
