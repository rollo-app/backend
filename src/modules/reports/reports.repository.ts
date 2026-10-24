import type { MediaRow, UserRow } from "../../types";
// A repository importing another module's SQL fragments is OK for now: the visibility rules are the featured ones.
import { VISIBLE_FROM, VISIBLE_WHERE } from "../featured/featured.repository";

// Reads execute and return rows; writes return an unexecuted statement so the service decides
// whether to `.run()` it or group it with others in `db.batch([...])`.

export type ReportTargetRow = Pick<UserRow, "id" | "email" | "name" | "username">;

export function findUploadedMedia(db: D1Database, mediaId: string): Promise<MediaRow | null> {
  return db.prepare("SELECT * FROM media WHERE id = ? AND status = 'uploaded' AND deleted_at IS NULL").bind(mediaId).first<MediaRow>();
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

export function findMemberUserId(db: D1Database, memberId: string): Promise<{ user_id: string } | null> {
  return db.prepare("SELECT user_id FROM members WHERE id = ?").bind(memberId).first<{ user_id: string }>();
}

export function findReportTarget(db: D1Database, userId: string): Promise<ReportTargetRow | null> {
  return db.prepare("SELECT id, email, name, username FROM users WHERE id = ?").bind(userId).first<ReportTargetRow>();
}

/** Starts flagged as not emailed (`unemailed = 1`): it is cleared once the email goes out. */
export function insertReport(
  db: D1Database,
  r: { id: string; reporterId: string; mediaId: string | null; targetUserId: string; tripId: string | null; reason: string; createdAt: number },
): D1PreparedStatement {
  return db
    .prepare("INSERT OR IGNORE INTO reports (id, reporter_id, media_id, target_user_id, trip_id, reason, created_at, unemailed) VALUES (?, ?, ?, ?, ?, ?, ?, 1)")
    .bind(r.id, r.reporterId, r.mediaId, r.targetUserId, r.tripId, r.reason, r.createdAt);
}

export function findTripName(db: D1Database, tripId: string): Promise<{ name: string } | null> {
  return db.prepare("SELECT name FROM trips WHERE id = ?").bind(tripId).first<{ name: string }>();
}

export function markReportEmailed(db: D1Database, reportId: string): D1PreparedStatement {
  return db.prepare("UPDATE reports SET unemailed = 0 WHERE id = ?").bind(reportId);
}
