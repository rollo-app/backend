import { sql, type SQL } from "drizzle-orm";
import { hiddenMediaSql } from "../reports/reports.repository";
import type { MediaRow, TripRow, UserRow } from "../../types";

// Reads execute and return rows; writes return an unexecuted statement so the service decides
// whether to `.run()` it or group it with others in `db.batch([...])`.

export type CommentableRow = Pick<MediaRow, "id" | "type" | "trip_id" | "paired_media_id" | "moment_day" | "archived_at"> &
  Pick<TripRow, "revealed_at" | "reveal_at"> & { author_user_id: string; is_member: number; is_admin: number };

export type CommentRow = { id: string; text: string; created_at: number; user_id: string } & Pick<UserRow, "name" | "username" | "avatar_key">;

/** The live uploaded media the viewer hasn't hidden (reported or blocked author), with whether they are an active member (and admin) of its rollo. */
export function findCommentableRow(db: D1Database, viewerId: string, mediaId: string): Promise<CommentableRow | null> {
  return db
    .prepare(
      `SELECT m.id, m.type, m.trip_id, m.paired_media_id, m.moment_day, m.archived_at, author.user_id AS author_user_id, t.revealed_at, t.reveal_at,
              EXISTS (SELECT 1 FROM members me WHERE me.trip_id = m.trip_id AND me.user_id = ?
                        AND me.removed_at IS NULL AND me.left_at IS NULL) AS is_member,
              EXISTS (SELECT 1 FROM members ad WHERE ad.trip_id = m.trip_id AND ad.user_id = ? AND ad.role = 'admin'
                        AND ad.removed_at IS NULL AND ad.left_at IS NULL) AS is_admin
       FROM media m JOIN trips t ON t.id = m.trip_id JOIN members author ON author.id = m.member_id
       WHERE m.id = ? AND m.status = 'uploaded' AND m.deleted_at IS NULL AND ${hiddenMediaSql("m", "author")}
         AND (m.archived_at IS NULL OR author.user_id = ?)`,
    )
    .bind(viewerId, viewerId, mediaId, viewerId, viewerId, viewerId)
    .first<CommentableRow>();
}

/**
 * What a viewer does not see of the comments: deleted ones, from users blocked in either direction, and the ones they reported.
 * Consumes exactly three binds, all the viewer's user id. `commentCountSql` is the same rule for Drizzle queries.
 */
const VISIBLE_COMMENT_WHERE =
  `c.deleted_at IS NULL` +
  ` AND c.user_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?)` +
  ` AND c.user_id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id = ?)` +
  ` AND c.id NOT IN (SELECT comment_id FROM reports WHERE reporter_id = ? AND comment_id IS NOT NULL)`;

/** Correlated subquery for a Drizzle select: how many comments of `mediaIdColumn` the viewer sees. Same rule as `listComments`. */
export function commentCountSql(mediaIdColumn: SQL | { getSQL(): SQL }, viewerId: string): SQL<number> {
  return sql<number>`(SELECT COUNT(*) FROM comments c WHERE c.media_id = ${mediaIdColumn} AND c.deleted_at IS NULL
    AND c.user_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ${viewerId})
    AND c.user_id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id = ${viewerId})
    AND c.id NOT IN (SELECT comment_id FROM reports WHERE reporter_id = ${viewerId} AND comment_id IS NOT NULL))`;
}

/** The comments the viewer sees on a photo, oldest first. */
export async function listComments(db: D1Database, viewerId: string, mediaId: string, limit: number): Promise<CommentRow[]> {
  const { results } = await db
    .prepare(
      `SELECT c.id, c.text, c.created_at, c.user_id, u.name, u.username, u.avatar_key
       FROM comments c JOIN users u ON u.id = c.user_id
       WHERE c.media_id = ? AND ${VISIBLE_COMMENT_WHERE}
       ORDER BY c.created_at, c.rowid LIMIT ?`,
    )
    .bind(mediaId, viewerId, viewerId, viewerId, limit)
    .all<CommentRow>();
  return results;
}

/** A comment of a photo the viewer can otherwise see, with the photo's author. Deleted comments are not found. */
export function findComment(db: D1Database, commentId: string): Promise<{ id: string; media_id: string; user_id: string; text: string } | null> {
  return db
    .prepare("SELECT id, media_id, user_id, text FROM comments WHERE id = ? AND deleted_at IS NULL")
    .bind(commentId)
    .first();
}

export function insertComment(db: D1Database, c: { id: string; mediaId: string; userId: string; text: string; createdAt: number }): D1PreparedStatement {
  return db.prepare("INSERT INTO comments (id, media_id, user_id, text, created_at) VALUES (?, ?, ?, ?, ?)").bind(c.id, c.mediaId, c.userId, c.text, c.createdAt);
}

/** Soft-deletes every live comment of a photo (its author deleted it); reports of them keep their text. */
export function softDeleteCommentsOfMedia(db: D1Database, mediaId: string, now: number): D1PreparedStatement {
  return db.prepare("UPDATE comments SET deleted_at = ? WHERE media_id = ? AND deleted_at IS NULL").bind(now, mediaId);
}

export function softDeleteComment(db: D1Database, commentId: string, now: number): D1PreparedStatement {
  return db.prepare("UPDATE comments SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").bind(now, commentId);
}

/** Statement: how many comments were silenced on the photo since the last push. */
export function selectSilencedComments(db: D1Database, mediaId: string): D1PreparedStatement {
  return db.prepare("SELECT comments_since_notified AS silenced FROM media WHERE id = ?").bind(mediaId);
}

/** Statement: opens a new push window, changing a row only if the previous one is over (`olderThan` = now - window). */
export function claimCommentPushWindow(db: D1Database, mediaId: string, now: number, olderThan: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE media SET comment_notified_at = ?, comments_since_notified = 0
         WHERE id = ? AND (comment_notified_at IS NULL OR comment_notified_at <= ?)`,
    )
    .bind(now, mediaId, olderThan);
}

/** Statement: counts one more silenced comment. */
export function countSilencedComment(db: D1Database, mediaId: string): D1PreparedStatement {
  return db.prepare("UPDATE media SET comments_since_notified = comments_since_notified + 1 WHERE id = ?").bind(mediaId);
}

/** Active members of the rollo (other than the photo's author) with a live comment on the photo. */
export async function listEarlierCommenters(db: D1Database, tripId: string, mediaId: string, authorUserId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT c.user_id FROM comments c
       JOIN members m ON m.trip_id = ? AND m.user_id = c.user_id AND m.removed_at IS NULL AND m.left_at IS NULL
       WHERE c.media_id = ? AND c.deleted_at IS NULL AND c.user_id <> ?`,
    )
    .bind(tripId, mediaId, authorUserId)
    .all<{ user_id: string }>();
  return results.map((r) => r.user_id);
}
