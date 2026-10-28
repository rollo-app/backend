import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { computeDailyMetrics, snapshotDailyMetrics, utcDay } from "../src/modules/metrics/metrics.service";
import { DAY, api, makeSuperadmin, newTrip, signUp, uploadMedia } from "./helpers";

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
    await env.DB.prepare("UPDATE users SET created_at = ? WHERE id = ?").bind(Date.UTC(2026, 9, 27, 12), su.userId).run();
    await snapshotDailyMetrics(env, Date.UTC(2026, 9, 28, 0, 10));
    const r = await api("GET", "/admin/metrics?days=7", { token: su.token });
    expect(r.status).toBe(200);
    expect(r.body.latestDay).toBe("2026-10-27");
    expect(r.body.series.at(-1)).toMatchObject({ day: "2026-10-27", values: { users_total: 1 } });
    expect((await api("GET", "/admin/metrics?days=0", { token: su.token })).status).toBe(400);
  });
});
