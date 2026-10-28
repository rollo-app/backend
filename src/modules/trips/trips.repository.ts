import type { MemberRow, Role, TripRow } from "../../types";

// Reads execute and return rows; writes return an unexecuted statement so the service decides
// whether to `.run()` it or group it with others in `db.batch([...])`.

export type ActiveMemberRow = {
  id: string; user_id: string; role: Role; name: string | null; username: string | null; avatar_key: string | null;
};

export type NewTrip = Pick<
  TripRow,
  "id" | "name" | "join_code" | "timezone" | "starts_at" | "ends_at" | "reveal_at" | "daily_photo_limit" | "daily_video_limit" | "photo_limit_mode" | "total_photo_limit" | "created_at"
  | "moment_mode" | "moment_window_start" | "moment_window_end"
> & { started_notified_at: number | null; featuring_disabled: number };

export type TripEdit = Pick<TripRow, "name" | "ends_at" | "reveal_at" | "daily_photo_limit" | "daily_video_limit" | "total_photo_limit" | "featuring_disabled">;

export async function joinCodeExists(db: D1Database, joinCode: string): Promise<boolean> {
  return (await db.prepare("SELECT 1 FROM trips WHERE join_code = ?").bind(joinCode).first()) !== null;
}

export function findTripById(db: D1Database, id: string): Promise<TripRow | null> {
  return db.prepare("SELECT * FROM trips WHERE id = ?").bind(id).first<TripRow>();
}

export function findTripByJoinCode(db: D1Database, joinCode: string): Promise<TripRow | null> {
  return db.prepare("SELECT * FROM trips WHERE join_code = ?").bind(joinCode).first<TripRow>();
}

/**
 * Inserts the trip only while the creator is under the limits on rollos they created (skipped with
 * `limited = false`). The check is part of the INSERT, so two concurrent creates cannot both pass.
 */
export function insertTrip(
  db: D1Database,
  t: NewTrip,
  creator: { userId: string; limited: boolean; unrevealedMax: number; windowMax: number; windowSince: number },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO trips (id, name, join_code, timezone, starts_at, ends_at, reveal_at,
                          daily_photo_limit, daily_video_limit, photo_limit_mode, total_photo_limit, created_at, started_notified_at, featuring_disabled,
                          moment_mode, moment_window_start, moment_window_end, created_by_user_id)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE ? = 0 OR (
         (SELECT COUNT(*) FROM trips WHERE created_by_user_id = ? AND revealed_at IS NULL AND reveal_at > ?) < ?
         AND (SELECT COUNT(*) FROM trips WHERE created_by_user_id = ? AND created_at > ?) < ?
       )`,
    )
    .bind(
      t.id, t.name, t.join_code, t.timezone, t.starts_at, t.ends_at, t.reveal_at,
      t.daily_photo_limit, t.daily_video_limit, t.photo_limit_mode, t.total_photo_limit, t.created_at, t.started_notified_at, t.featuring_disabled,
      t.moment_mode, t.moment_window_start, t.moment_window_end, creator.userId,
      creator.limited ? 1 : 0,
      creator.userId, t.created_at, creator.unrevealedMax,
      creator.userId, creator.windowSince, creator.windowMax,
    );
}

export function insertAdminMember(db: D1Database, id: string, tripId: string, userId: string, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO members (id, trip_id, user_id, role, created_at)
       SELECT ?, ?, ?, 'admin', ? WHERE EXISTS (SELECT 1 FROM trips WHERE id = ?)`,
    )
    .bind(id, tripId, userId, now, tripId);
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

/** How many media of each type the member registered on a local date (pending ones count; moment photos never do). */
export function countMediaByType(db: D1Database, memberId: string, localDate: string): Promise<{ results: { type: string; n: number }[] }> {
  return db
    .prepare(
      `SELECT type, COUNT(*) AS n FROM media
       WHERE member_id = ? AND local_date = ? AND moment_day IS NULL GROUP BY type`,
    )
    .bind(memberId, localDate)
    .all<{ type: string; n: number }>();
}

/** All the media of a member in the whole rollo (pending and admin-deleted ones count, like the daily quota). */
export function countMediaByTypeTotal(db: D1Database, memberId: string): Promise<{ results: { type: string; n: number }[] }> {
  return db
    .prepare("SELECT type, COUNT(*) AS n FROM media WHERE member_id = ? AND moment_day IS NULL GROUP BY type")
    .bind(memberId)
    .all<{ type: string; n: number }>();
}

/** Uploaded, not deleted items of the rollo; archived ones only count for their author (`viewerMemberId`), who still sees them. */
export function countUploadedMedia(db: D1Database, tripId: string, viewerMemberId: string): Promise<{ n: number } | null> {
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM media WHERE trip_id = ? AND status = 'uploaded' AND deleted_at IS NULL AND paired_media_id IS NULL
       AND (archived_at IS NULL OR member_id = ?)`,
    )
    .bind(tripId, viewerMemberId)
    .first<{ n: number }>();
}

export function updateTrip(db: D1Database, tripId: string, next: TripEdit): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE trips SET name = ?, ends_at = ?, reveal_at = ?, daily_photo_limit = ?, daily_video_limit = ?, total_photo_limit = ?, featuring_disabled = ?
     WHERE id = ?`,
    )
    .bind(next.name, next.ends_at, next.reveal_at, next.daily_photo_limit, next.daily_video_limit, next.total_photo_limit, next.featuring_disabled, tripId);
}

export function markRevealed(db: D1Database, tripId: string, now: number): D1PreparedStatement {
  return db.prepare("UPDATE trips SET revealed_at = ? WHERE id = ? AND revealed_at IS NULL").bind(now, tripId);
}

/** Leaving also drops the admin role: whoever comes back is a regular member. */
export function markLeft(db: D1Database, memberId: string, now: number): D1PreparedStatement {
  return db.prepare("UPDATE members SET left_at = ?, role = 'member', archived_at = NULL WHERE id = ?").bind(now, memberId);
}

export function markRemoved(db: D1Database, memberId: string, tripId: string, now: number): D1PreparedStatement {
  return db
    .prepare("UPDATE members SET removed_at = ?, role = 'member', archived_at = NULL WHERE id = ? AND trip_id = ? AND removed_at IS NULL")
    .bind(now, memberId, tripId);
}

export function setMemberArchived(db: D1Database, memberId: string, at: number | null): D1PreparedStatement {
  return db.prepare("UPDATE members SET archived_at = ? WHERE id = ?").bind(at, memberId);
}

export function setMemberAllowFeaturing(db: D1Database, memberId: string, allow: boolean): D1PreparedStatement {
  return db.prepare("UPDATE members SET allow_featuring = ? WHERE id = ?").bind(allow ? 1 : 0, memberId);
}

/** Rollos `userId` created (admin) that are not revealed yet: in progress, upcoming or ended. */
export async function countUnrevealedCreated(db: D1Database, userId: string, now: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM trips t
       WHERE t.created_by_user_id = ? AND t.revealed_at IS NULL AND t.reveal_at > ?`,
    )
    .bind(userId, now)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** `created_at` (ascending) of the rollos `userId` created since `since`. */
export async function createdSince(db: D1Database, userId: string, since: number): Promise<number[]> {
  const { results } = await db
    .prepare(
      `SELECT t.created_at FROM trips t
       WHERE t.created_by_user_id = ? AND t.created_at > ? ORDER BY t.created_at ASC`,
    )
    .bind(userId, since)
    .all<{ created_at: number }>();
  return results.map((r) => r.created_at);
}

/** Trips whose start has come and whose "Arrancó" push was not claimed yet. */
export async function listTripsToAnnounceStart(db: D1Database, now: number): Promise<TripRow[]> {
  const { results } = await db.prepare("SELECT * FROM trips WHERE started_notified_at IS NULL AND starts_at <= ?").bind(now).all<TripRow>();
  return results;
}

/** Trips revealed (by the admin or by their date) whose "Se reveló" push was not claimed yet. */
export async function listTripsToAnnounceReveal(db: D1Database, now: number): Promise<TripRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM trips WHERE revealed_notified_at IS NULL AND (revealed_at IS NOT NULL OR reveal_at <= ?)")
    .bind(now)
    .all<TripRow>();
  return results;
}

/** Marks the trip as "started" notified; it changes a row only for the caller that flipped it. */
export function claimStartedNotice(db: D1Database, tripId: string, now: number): D1PreparedStatement {
  return db.prepare("UPDATE trips SET started_notified_at = ? WHERE id = ? AND started_notified_at IS NULL").bind(now, tripId);
}

/** Marks the trip as "revealed" notified; it changes a row only for the caller that flipped it. */
export function claimRevealedNotice(db: D1Database, tripId: string, now: number): D1PreparedStatement {
  return db.prepare("UPDATE trips SET revealed_notified_at = ? WHERE id = ? AND revealed_notified_at IS NULL").bind(now, tripId);
}

/** User ids of the trip's active members (neither left nor removed). */
export async function listActiveMemberUserIds(db: D1Database, tripId: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT user_id FROM members WHERE trip_id = ? AND removed_at IS NULL AND left_at IS NULL")
    .bind(tripId)
    .all<{ user_id: string }>();
  return results.map((r) => r.user_id);
}

/** The rollo's creator (current user name), or null when unknown or their user row is missing. */
export async function findCreator(db: D1Database, trip: Pick<TripRow, "created_by_user_id">): Promise<{ userId: string; name: string } | null> {
  if (!trip.created_by_user_id) return null;
  const row = await db.prepare("SELECT id, name FROM users WHERE id = ?").bind(trip.created_by_user_id).first<{ id: string; name: string | null }>();
  return row ? { userId: row.id, name: row.name ?? "" } : null;
}

/** Active member of the rollo by membership id. */
export function findActiveMemberById(db: D1Database, tripId: string, memberId: string): Promise<MemberRow | null> {
  return db
    .prepare("SELECT * FROM members WHERE id = ? AND trip_id = ? AND removed_at IS NULL AND left_at IS NULL")
    .bind(memberId, tripId)
    .first<MemberRow>();
}

export function setMemberRole(db: D1Database, memberId: string, role: Role): D1PreparedStatement {
  return db.prepare("UPDATE members SET role = ? WHERE id = ?").bind(role, memberId);
}

export function findUserCard(db: D1Database, userId: string): Promise<{ name: string | null; username: string | null; avatar_key: string | null } | null> {
  return db.prepare("SELECT name, username, avatar_key FROM users WHERE id = ?").bind(userId).first();
}

/** Statements that delete a rollo for everyone, in FK order; run them in ONE `db.batch` (a transaction). Queues its R2 keys for the cron purge. */
export function deleteTripStatements(db: D1Database, tripId: string, now: number): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT OR IGNORE INTO r2_purge (key, created_at)
         SELECT original_key, ?1 FROM media WHERE trip_id = ?2
         UNION SELECT thumb_key, ?1 FROM media WHERE trip_id = ?2`,
      )
      .bind(now, tripId),
    db.prepare("INSERT OR IGNORE INTO deleted_trips (trip_id, deleted_at) VALUES (?, ?)").bind(tripId, now),
    db.prepare("DELETE FROM media WHERE trip_id = ?").bind(tripId),
    db.prepare("DELETE FROM members WHERE trip_id = ?").bind(tripId),
    db.prepare("DELETE FROM trips WHERE id = ?").bind(tripId),
  ];
}
