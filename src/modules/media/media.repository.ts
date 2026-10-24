import { hiddenMediaSql } from "../../lib/moderation";
import type { MediaRow, MediaType } from "../../types";

// Reads execute and return rows; writes return an unexecuted statement so the service decides
// whether to `.run()` it or group it with others in `db.batch([...])`.

export type FeedRow = {
  id: string; type: MediaType; taken_at: number; local_date: string; lat: number | null; lng: number | null;
  caption: string | null; thumbhash: string | null; duration_s: number | null; width: number | null; height: number | null;
  author_id: string; author_name: string | null; author_username: string | null; author_user_id: string; author_avatar_key: string | null;
  feature_blocked_at: number | null; featured_by_me: number; like_count: number; liked_by_me: number;
};

export type AuthoredMedia = Pick<MediaRow, "id" | "trip_id"> & { author_user_id: string };

export type NewMedia = Pick<
  MediaRow,
  | "id" | "trip_id" | "member_id" | "type" | "taken_at" | "local_date" | "lat" | "lng" | "accuracy_m" | "caption" | "thumbhash"
  | "duration_s" | "width" | "height" | "size_bytes" | "thumb_size_bytes" | "original_key" | "thumb_key" | "created_at"
>;

export function findMediaById(db: D1Database, id: string): Promise<MediaRow | null> {
  return db.prepare("SELECT * FROM media WHERE id = ?").bind(id).first<MediaRow>();
}

/** Not deleted. */
export function findLiveMediaById(db: D1Database, id: string): Promise<MediaRow | null> {
  return db.prepare("SELECT * FROM media WHERE id = ? AND deleted_at IS NULL").bind(id).first<MediaRow>();
}

/** The member's own media, not deleted. */
export function findOwnLiveMedia(db: D1Database, id: string, memberId: string): Promise<MediaRow | null> {
  return db.prepare("SELECT * FROM media WHERE id = ? AND member_id = ? AND deleted_at IS NULL").bind(id, memberId).first<MediaRow>();
}

export function mediaExistsInTrip(db: D1Database, id: string, tripId: string): Promise<boolean> {
  return db.prepare("SELECT 1 FROM media WHERE id = ? AND trip_id = ?").bind(id, tripId).first().then((row) => row !== null);
}

/** Pending ones count too, and so do the ones deleted by the admin. */
export async function countMemberMediaOnDay(db: D1Database, memberId: string, day: string, type: MediaType): Promise<number> {
  const count = await db
    .prepare("SELECT COUNT(*) AS n FROM media WHERE member_id = ? AND local_date = ? AND type = ?")
    .bind(memberId, day, type)
    .first<{ n: number }>();
  return count?.n ?? 0;
}

export function insertMedia(db: D1Database, m: NewMedia): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO media (id, trip_id, member_id, type, taken_at, local_date, lat, lng, accuracy_m,
                        caption, thumbhash, duration_s, width, height, size_bytes, thumb_size_bytes, original_key, thumb_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      m.id, m.trip_id, m.member_id, m.type, m.taken_at, m.local_date, m.lat, m.lng, m.accuracy_m,
      m.caption, m.thumbhash, m.duration_s, m.width, m.height, m.size_bytes, m.thumb_size_bytes,
      m.original_key, m.thumb_key, m.created_at,
    );
}

export function markUploaded(db: D1Database, id: string, now: number, size: number): D1PreparedStatement {
  return db.prepare("UPDATE media SET status = 'uploaded', uploaded_at = ?, size_bytes = ? WHERE id = ?").bind(now, size, id);
}

export function markDeleted(db: D1Database, id: string, now: number): D1PreparedStatement {
  return db.prepare("UPDATE media SET deleted_at = ? WHERE id = ?").bind(now, id);
}

export async function listFeed(db: D1Database, tripId: string, viewerId: string): Promise<FeedRow[]> {
  const { results } = await db
    .prepare(
      `SELECT m.id, m.type, m.taken_at, m.local_date, m.lat, m.lng, m.caption, m.thumbhash, m.duration_s,
            m.width, m.height, mem.id AS author_id, u.name AS author_name, u.username AS author_username, mem.user_id AS author_user_id, u.avatar_key AS author_avatar_key,
            m.feature_blocked_at, f.media_id IS NOT NULL AS featured_by_me,
            COALESCE(lc.n, 0) AS like_count, ml.media_id IS NOT NULL AS liked_by_me
     FROM media m JOIN members mem ON mem.id = m.member_id JOIN users u ON u.id = mem.user_id
     LEFT JOIN featured f ON f.media_id = m.id AND f.user_id = ?
     LEFT JOIN likes ml ON ml.media_id = m.id AND ml.user_id = ?
     LEFT JOIN (SELECT l.media_id, COUNT(*) AS n FROM likes l JOIN media lm ON lm.id = l.media_id
                WHERE lm.trip_id = ? GROUP BY l.media_id) lc ON lc.media_id = m.id
     WHERE m.trip_id = ? AND m.status = 'uploaded' AND m.deleted_at IS NULL AND ${hiddenMediaSql("m", "mem")}
     ORDER BY m.taken_at`,
    )
    .bind(viewerId, viewerId, tripId, tripId, viewerId, viewerId)
    .all<FeedRow>();
  return results;
}

/** Keys of an uploaded, not deleted file of the trip. */
export function findDownloadKeys(db: D1Database, id: string, tripId: string): Promise<Pick<MediaRow, "original_key" | "thumb_key"> | null> {
  return db
    .prepare("SELECT original_key, thumb_key FROM media WHERE id = ? AND trip_id = ? AND status = 'uploaded' AND deleted_at IS NULL")
    .bind(id, tripId)
    .first<Pick<MediaRow, "original_key" | "thumb_key">>();
}

/** Not deleted media with its author's user id (media's member → user). */
export function findAuthoredMedia(db: D1Database, id: string): Promise<AuthoredMedia | null> {
  return db
    .prepare(
      `SELECT m.id, m.trip_id, author.user_id AS author_user_id
     FROM media m JOIN members author ON author.id = m.member_id
     WHERE m.id = ? AND m.deleted_at IS NULL`,
    )
    .bind(id)
    .first<AuthoredMedia>();
}

export function isActiveTripMember(db: D1Database, tripId: string, userId: string): Promise<boolean> {
  return db
    .prepare("SELECT 1 FROM members WHERE trip_id = ? AND user_id = ? AND removed_at IS NULL AND left_at IS NULL")
    .bind(tripId, userId)
    .first()
    .then((row) => row !== null);
}

export function blockFeaturing(db: D1Database, id: string, now: number): D1PreparedStatement {
  return db.prepare("UPDATE media SET feature_blocked_at = COALESCE(feature_blocked_at, ?) WHERE id = ?").bind(now, id);
}

export function unblockFeaturing(db: D1Database, id: string): D1PreparedStatement {
  return db.prepare("UPDATE media SET feature_blocked_at = NULL WHERE id = ?").bind(id);
}

