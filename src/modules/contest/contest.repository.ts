import { hiddenMediaSql } from "../reports/reports.repository";

/** Drops every finalist the organizers chose for the event (the contest was turned off). */
export function deleteFinalists(db: D1Database, tripId: string): D1PreparedStatement {
  return db.prepare("DELETE FROM contest_finalists WHERE trip_id = ?").bind(tripId);
}

export const MAX_FINALISTS = 10;

export type MediaCheckRow = {
  type: string;
  status: string;
  deleted_at: number | null;
  paired_media_id: string | null;
  trip_id: string;
};

/** The media row with just the fields the finalist rules look at, or null if it does not exist. */
export function findMediaForFinalist(db: D1Database, mediaId: string): Promise<MediaCheckRow | null> {
  return db
    .prepare("SELECT type, status, deleted_at, paired_media_id, trip_id FROM media WHERE id = ?")
    .bind(mediaId)
    .first<MediaCheckRow>();
}

export async function isFinalist(db: D1Database, tripId: string, mediaId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS one FROM contest_finalists WHERE trip_id = ? AND media_id = ?")
    .bind(tripId, mediaId)
    .first();
  return row !== null;
}

export async function countFinalists(db: D1Database, tripId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM contest_finalists WHERE trip_id = ?")
    .bind(tripId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Adds a finalist at the end of the list (`position` = 1 + current max). Atomic: the 10-finalist cap is part of the
 * statement, so two organizers adding at once cannot exceed it. Re-adding is a no-op (PK conflict).
 */
export function insertFinalist(db: D1Database, tripId: string, mediaId: string, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO contest_finalists (trip_id, media_id, position, created_at)
       SELECT ?1, ?2, COALESCE((SELECT MAX(position) FROM contest_finalists WHERE trip_id = ?1), 0) + 1, ?3
       WHERE (SELECT COUNT(*) FROM contest_finalists WHERE trip_id = ?1) < ${MAX_FINALISTS}`,
    )
    .bind(tripId, mediaId, now);
}

export function deleteFinalist(db: D1Database, tripId: string, mediaId: string): D1PreparedStatement {
  return db.prepare("DELETE FROM contest_finalists WHERE trip_id = ? AND media_id = ?").bind(tripId, mediaId);
}

export type FinalistRow = {
  mediaId: string;
  position: number;
  thumbhash: string | null;
  width: number | null;
  height: number | null;
  authorUserId: string;
  authorName: string | null;
  authorAvatarKey: string | null;
};

/**
 * The finalists that count for this viewer: photo not deleted or archived, author still active in the event, and no
 * block (either way) nor report between the viewer and the photo. The single source of "which finalists count" for
 * the GET, voting and closing. Ordered by position.
 */
export async function validFinalists(db: D1Database, tripId: string, viewerUserId: string): Promise<FinalistRow[]> {
  const { results } = await db
    .prepare(
      `SELECT f.media_id AS mediaId, f.position AS position, m.thumbhash AS thumbhash, m.width AS width, m.height AS height,
              u.id AS authorUserId, u.name AS authorName, u.avatar_key AS authorAvatarKey
       FROM contest_finalists f
       JOIN media m ON m.id = f.media_id
       JOIN members a ON a.id = m.member_id
       JOIN users u ON u.id = a.user_id
       WHERE f.trip_id = ? AND m.status = 'uploaded' AND m.deleted_at IS NULL AND m.archived_at IS NULL
         AND a.removed_at IS NULL AND a.left_at IS NULL
         AND ${hiddenMediaSql("m", "a")}
         AND a.user_id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id = ?)
       ORDER BY f.position`,
    )
    .bind(tripId, viewerUserId, viewerUserId, viewerUserId)
    .all<FinalistRow>();
  return results;
}

export async function getMyVote(db: D1Database, tripId: string, userId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT media_id FROM contest_votes WHERE trip_id = ? AND user_id = ?")
    .bind(tripId, userId)
    .first<{ media_id: string }>();
  return row?.media_id ?? null;
}

/** Votes per media for the given ids (media with none are absent). */
export async function voteCounts(db: D1Database, tripId: string, mediaIds: string[]): Promise<Map<string, number>> {
  if (mediaIds.length === 0) return new Map();
  const marks = mediaIds.map(() => "?").join(",");
  const { results } = await db
    .prepare(`SELECT media_id, COUNT(*) AS n FROM contest_votes WHERE trip_id = ? AND media_id IN (${marks}) GROUP BY media_id`)
    .bind(tripId, ...mediaIds)
    .all<{ media_id: string; n: number }>();
  return new Map(results.map((r) => [r.media_id, r.n]));
}

export type WinnerRow = { mediaId: string; authorUserId: string; authorName: string | null; authorAvatarKey: string | null; available: number };

/** The winning media with its author, regardless of viewer; `available` = 1 while the image can still be shown. */
export function findWinner(db: D1Database, mediaId: string): Promise<WinnerRow | null> {
  return db
    .prepare(
      `SELECT m.id AS mediaId, u.id AS authorUserId, u.name AS authorName, u.avatar_key AS authorAvatarKey,
              CASE WHEN m.deleted_at IS NULL AND m.archived_at IS NULL AND m.status = 'uploaded'
                    AND a.removed_at IS NULL AND a.left_at IS NULL THEN 1 ELSE 0 END AS available
       FROM media m JOIN members a ON a.id = m.member_id JOIN users u ON u.id = a.user_id
       WHERE m.id = ?`,
    )
    .bind(mediaId)
    .first<WinnerRow>();
}
