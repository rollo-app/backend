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
