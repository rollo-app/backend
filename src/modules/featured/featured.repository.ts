import { FEATURING_ALLOWED_SQL } from "../../lib/featuring";
import { hiddenMediaSql } from "../../lib/moderation";
import type { MediaRow, TripRow, UserRow } from "../../types";

// Reads execute and return rows; writes return an unexecuted statement so the service decides
// whether to `.run()` it or group it with others in `db.batch([...])`.

/**
 * Featured rows (`f`) that are visible on their owner's profile: an uploaded, not deleted photo of a revealed
 * rollo the owner is still an active member of, not blocked by its author (unless the owner is the author).
 * VISIBLE_FROM joins `m` (media), `t` (trips) and `author` (the author's membership); VISIBLE_WHERE binds `now`.
 * Also used by the likes and reports modules.
 */
export const VISIBLE_FROM = `
  featured f
  JOIN media m ON m.id = f.media_id
  JOIN trips t ON t.id = m.trip_id
  JOIN members author ON author.id = m.member_id
  JOIN members owner ON owner.trip_id = m.trip_id AND owner.user_id = f.user_id
                    AND owner.removed_at IS NULL AND owner.left_at IS NULL`;
export const VISIBLE_WHERE = `
  m.type = 'photo' AND m.status = 'uploaded' AND m.deleted_at IS NULL
  AND (t.revealed_at IS NOT NULL OR t.reveal_at <= ?)
  AND (m.feature_blocked_at IS NULL OR author.user_id = f.user_id)`;

export type FeaturableMedia = Pick<MediaRow, "id" | "type" | "feature_blocked_at"> &
  Pick<TripRow, "revealed_at" | "reveal_at" | "featuring_disabled"> & {
    author_user_id: string;
    member_allow_featuring: number;
    account_allow_featuring: number;
  };

export type FeaturedPhotoRow = {
  id: string; taken_at: number; width: number | null; height: number | null; thumbhash: string | null;
  lat: number | null; lng: number | null;
  author_user_id: string; author_name: string | null; author_username: string | null; author_avatar_key: string | null;
  like_count: number; liked_by_me: number;
};

/** The media if it exists, is uploaded and not deleted, and `userId` is an active member of its rollo. */
export function findFeaturableMedia(db: D1Database, userId: string, mediaId: string): Promise<FeaturableMedia | null> {
  return db
    .prepare(
      `SELECT m.id, m.type, m.feature_blocked_at, author.user_id AS author_user_id,
            t.revealed_at, t.reveal_at, t.featuring_disabled,
            author.allow_featuring AS member_allow_featuring,
            COALESCE(author_settings.allow_featuring, 1) AS account_allow_featuring
     FROM media m
     JOIN trips t ON t.id = m.trip_id
     JOIN members author ON author.id = m.member_id
     LEFT JOIN user_settings author_settings ON author_settings.user_id = author.user_id
     JOIN members me ON me.trip_id = m.trip_id AND me.user_id = ? AND me.removed_at IS NULL AND me.left_at IS NULL
     WHERE m.id = ? AND m.status = 'uploaded' AND m.deleted_at IS NULL`,
    )
    .bind(userId, mediaId)
    .first<FeaturableMedia>();
}

export async function isFeatured(db: D1Database, userId: string, mediaId: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 FROM featured WHERE user_id = ? AND media_id = ?").bind(userId, mediaId).first();
  return row !== null;
}

/**
 * One statement, so two concurrent requests can't both slip past the cap.
 * Only photos that still show on the profile count: stale rows can't be removed from the app.
 */
export function insertFeaturedUnderCap(db: D1Database, userId: string, mediaId: string, now: number, max: number): D1PreparedStatement {
  // The featuring levels are checked again here (same statement): a level turned off after the service read it blocks the insert.
  return db
    .prepare(
      `INSERT OR IGNORE INTO featured (user_id, media_id, created_at)
     SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM ${VISIBLE_FROM} WHERE ${VISIBLE_WHERE} AND f.user_id = ?) < ?
       AND EXISTS (SELECT 1 FROM media m JOIN trips t ON t.id = m.trip_id JOIN members author ON author.id = m.member_id
                   WHERE m.id = ? AND ${FEATURING_ALLOWED_SQL})`,
    )
    .bind(userId, mediaId, now, now, userId, max, mediaId, userId);
}

export function deleteFeatured(db: D1Database, userId: string, mediaId: string): D1PreparedStatement {
  return db.prepare("DELETE FROM featured WHERE user_id = ? AND media_id = ?").bind(userId, mediaId);
}

/** Removes the photo from everyone else's profile (the author keeps theirs). */
export function deleteFeaturedByOthers(db: D1Database, mediaId: string, authorUserId: string): D1PreparedStatement {
  return db.prepare("DELETE FROM featured WHERE media_id = ? AND user_id != ?").bind(mediaId, authorUserId);
}

// Cleanups for the featuring levels: turning a level off removes what it now blocks from other profiles.

/** Account level: others' profiles lose every photo `authorUserId` took, in any rollo. */
export function deleteFeaturedByOthersOfAuthor(db: D1Database, authorUserId: string): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM featured WHERE user_id != ? AND media_id IN (
         SELECT m.id FROM media m JOIN members mem ON mem.id = m.member_id WHERE mem.user_id = ?)`,
    )
    .bind(authorUserId, authorUserId);
}

/** Member level: others' profiles lose the photos of one membership. */
export function deleteFeaturedByOthersOfMember(db: D1Database, memberId: string, authorUserId: string): D1PreparedStatement {
  return db
    .prepare("DELETE FROM featured WHERE user_id != ? AND media_id IN (SELECT id FROM media WHERE member_id = ?)")
    .bind(authorUserId, memberId);
}

/** Private rollo: every profile loses the rollo's photos, the authors' own included. */
export function deleteFeaturedOfTrip(db: D1Database, tripId: string): D1PreparedStatement {
  return db.prepare("DELETE FROM featured WHERE media_id IN (SELECT id FROM media WHERE trip_id = ?)").bind(tripId);
}

export function findProfileOwner(db: D1Database, userId: string): Promise<Pick<UserRow, "id" | "profile_visibility"> | null> {
  return db
    .prepare("SELECT id, profile_visibility FROM users WHERE id = ?")
    .bind(userId)
    .first<Pick<UserRow, "id" | "profile_visibility">>();
}

export async function listVisibleFeatured(db: D1Database, viewerId: string, ownerId: string, now: number): Promise<FeaturedPhotoRow[]> {
  const { results } = await db
    .prepare(
      `SELECT m.id, m.taken_at, m.width, m.height, m.thumbhash, m.lat, m.lng,
            author.user_id AS author_user_id, u.name AS author_name, u.username AS author_username, u.avatar_key AS author_avatar_key,
            (SELECT COUNT(*) FROM likes l WHERE l.media_id = m.id) AS like_count,
            EXISTS (SELECT 1 FROM likes ml WHERE ml.media_id = m.id AND ml.user_id = ?) AS liked_by_me
     FROM ${VISIBLE_FROM} JOIN users u ON u.id = author.user_id
     WHERE ${VISIBLE_WHERE} AND f.user_id = ? AND ${hiddenMediaSql("m", "author")}
     ORDER BY m.taken_at DESC, m.id`,
    )
    .bind(viewerId, now, ownerId, viewerId, viewerId)
    .all<FeaturedPhotoRow>();
  return results;
}

export function findVisibleFeaturedKeys(
  db: D1Database,
  viewerId: string,
  ownerId: string,
  mediaId: string,
  now: number,
): Promise<Pick<MediaRow, "original_key" | "thumb_key"> | null> {
  return db
    .prepare(
      `SELECT m.original_key, m.thumb_key FROM ${VISIBLE_FROM}
     WHERE ${VISIBLE_WHERE} AND f.user_id = ? AND f.media_id = ? AND ${hiddenMediaSql("m", "author")}`,
    )
    .bind(now, ownerId, mediaId, viewerId, viewerId)
    .first<Pick<MediaRow, "original_key" | "thumb_key">>();
}
