import { and, isNotNull, eq, notInArray, type SQL } from "drizzle-orm";
import { QueryBuilder, type SQLiteColumn } from "drizzle-orm/sqlite-core";
import { blocks, reports } from "../../db/schema";
import type { MediaRow, UserRow } from "../../types";
// A repository importing another module's SQL fragments is OK for now: the visibility rules are the featured ones.
import { VISIBLE_FROM, VISIBLE_WHERE } from "../featured/featured.repository";

// Reads execute and return rows; writes return an unexecuted statement so the service decides
// whether to `.run()` it or group it with others in `db.batch([...])`.

// Visibility rules of reported media and blocked authors. The repositories of comments, featured, likes, me and media
// import them, so the rule lives in one place.
/**
 * SQL boolean fragment to AND into a WHERE clause: hides media the viewer reported and media whose author the viewer blocked.
 * `mediaAlias` is the alias of `media`, `authorMemberAlias` the alias of the author's `members` row.
 * Consumes exactly two binds, in this order, both the viewer's user id: (1) reports, (2) blocks.
 */
export function hiddenMediaSql(mediaAlias: string, authorMemberAlias: string): string {
  return (
    `(${mediaAlias}.id NOT IN (SELECT media_id FROM reports WHERE reporter_id = ? AND media_id IS NOT NULL)` +
    ` AND ${authorMemberAlias}.user_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?))`
  );
}

/**
 * Drizzle version of `hiddenMediaSql`: a condition to AND into a query that hides media the viewer reported and
 * media whose author the viewer blocked. Pass the media id column and the author's user id column (`members.userId`)
 * of the query being built. Same semantics as the string version; no binds to order by hand.
 */
export function notHiddenFor(viewerId: string, mediaId: SQLiteColumn, authorUserId: SQLiteColumn): SQL {
  const qb = new QueryBuilder();
  const reportedByViewer = qb
    .select({ mediaId: reports.mediaId })
    .from(reports)
    .where(and(eq(reports.reporterId, viewerId), isNotNull(reports.mediaId)));
  const blockedByViewer = qb.select({ blockedId: blocks.blockedId }).from(blocks).where(eq(blocks.blockerId, viewerId));
  return and(notInArray(mediaId, reportedByViewer), notInArray(authorUserId, blockedByViewer))!;
}

/** Only the report half of `notHiddenFor`: media the viewer reported (e.g. a moment selfie, whose author's block already applies through its main photo). */
export function notReportedBy(viewerId: string, mediaId: SQLiteColumn): SQL {
  const reportedByViewer = new QueryBuilder()
    .select({ mediaId: reports.mediaId })
    .from(reports)
    .where(and(eq(reports.reporterId, viewerId), isNotNull(reports.mediaId)));
  return notInArray(mediaId, reportedByViewer);
}

export type ReportTargetRow = Pick<UserRow, "id" | "email" | "name" | "username">;

/** Uploaded, not deleted media the viewer can see: an archived one only for its author. */
export function findUploadedMedia(db: D1Database, mediaId: string, viewerId: string): Promise<MediaRow | null> {
  return db
    .prepare(
      `SELECT m.* FROM media m JOIN members author ON author.id = m.member_id
       WHERE m.id = ? AND m.status = 'uploaded' AND m.deleted_at IS NULL AND (m.archived_at IS NULL OR author.user_id = ?)`,
    )
    .bind(mediaId, viewerId)
    .first<MediaRow>();
}

export async function isActiveTripMember(db: D1Database, tripId: string, userId: string): Promise<boolean> {
  const member = await db
    .prepare("SELECT 1 FROM members WHERE trip_id = ? AND user_id = ? AND removed_at IS NULL AND left_at IS NULL")
    .bind(tripId, userId)
    .first();
  return member !== null;
}

/** The profiles where the photo shows as featured right now. */
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

/** A live comment with the media it belongs to (only the fields a report needs). */
export function findLiveComment(db: D1Database, commentId: string): Promise<{ id: string; media_id: string; user_id: string; text: string } | null> {
  return db.prepare("SELECT id, media_id, user_id, text FROM comments WHERE id = ? AND deleted_at IS NULL").bind(commentId).first();
}

export function findMemberUserId(db: D1Database, memberId: string): Promise<{ user_id: string } | null> {
  return db.prepare("SELECT user_id FROM members WHERE id = ?").bind(memberId).first<{ user_id: string }>();
}

export function findReportTarget(db: D1Database, userId: string): Promise<ReportTargetRow | null> {
  return db.prepare("SELECT id, email, name, username FROM users WHERE id = ?").bind(userId).first<ReportTargetRow>();
}

/** Starts flagged as not emailed (`unemailed = 1`): it is cleared once the email goes out. */
export function insertReport(
  db: D1Database,
  r: { id: string; reporterId: string; mediaId: string | null; commentId?: string | null; targetUserId: string; tripId: string | null; reason: string; createdAt: number },
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT OR IGNORE INTO reports (id, reporter_id, media_id, comment_id, target_user_id, trip_id, reason, created_at, unemailed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)",
    )
    .bind(r.id, r.reporterId, r.mediaId, r.commentId ?? null, r.targetUserId, r.tripId, r.reason, r.createdAt);
}

export function findTripName(db: D1Database, tripId: string): Promise<{ name: string } | null> {
  return db.prepare("SELECT name FROM trips WHERE id = ?").bind(tripId).first<{ name: string }>();
}

export function markReportEmailed(db: D1Database, reportId: string): D1PreparedStatement {
  return db.prepare("UPDATE reports SET unemailed = 0 WHERE id = ?").bind(reportId);
}
