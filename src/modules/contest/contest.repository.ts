import type { TripRow } from "../../types";
import { CONTEST_TIE_REMINDER_MS } from "./contest.rules";
import { hiddenMediaSql } from "../reports/reports.repository";

/** Drops every finalist the organizers chose for the event (the contest was turned off). */
export function deleteFinalists(db: D1Database, tripId: string): D1PreparedStatement {
  return db.prepare("DELETE FROM contest_finalists WHERE trip_id = ?").bind(tripId);
}


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
 * Adds a finalist at the end of the list (`position` = 1 + current max). There is no cap. Re-adding is a no-op (PK conflict).
 */
export function insertFinalist(db: D1Database, tripId: string, mediaId: string, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO contest_finalists (trip_id, media_id, position, created_at)
       SELECT ?1, ?2, COALESCE((SELECT MAX(position) FROM contest_finalists WHERE trip_id = ?1), 0) + 1, ?3`,
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
  authorUsername: string | null;
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
              u.id AS authorUserId, u.name AS authorName, u.username AS authorUsername, u.avatar_key AS authorAvatarKey
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

/** Finalists that count for the tie and the close, the same for everybody: no viewer blocks or reports. */
export async function countableFinalists(db: D1Database, tripId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT f.media_id AS mediaId
       FROM contest_finalists f
       JOIN media m ON m.id = f.media_id
       JOIN members a ON a.id = m.member_id
       WHERE f.trip_id = ? AND m.status = 'uploaded' AND m.deleted_at IS NULL AND m.archived_at IS NULL
         AND a.removed_at IS NULL AND a.left_at IS NULL
       ORDER BY f.position`,
    )
    .bind(tripId)
    .all<{ mediaId: string }>();
  return results.map((r) => r.mediaId);
}

export async function getMyVote(db: D1Database, tripId: string, userId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT media_id FROM contest_votes WHERE trip_id = ? AND user_id = ?")
    .bind(tripId, userId)
    .first<{ media_id: string }>();
  return row?.media_id ?? null;
}

/** Votes per media for the given ids (media with none are absent). Only voters still active in the trip count. */
export async function voteCounts(db: D1Database, tripId: string, mediaIds: string[]): Promise<Map<string, number>> {
  if (mediaIds.length === 0) return new Map();
  const marks = mediaIds.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      `SELECT v.media_id, COUNT(*) AS n FROM contest_votes v
       JOIN members vm ON vm.trip_id = v.trip_id AND vm.user_id = v.user_id AND vm.removed_at IS NULL AND vm.left_at IS NULL
       WHERE v.trip_id = ? AND v.media_id IN (${marks}) GROUP BY v.media_id`,
    )
    .bind(tripId, ...mediaIds)
    .all<{ media_id: string; n: number }>();
  return new Map(results.map((r) => [r.media_id, r.n]));
}

export type WinnerRow = { mediaId: string; authorUserId: string; authorName: string | null; authorUsername: string | null; authorAvatarKey: string | null; available: number };

/** The winning media with its author, regardless of viewer; `available` = 1 while the image can still be shown. */
export function findWinner(db: D1Database, mediaId: string): Promise<WinnerRow | null> {
  return db
    .prepare(
      `SELECT m.id AS mediaId, u.id AS authorUserId, u.name AS authorName, u.username AS authorUsername, u.avatar_key AS authorAvatarKey,
              CASE WHEN m.deleted_at IS NULL AND m.archived_at IS NULL AND m.status = 'uploaded'
                    AND a.removed_at IS NULL AND a.left_at IS NULL THEN 1 ELSE 0 END AS available
       FROM media m JOIN members a ON a.id = m.member_id JOIN users u ON u.id = a.user_id
       WHERE m.id = ?`,
    )
    .bind(mediaId)
    .first<WinnerRow>();
}

/** Epoch ms when the voting of trip `t` ends (same formula as `closesAt` in contest.rules). */
const CLOSES_AT_SQL = (t: string) => `(COALESCE(${t}.revealed_at, ${t}.reveal_at) + ${t}.contest_voting_hours * 3600000)`;

/**
 * Casts or changes the viewer's vote (one row per user and event). Conditional: it writes nothing (`changes` = 0) once
 * the contest was closed or cancelled or the voting window ended, so a vote racing the close cannot change the result.
 */
export function upsertVote(db: D1Database, tripId: string, userId: string, mediaId: string, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO contest_votes (trip_id, user_id, media_id, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?4
       WHERE EXISTS (SELECT 1 FROM trips t WHERE t.id = ?1 AND t.contest_closed_at IS NULL AND t.contest_cancelled_at IS NULL
                     AND ${CLOSES_AT_SQL("t")} > ?4)
       ON CONFLICT (trip_id, user_id) DO UPDATE SET media_id = excluded.media_id, updated_at = excluded.updated_at`,
    )
    .bind(tripId, userId, mediaId, now);
}

// ---------- Cron and close ----------

export const CRON_BATCH = 50;
const CONTEST_ON = "t.type = 'event' AND t.contest_enabled = 1";

/** Countable finalists of trip `t` (same rule as `countableFinalists`), as a SQL subquery. */
const COUNTABLE_COUNT_SQL = `(SELECT COUNT(*) FROM contest_finalists f
  JOIN media m ON m.id = f.media_id JOIN members a ON a.id = m.member_id
  WHERE f.trip_id = t.id AND m.status = 'uploaded' AND m.deleted_at IS NULL AND m.archived_at IS NULL
    AND a.removed_at IS NULL AND a.left_at IS NULL)`;

export type ContestTrip = { id: string; name: string };

/** Ended, unrevealed contests whose organizers were not told yet that they can pick the finalists. */
export async function listToAnnounceSelection(db: D1Database, now: number): Promise<ContestTrip[]> {
  const { results } = await db
    .prepare(
      `SELECT t.id, t.name FROM trips t
       WHERE ${CONTEST_ON} AND t.contest_select_notified_at IS NULL AND t.ends_at <= ?1 AND t.revealed_at IS NULL AND t.reveal_at > ?1
       LIMIT ${CRON_BATCH}`,
    )
    .bind(now)
    .all<ContestTrip>();
  return results;
}

export function claimSelectionNotice(db: D1Database, tripId: string, now: number): D1PreparedStatement {
  return db.prepare("UPDATE trips SET contest_select_notified_at = ? WHERE id = ? AND contest_select_notified_at IS NULL").bind(now, tripId);
}

/** Unrevealed contests within `leadMs` of the reveal, past the end, with fewer than 2 countable finalists and no reminder yet. */
export async function listToRemind(db: D1Database, now: number, leadMs: number): Promise<ContestTrip[]> {
  const { results } = await db
    .prepare(
      `SELECT t.id, t.name FROM trips t
       WHERE ${CONTEST_ON} AND t.contest_reminder_notified_at IS NULL AND t.ends_at <= ?1 AND t.revealed_at IS NULL
         AND t.reveal_at > ?1 AND t.reveal_at - ?2 <= ?1 AND ${COUNTABLE_COUNT_SQL} < 2
       LIMIT ${CRON_BATCH}`,
    )
    .bind(now, leadMs)
    .all<ContestTrip>();
  return results;
}

export function claimReminder(db: D1Database, tripId: string, now: number): D1PreparedStatement {
  return db.prepare("UPDATE trips SET contest_reminder_notified_at = ? WHERE id = ? AND contest_reminder_notified_at IS NULL").bind(now, tripId);
}

/**
 * Contests past their voting window, neither closed nor cancelled. Ties are not filtered: `claimTieNotice` rate-limits
 * the tie push, and a tie that shrank to one leader must close on the next pass.
 */
export async function listToClose(db: D1Database, now: number) {
  const { results } = await db
    .prepare(
      `SELECT t.* FROM trips t
       WHERE ${CONTEST_ON} AND t.contest_closed_at IS NULL AND t.contest_cancelled_at IS NULL AND ${CLOSES_AT_SQL("t")} <= ?1
       ORDER BY t.contest_tie_notified_at IS NOT NULL, t.contest_tie_notified_at ASC, t.id
       LIMIT ${CRON_BATCH}`,
    )
    .bind(now)
    .all<TripRow>();
  return results;
}

/** Closes the contest with its winner; changes a row only for the caller that closed it. */
export function claimClose(db: D1Database, tripId: string, mediaId: string, now: number): D1PreparedStatement {
  return db
    .prepare(
      "UPDATE trips SET contest_closed_at = ?, contest_winner_media_id = ? WHERE id = ? AND contest_closed_at IS NULL AND contest_cancelled_at IS NULL",
    )
    .bind(now, mediaId, tripId);
}

/** Cancels the contest; changes a row only for the caller that cancelled it. */
export function claimCancel(db: D1Database, tripId: string, now: number): D1PreparedStatement {
  return db
    .prepare("UPDATE trips SET contest_cancelled_at = ? WHERE id = ? AND contest_enabled = 1 AND contest_cancelled_at IS NULL AND contest_closed_at IS NULL")
    .bind(now, tripId);
}

/** Marks the tie as notified now, at most once every 24 h; changes a row only for the caller that may notify. */
export function claimTieNotice(db: D1Database, tripId: string, now: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE trips SET contest_tie_notified_at = ?1
       WHERE id = ?2 AND contest_closed_at IS NULL AND contest_cancelled_at IS NULL
         AND (contest_tie_notified_at IS NULL OR contest_tie_notified_at <= ?1 - ${CONTEST_TIE_REMINDER_MS})`,
    )
    .bind(now, tripId);
}

/** User ids of the event's active members; only the organizers (active admins) with `organizers`. */
export async function activeMemberUserIds(db: D1Database, tripId: string, organizers = false): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT user_id FROM members WHERE trip_id = ? AND removed_at IS NULL AND left_at IS NULL ${organizers ? "AND role = 'admin'" : ""}`,
    )
    .bind(tripId)
    .all<{ user_id: string }>();
  return results.map((r) => r.user_id);
}

export function deleteVote(db: D1Database, tripId: string, userId: string): D1PreparedStatement {
  return db.prepare("DELETE FROM contest_votes WHERE trip_id = ? AND user_id = ?").bind(tripId, userId);
}

export type FinalistKeys = { originalKey: string; thumbKey: string; displayKey: string | null; originalPurgedAt: number | null };

/** Storage keys of a finalist's files (the caller already checked it is a valid finalist for the viewer). */
export function findFinalistKeys(db: D1Database, tripId: string, mediaId: string): Promise<FinalistKeys | null> {
  return db
    .prepare(
      `SELECT m.original_key AS originalKey, m.thumb_key AS thumbKey, m.display_key AS displayKey, m.original_purged_at AS originalPurgedAt
       FROM contest_finalists f JOIN media m ON m.id = f.media_id WHERE f.trip_id = ? AND f.media_id = ?`,
    )
    .bind(tripId, mediaId)
    .first<FinalistKeys>();
}
