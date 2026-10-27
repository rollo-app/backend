import type { TripRow } from "../../types";

// Reads execute and return rows; writes return an unexecuted statement so the service decides
// whether to `.run()` it or group it with others in `db.batch([...])`.

export type MomentRow = { day: string; notify_at: number };

export type NewMoment = { tripId: string; userId: string; day: string; notifyAt: number; createdAt: number };

/** INSERT OR IGNORE: a row that already exists keeps its drawn time. */
export async function insertMomentsIgnoringExisting(db: D1Database, rows: NewMoment[]): Promise<void> {
  if (rows.length === 0) return;
  const stmt = db.prepare("INSERT OR IGNORE INTO trip_moments (trip_id, user_id, day, notify_at, created_at) VALUES (?, ?, ?, ?, ?)");
  await db.batch(rows.map((r) => stmt.bind(r.tripId, r.userId, r.day, r.notifyAt, r.createdAt)));
}

export async function listUserMoments(db: D1Database, tripId: string, userId: string): Promise<MomentRow[]> {
  const { results } = await db
    .prepare("SELECT day, notify_at FROM trip_moments WHERE trip_id = ? AND user_id = ? ORDER BY day")
    .bind(tripId, userId)
    .all<MomentRow>();
  return results;
}

export function findMoment(db: D1Database, tripId: string, userId: string, day: string): Promise<MomentRow | null> {
  return db
    .prepare("SELECT day, notify_at FROM trip_moments WHERE trip_id = ? AND user_id = ? AND day = ?")
    .bind(tripId, userId, day)
    .first<MomentRow>();
}

/**
 * Stores the moment's photo. Only fills an empty slot, so a concurrent second photo never overwrites the first (check `meta.changes`).
 * `inWindow` tells whether it was taken within the moment window.
 */
export function recordMomentPhoto(
  db: D1Database,
  tripId: string,
  userId: string,
  day: string,
  mediaId: string,
  takenAt: number,
  inWindow: boolean,
): D1PreparedStatement {
  return db
    .prepare(
      "UPDATE trip_moments SET media_id = ?, taken_at = ?, in_window = ? WHERE trip_id = ? AND user_id = ? AND day = ? AND media_id IS NULL",
    )
    .bind(mediaId, takenAt, inWindow ? 1 : 0, tripId, userId, day);
}

/** Stores the moment's selfie in its empty slot, only if `mainId` is the moment's photo. Check `meta.changes`. */
export function recordMomentSelfie(
  db: D1Database,
  tripId: string,
  userId: string,
  day: string,
  selfieId: string,
  mainId: string,
): D1PreparedStatement {
  return db
    .prepare(
      "UPDATE trip_moments SET selfie_media_id = ? WHERE trip_id = ? AND user_id = ? AND day = ? AND selfie_media_id IS NULL AND media_id = ?",
    )
    .bind(selfieId, tripId, userId, day, mainId);
}

/** Which media already fill the moment (null when the moment doesn't exist). */
export function findMomentSlots(
  db: D1Database,
  tripId: string,
  userId: string,
  day: string,
): Promise<{ media_id: string | null; selfie_media_id: string | null } | null> {
  return db
    .prepare("SELECT media_id, selfie_media_id FROM trip_moments WHERE trip_id = ? AND user_id = ? AND day = ?")
    .bind(tripId, userId, day)
    .first<{ media_id: string | null; selfie_media_id: string | null }>();
}

/**
 * Trips the user is an active member of that can have moments to schedule: moment on, not revealed, from 3 days
 * before the start (the app's prefetch window) until the end. Ordered by trip id so the response is deterministic.
 */
export async function listMomentTrips(db: D1Database, userId: string, now: number, prefetchMs: number): Promise<TripRow[]> {
  const { results } = await db
    .prepare(
      `SELECT t.* FROM trips t JOIN members m ON m.trip_id = t.id
       WHERE m.user_id = ? AND m.removed_at IS NULL AND m.left_at IS NULL
         AND t.moment_mode != 'off' AND t.revealed_at IS NULL AND t.reveal_at > ?
         AND t.starts_at - ? <= ? AND t.ends_at > ?
       ORDER BY t.id`,
    )
    .bind(userId, now, prefetchMs, now, now)
    .all<TripRow>();
  return results;
}

/** `media.paired_media_id` of a media (null when it is not a linked image or does not exist). */
export async function findPairedMediaId(db: D1Database, mediaId: string): Promise<string | null> {
  const row = await db.prepare("SELECT paired_media_id FROM media WHERE id = ?").bind(mediaId).first<{ paired_media_id: string | null }>();
  return row?.paired_media_id ?? null;
}
