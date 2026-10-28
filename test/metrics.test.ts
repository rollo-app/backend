import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { computeDailyMetrics, snapshotDailyMetrics, utcDay } from "../src/modules/metrics/metrics.service";
import { DAY, HOUR, api, createTrip, makeSuperadmin, newTrip, signUp, uploadMedia } from "./helpers";

const rows = () => env.DB.prepare("SELECT day, metric, value FROM metrics_daily ORDER BY day, metric").all().then((r) => r.results);

describe("daily metrics", () => {
  it("computes the counts for a UTC day", async () => {
    const { tripId, adminToken } = await newTrip();
    await signUp();
    await uploadMedia(tripId, adminToken);
    const today = utcDay(Date.now());
    const m = await computeDailyMetrics(env, today);
    expect(m).toMatchObject({ users_total: 2, users_new: 2, trips_total: 1, trips_new: 1, trips_open: 1, media_total: 1, media_new: 1, active_users: 2 });
    expect(m.storage_bytes).toBeGreaterThan(0);
  });

  it("snapshot writes yesterday once, and again only on a new day", async () => {
    const now = Date.UTC(2026, 9, 28, 0, 10);
    expect(await snapshotDailyMetrics(env, now)).toBe(true);
    expect((await rows()).every((r: any) => r.day === "2026-10-27")).toBe(true);
    expect(await snapshotDailyMetrics(env, now + 60_000)).toBe(false);
    expect(await snapshotDailyMetrics(env, now + DAY)).toBe(true);
    expect(new Set((await rows()).map((r: any) => r.day))).toEqual(new Set(["2026-10-27", "2026-10-28"]));
  });

  it("GET /admin/metrics returns the series newest-last with the latest day", async () => {
    const su = await makeSuperadmin();
    // Totals are "as of end of day": the user must already exist on the snapshotted day.
    await env.DB.prepare("UPDATE users SET created_at = ? WHERE id = ?").bind(Date.now() - DAY, su.userId).run();
    await snapshotDailyMetrics(env, Date.now());
    const yesterday = utcDay(Date.now() - DAY);
    const r = await api("GET", "/admin/metrics?days=7", { token: su.token });
    expect(r.status).toBe(200);
    expect(r.body.latestDay).toBe(yesterday);
    expect(r.body.series.at(-1)).toMatchObject({ day: yesterday, values: { users_total: 1 } });
    expect((await api("GET", "/admin/metrics?days=0", { token: su.token })).status).toBe(400);
  });

  const D = "2026-03-10";
  const S = Date.UTC(2026, 2, 10);
  const E = S + DAY;
  const run = (sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).run();

  it("respects the day boundaries and exclusions", async () => {
    const { tripId, adminToken, adminUserId } = await newTrip({ dailyPhotoLimit: 10 });
    const u2 = await signUp();
    const u3 = await signUp();
    const trip2 = await createTrip(u2.token, { dailyPhotoLimit: 10 });
    // users: before the day, inside it, exactly at dayEnd (excluded)
    await run("UPDATE users SET created_at = ? WHERE id = ?", S - DAY, adminUserId);
    await run("UPDATE users SET created_at = ? WHERE id = ?", S + HOUR, u2.userId);
    await run("UPDATE users SET created_at = ? WHERE id = ?", E, u3.userId);
    // sessions: at dayStart (inside), just before dayStart, at dayEnd (both outside)
    await run("UPDATE sessions SET last_used_at = ? WHERE user_id = ?", S, u2.userId);
    await run("UPDATE sessions SET last_used_at = ? WHERE user_id = ?", S - 1, adminUserId);
    await run("UPDATE sessions SET last_used_at = ? WHERE user_id = ?", E, u3.userId);
    // media: inside, before, at dayEnd (excluded), deleted, pending
    const inside = await uploadMedia(tripId, adminToken);
    const before = await uploadMedia(tripId, adminToken);
    const atEnd = await uploadMedia(tripId, adminToken);
    const deleted = await uploadMedia(tripId, adminToken);
    await run("UPDATE media SET uploaded_at = ? WHERE id = ?", S + HOUR, inside);
    await run("UPDATE media SET uploaded_at = ? WHERE id = ?", S - HOUR, before);
    await run("UPDATE media SET uploaded_at = ? WHERE id = ?", E, atEnd);
    await run("UPDATE media SET uploaded_at = ?, deleted_at = ? WHERE id = ?", S + HOUR, S + 2 * HOUR, deleted);
    const pending = await uploadMedia(tripId, adminToken);
    await run("UPDATE media SET uploaded_at = ?, status = 'pending' WHERE id = ?", S + HOUR, pending);

    // trip 1: revealed manually inside the day; trip 2: created inside the day, still open
    await run("UPDATE trips SET created_at = ?, starts_at = ?, reveal_at = ?, revealed_at = ? WHERE id = ?", S - DAY, S - DAY, E + DAY, E - HOUR, tripId);
    await run("UPDATE trips SET created_at = ?, starts_at = ?, reveal_at = ?, revealed_at = NULL WHERE id = ?", S + HOUR, S, E + DAY, trip2.tripId);
    const m = await computeDailyMetrics(env, D);
    expect(m).toMatchObject({
      users_total: 2, users_new: 1, active_users: 1,
      trips_total: 2, trips_new: 1, trips_open: 1, trips_revealed_total: 1,
      media_total: 2, media_new: 1,
    });
  });

  it("re-snapshotting the same day after a change upserts the new value", async () => {
    const now = E + HOUR;
    await snapshotDailyMetrics(env, now);
    const get = () => env.DB.prepare("SELECT value FROM metrics_daily WHERE day = ? AND metric = 'users_new'").bind(D).first<{ value: number }>();
    expect((await get())?.value).toBe(0);
    const u = await signUp();
    await run("UPDATE users SET created_at = ? WHERE id = ?", S + HOUR, u.userId);
    await run("DELETE FROM cron_state WHERE key = 'metrics_last_day'");
    expect(await snapshotDailyMetrics(env, now)).toBe(true);
    expect((await get())?.value).toBe(1);
    expect((await rows()).length).toBe(10);
  });
});
