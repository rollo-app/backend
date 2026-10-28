export type MetricDaily = { day: string; metric: string; value: number };

const count = async (stmt: D1PreparedStatement): Promise<number> => (await stmt.first<{ n: number }>())?.n ?? 0;

export const countUsers = (db: D1Database, before: number) =>
  count(db.prepare("SELECT COUNT(*) AS n FROM users WHERE created_at < ?").bind(before));

export const countUsersCreatedBetween = (db: D1Database, from: number, to: number) =>
  count(db.prepare("SELECT COUNT(*) AS n FROM users WHERE created_at >= ? AND created_at < ?").bind(from, to));

export const countTrips = (db: D1Database, before: number) =>
  count(db.prepare("SELECT COUNT(*) AS n FROM trips WHERE created_at < ?").bind(before));

export const countTripsCreatedBetween = (db: D1Database, from: number, to: number) =>
  count(db.prepare("SELECT COUNT(*) AS n FROM trips WHERE created_at >= ? AND created_at < ?").bind(from, to));

/** Trips that had started and not been revealed (manually or automatically) at instant `at`. */
export const countOpenTrips = (db: D1Database, at: number) =>
  count(db.prepare("SELECT COUNT(*) AS n FROM trips WHERE starts_at <= ? AND revealed_at IS NULL AND reveal_at > ?").bind(at, at));

export const countRevealedTrips = (db: D1Database, before: number) =>
  count(
    db
      .prepare("SELECT COUNT(*) AS n FROM trips WHERE (revealed_at IS NOT NULL AND revealed_at < ?) OR reveal_at < ?")
      .bind(before, before),
  );

export const countUploadedMedia = (db: D1Database, before: number) =>
  count(db.prepare("SELECT COUNT(*) AS n FROM media WHERE status = 'uploaded' AND deleted_at IS NULL AND uploaded_at < ?").bind(before));

export const countMediaUploadedBetween = (db: D1Database, from: number, to: number) =>
  count(
    db
      .prepare("SELECT COUNT(*) AS n FROM media WHERE status = 'uploaded' AND deleted_at IS NULL AND uploaded_at >= ? AND uploaded_at < ?")
      .bind(from, to),
  );

export const countActiveSessions = (db: D1Database, from: number, to: number) =>
  count(db.prepare("SELECT COUNT(DISTINCT user_id) AS n FROM sessions WHERE last_used_at >= ? AND last_used_at < ?").bind(from, to));

export function upsertMetrics(db: D1Database, day: string, values: Record<string, number>): D1PreparedStatement[] {
  return Object.entries(values).map(([metric, value]) =>
    db
      .prepare("INSERT INTO metrics_daily (day, metric, value) VALUES (?, ?, ?) ON CONFLICT(day, metric) DO UPDATE SET value = excluded.value")
      .bind(day, metric, value),
  );
}

export async function listMetrics(db: D1Database, fromDay: string): Promise<MetricDaily[]> {
  const { results } = await db
    .prepare("SELECT day, metric, value FROM metrics_daily WHERE day >= ? ORDER BY day ASC")
    .bind(fromDay)
    .all<MetricDaily>();
  return results;
}

export const getCronState = async (db: D1Database, key: string): Promise<string | null> =>
  (await db.prepare("SELECT value FROM cron_state WHERE key = ?").bind(key).first<{ value: string }>())?.value ?? null;

export const setCronState = (db: D1Database, key: string, value: string) =>
  db.prepare("INSERT INTO cron_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value);
