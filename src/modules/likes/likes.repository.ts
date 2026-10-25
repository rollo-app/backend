import { hiddenMediaSql } from "../../lib/moderation";
import type { MediaRow, TripRow, UserRow } from "../../types";
// A repository importing another module's SQL fragments is OK for now: the likes visibility rules mirror the featured ones.
import { VISIBLE_FROM, VISIBLE_WHERE } from "../featured/featured.repository";

// Reads execute and return rows; writes return an unexecuted statement so the service decides
// whether to `.run()` it or group it with others in `db.batch([...])`.

export type LikeableRow = Pick<MediaRow, "id" | "type" | "trip_id"> &
  Pick<TripRow, "revealed_at" | "reveal_at"> & { author_user_id: string; is_member: number };

/** The live uploaded media the viewer hasn't hidden (reported or blocked author), with whether they are an active member of its rollo. */
export function findLikeableRow(db: D1Database, viewerId: string, mediaId: string): Promise<LikeableRow | null> {
  return db
    .prepare(
      `SELECT m.id, m.type, m.trip_id, author.user_id AS author_user_id, t.revealed_at, t.reveal_at,
              EXISTS (SELECT 1 FROM members me WHERE me.trip_id = m.trip_id AND me.user_id = ?
                        AND me.removed_at IS NULL AND me.left_at IS NULL) AS is_member
       FROM media m JOIN trips t ON t.id = m.trip_id JOIN members author ON author.id = m.member_id
       WHERE m.id = ? AND m.status = 'uploaded' AND m.deleted_at IS NULL AND ${hiddenMediaSql("m", "author")}`,
    )
    .bind(viewerId, mediaId, viewerId, viewerId)
    .first<LikeableRow>();
}

/** The profiles where the photo shows as featured right now (only photos ever do). */
export async function listFeaturedOwners(db: D1Database, mediaId: string, now: number): Promise<Pick<UserRow, "id" | "profile_visibility">[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT u.id, u.profile_visibility FROM ${VISIBLE_FROM} JOIN users u ON u.id = f.user_id
       WHERE ${VISIBLE_WHERE} AND f.media_id = ?`,
    )
    .bind(now, mediaId)
    .all<Pick<UserRow, "id" | "profile_visibility">>();
  return results;
}

export function insertLike(db: D1Database, userId: string, mediaId: string, now: number): D1PreparedStatement {
  return db.prepare("INSERT OR IGNORE INTO likes (user_id, media_id, created_at) VALUES (?, ?, ?)").bind(userId, mediaId, now);
}

export function deleteLike(db: D1Database, userId: string, mediaId: string): D1PreparedStatement {
  return db.prepare("DELETE FROM likes WHERE user_id = ? AND media_id = ?").bind(userId, mediaId);
}

export type LikedPhotoRow = {
  media_id: string;
  liked_at: number;
  author_user_id: string;
  trip_id: string;
  thumbhash: string | null;
  via_trip: number;
  featured_owner_id: string | null;
};

/**
 * `viewer_id` / `now` as columns of a one-row subquery (`v`), so the visibility rules can mention them anywhere
 * without repeating binds. Binds, in order: viewer id, now.
 */
const VIEWER = "CROSS JOIN (SELECT ? AS viewer_id, ? AS now) v";

/** Active member of the photo's revealed rollo. */
const VIA_TRIP = `((t.revealed_at IS NOT NULL OR t.reveal_at <= v.now)
  AND EXISTS (SELECT 1 FROM members me WHERE me.trip_id = m.trip_id AND me.user_id = v.viewer_id AND me.removed_at IS NULL AND me.left_at IS NULL))`;

/**
 * The profile owner (the viewer's own profile first) where the photo shows as featured and the viewer can see it:
 * `canSeeProfile` in SQL (themself, or no block either way and public or a friend) over the rules of `VISIBLE_FROM`/`VISIBLE_WHERE`.
 */
const FEATURED_OWNER = `(SELECT f.user_id FROM featured f
    JOIN members owner ON owner.trip_id = m.trip_id AND owner.user_id = f.user_id AND owner.removed_at IS NULL AND owner.left_at IS NULL
    JOIN users u ON u.id = f.user_id
    WHERE f.media_id = m.id
      AND (t.revealed_at IS NOT NULL OR t.reveal_at <= v.now)
      AND (m.feature_blocked_at IS NULL OR author.user_id = f.user_id)
      AND (f.user_id = v.viewer_id OR (
        NOT EXISTS (SELECT 1 FROM blocks pb WHERE (pb.blocker_id = f.user_id AND pb.blocked_id = v.viewer_id) OR (pb.blocker_id = v.viewer_id AND pb.blocked_id = f.user_id))
        AND (u.profile_visibility = 'public'
             OR EXISTS (SELECT 1 FROM friendships fr WHERE fr.user_a = MIN(f.user_id, v.viewer_id) AND fr.user_b = MAX(f.user_id, v.viewer_id)))))
    ORDER BY (f.user_id = v.viewer_id) DESC, f.created_at, f.user_id
    LIMIT 1)`;

/** Photos the viewer liked, not reported or blocked, and can open today by either way. */
const VISIBLE_LIKES = `
  FROM likes l
  JOIN media m ON m.id = l.media_id
  JOIN trips t ON t.id = m.trip_id
  JOIN members author ON author.id = m.member_id
  ${VIEWER}
  WHERE l.user_id = v.viewer_id
    AND m.type = 'photo' AND m.status = 'uploaded' AND m.deleted_at IS NULL
    AND m.id NOT IN (SELECT media_id FROM reports WHERE reporter_id = v.viewer_id AND media_id IS NOT NULL)
    AND author.user_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = v.viewer_id)
    AND NOT EXISTS (SELECT 1 FROM blocks ab WHERE ab.blocker_id = author.user_id AND ab.blocked_id = v.viewer_id)
    AND (${VIA_TRIP} OR ${FEATURED_OWNER} IS NOT NULL)`;

export type LikesCursor = { likedAt: number; mediaId: string };

/** One page (`limit` rows), newest like first; ties broken by media id so a cursor never skips or repeats. */
export async function listVisibleLikes(
  db: D1Database,
  viewerId: string,
  now: number,
  limit: number,
  after: LikesCursor | null,
): Promise<LikedPhotoRow[]> {
  const cursorSql = after ? "AND (l.created_at < ? OR (l.created_at = ? AND m.id < ?))" : "";
  const cursorBinds = after ? [after.likedAt, after.likedAt, after.mediaId] : [];
  const { results } = await db
    .prepare(
      `SELECT m.id AS media_id, l.created_at AS liked_at, author.user_id AS author_user_id, m.trip_id, m.thumbhash,
              ${VIA_TRIP} AS via_trip, ${FEATURED_OWNER} AS featured_owner_id
       ${VISIBLE_LIKES} ${cursorSql}
       ORDER BY l.created_at DESC, m.id DESC LIMIT ?`,
    )
    // The viewer/now binds come once for each place `v` is declared: the select list reuses the same `v` from FROM.
    .bind(viewerId, now, ...cursorBinds, limit)
    .all<LikedPhotoRow>();
  return results;
}

export async function countVisibleLikes(db: D1Database, viewerId: string, now: number): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n ${VISIBLE_LIKES}`).bind(viewerId, now).first<{ n: number }>();
  return row?.n ?? 0;
}
