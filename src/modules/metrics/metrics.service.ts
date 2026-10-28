import { storageUsage } from "../../lib/storage";
import type { Env } from "../../types";
import * as repo from "./metrics.repository";

export const METRICS = [
  "users_total", "users_new", "trips_total", "trips_new", "trips_open",
  "trips_revealed_total", "media_total", "media_new", "storage_bytes", "active_users",
] as const;
export type Metric = (typeof METRICS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;
const LAST_DAY_KEY = "metrics_last_day";

/** "YYYY-MM-DD" of the UTC day containing `ms`. */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Counts for the UTC day `day`: totals as of its end, `_new` within [00:00, next 00:00). */
export async function computeDailyMetrics(env: Env, day: string): Promise<Record<Metric, number>> {
  const start = Date.parse(`${day}T00:00:00.000Z`);
  const end = start + DAY_MS;
  const db = env.DB;
  const [users_total, users_new, trips_total, trips_new, trips_open, trips_revealed_total, media_total, media_new, active_users, storage_bytes] =
    await Promise.all([
      repo.countUsers(db, end),
      repo.countUsersCreatedBetween(db, start, end),
      repo.countTrips(db, end),
      repo.countTripsCreatedBetween(db, start, end),
      repo.countOpenTrips(db, end),
      repo.countRevealedTrips(db, end),
      repo.countUploadedMedia(db, end),
      repo.countMediaUploadedBetween(db, start, end),
      repo.countActiveSessions(db, start, end),
      storageUsage(env),
    ]);
  return { users_total, users_new, trips_total, trips_new, trips_open, trips_revealed_total, media_total, media_new, storage_bytes, active_users };
}

/** Cron: snapshots the UTC day before `now`, once. Returns true when it wrote. */
export async function snapshotDailyMetrics(env: Env, now: number): Promise<boolean> {
  const day = utcDay(now - DAY_MS);
  if ((await repo.getCronState(env.DB, LAST_DAY_KEY)) === day) return false;
  const values = await computeDailyMetrics(env, day);
  await env.DB.batch([...repo.upsertMetrics(env.DB, day, values), repo.setCronState(env.DB, LAST_DAY_KEY, day)]);
  return true;
}

/** Reads the stored snapshots of the last `days` days, oldest first. Never computes anything. */
export async function getMetrics(
  db: D1Database,
  days: number,
): Promise<{ latestDay: string | null; series: { day: string; values: Partial<Record<Metric, number>> }[] }> {
  const rows = await repo.listMetrics(db, utcDay(Date.now() - days * DAY_MS));
  const byDay = new Map<string, Partial<Record<Metric, number>>>();
  for (const r of rows) {
    const values = byDay.get(r.day) ?? {};
    values[r.metric as Metric] = r.value;
    byDay.set(r.day, values);
  }
  const series = [...byDay].map(([day, values]) => ({ day, values }));
  return { latestDay: series.at(-1)?.day ?? null, series };
}
