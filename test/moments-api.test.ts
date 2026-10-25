import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MOMENT_WINDOW_MS, dayWindow, tripDays } from "../src/lib/moments";
import { MOMENT_DRAW_DAYS, getMyMoments } from "../src/modules/moments/moments.service";
import type { TripRow } from "../src/types";
import { localDate } from "../src/lib/util";
import { DAY, HOUR, api, createTrip, join, newTrip, signUp } from "./helpers";

type Moment = { day: string; notifyAt: number };

async function tripRow(tripId: string): Promise<TripRow> {
  return (await env.DB.prepare("SELECT * FROM trips WHERE id = ?").bind(tripId).first<TripRow>())!;
}

async function momentRows(tripId: string, userId?: string) {
  const sql = userId
    ? "SELECT * FROM trip_moments WHERE trip_id = ? AND user_id = ? ORDER BY day"
    : "SELECT * FROM trip_moments WHERE trip_id = ? ORDER BY day";
  const stmt = env.DB.prepare(sql);
  const { results } = await (userId ? stmt.bind(tripId, userId) : stmt.bind(tripId)).all<{ day: string; notify_at: number }>();
  return results;
}

const get = (tripId: string, token: string) => api<{ moments: Moment[] }>("GET", `/trips/${tripId}/moments`, { token });

describe("GET /trips/{tripId}/moments", () => {
  it("gives an active member one moment per day with a window, from today to the end, inside each day window", async () => {
    const fx = await newTrip({ momentMode: "photo_selfie" });
    const res = await get(fx.tripId, fx.adminToken);
    expect(res.status).toBe(200);
    const trip = await tripRow(fx.tripId);
    const { localDate } = await import("../src/lib/util");
    const today = localDate(Date.now(), trip.timezone);
    const expected = tripDays(trip).filter((d) => d >= today && dayWindow(trip, d));
    const now = Date.now();
    // Today's moment is only returned while it can still be taken.
    const days = res.body.moments.map((m) => m.day);
    // Everything after today is returned; today's only while it can still be taken.
    expect(days.filter((d) => d !== today)).toEqual(expected.filter((d) => d !== today));
    for (const m of res.body.moments) {
      const w = dayWindow(trip, m.day)!;
      expect(m.notifyAt).toBeGreaterThanOrEqual(w.from);
      expect(m.notifyAt).toBeLessThanOrEqual(w.to);
      expect(m.notifyAt + MOMENT_WINDOW_MS).toBeGreaterThan(now);
    }
    expect((await momentRows(fx.tripId)).length).toBe(expected.length);
  });

  it("returns the same notifyAt when asked twice, with one row per day", async () => {
    const fx = await newTrip({ momentMode: "photo" });
    const a = await get(fx.tripId, fx.adminToken);
    const b = await get(fx.tripId, fx.adminToken);
    expect(b.body.moments).toEqual(a.body.moments);
    const rows = await momentRows(fx.tripId, fx.adminUserId);
    expect(new Set(rows.map((r) => r.day)).size).toBe(rows.length);
  });

  it("keeps each member's moments separate", async () => {
    const fx = await newTrip({ momentMode: "photo" });
    const other = await signUp(undefined, "Cami");
    await join(fx.code, other.token);
    const a = await get(fx.tripId, fx.adminToken);
    const b = await get(fx.tripId, other.token);
    expect(b.status).toBe(200);
    expect(b.body.moments.length).toBeGreaterThan(0);
    expect((await momentRows(fx.tripId, other.userId)).length).toBeGreaterThan(0);
    expect((await momentRows(fx.tripId, fx.adminUserId)).length).toBe((await momentRows(fx.tripId, other.userId)).length);
    void a;
    expect((await momentRows(fx.tripId, fx.adminUserId)).map((r) => r.day)).toEqual((await momentRows(fx.tripId, other.userId)).map((r) => r.day));
  });

  it("stores but does not return today's moment when its window already ended", async () => {
    const fx = await newTrip({ momentMode: "photo" });
    const trip = await tripRow(fx.tripId);
    const { localDate } = await import("../src/lib/util");
    const now = Date.now();
    const today = localDate(now, trip.timezone);
    const user = { id: fx.adminUserId };
    // Draw early (the draw never lands in the past), then ask after today's moment is over.
    const w = dayWindow(trip, today)!;
    await getMyMoments(env.DB, trip, user.id, w.from - 60_000, () => 0);
    const later = w.from + MOMENT_WINDOW_MS + 2 * 60_000;
    const res = await getMyMoments(env.DB, trip, user.id, later, () => 0);
    expect(res.find((m) => m.day === today)).toBeUndefined();
    const rows = await momentRows(fx.tripId, fx.adminUserId);
    expect(rows.find((r) => r.day === today)).toBeDefined();
  });

  it("is empty with no rows when the trip has momentMode off", async () => {
    const fx = await newTrip({ momentMode: "off" });
    const res = await get(fx.tripId, fx.adminToken);
    expect(res.status).toBe(200);
    expect(res.body.moments).toEqual([]);
    expect(await momentRows(fx.tripId)).toEqual([]);
  });

  it("is empty with no rows when the user turned dailyMoment off", async () => {
    const fx = await newTrip({ momentMode: "photo" });
    const patch = await api("PATCH", "/me/settings", { token: fx.adminToken, body: { notifications: { dailyMoment: false } } });
    expect(patch.status).toBe(200);
    const res = await get(fx.tripId, fx.adminToken);
    expect(res.body.moments).toEqual([]);
    expect(await momentRows(fx.tripId)).toEqual([]);
  });

  it("403s for someone who is not a member", async () => {
    const fx = await newTrip({ momentMode: "photo" });
    const stranger = await signUp(undefined, "Lu");
    expect((await get(fx.tripId, stranger.token)).status).toBe(403);
  });

  it("403s for someone who left", async () => {
    const fx = await newTrip({ momentMode: "photo" });
    const other = await signUp(undefined, "Cami");
    await join(fx.code, other.token);
    expect((await api("DELETE", `/trips/${fx.tripId}/members/me`, { token: other.token })).status).toBe(204);
    expect((await get(fx.tripId, other.token)).status).toBe(403);
  });

  it("401s without a session", async () => {
    const fx = await newTrip({ momentMode: "photo" });
    expect((await api("GET", `/trips/${fx.tripId}/moments`)).status).toBe(401);
  });

  it("is empty for a revealed trip", async () => {
    const fx = await newTrip({ momentMode: "photo" });
    await env.DB.prepare("UPDATE trips SET revealed_at = ? WHERE id = ?").bind(Date.now(), fx.tripId).run();
    const res = await get(fx.tripId, fx.adminToken);
    expect(res.body.moments).toEqual([]);
    expect(await momentRows(fx.tripId)).toEqual([]);
  });

  it("is empty for a trip that already ended", async () => {
    const fx = await newTrip({ momentMode: "photo", startsAt: Date.now() - 5 * DAY, endsAt: Date.now() - 2 * HOUR, revealAt: Date.now() + DAY });
    const res = await get(fx.tripId, fx.adminToken);
    expect(res.body.moments).toEqual([]);
  });

  it("starts from today for someone who joins mid-trip, not from the start", async () => {
    const fx = await newTrip({ momentMode: "photo", startsAt: Date.now() - 3 * DAY });
    const late = await signUp(undefined, "Late");
    await join(fx.code, late.token);
    const res = await get(fx.tripId, late.token);
    const trip = await tripRow(fx.tripId);
    const { localDate } = await import("../src/lib/util");
    const today = localDate(Date.now(), trip.timezone);
    expect(res.body.moments.length).toBeGreaterThan(0);
    for (const m of res.body.moments) expect(m.day >= today).toBe(true);
    const rows = await momentRows(fx.tripId, late.userId);
    for (const r of rows) expect(r.day >= today).toBe(true);
  });

  it("never re-draws an existing row", async () => {
    const fx = await newTrip({ momentMode: "photo" });
    const trip = await tripRow(fx.tripId);
    const first = await getMyMoments(env.DB, trip, fx.adminUserId, Date.now(), () => 0);
    const second = await getMyMoments(env.DB, trip, fx.adminUserId, Date.now(), () => 0.99);
    expect(second).toEqual(first);
  });
});

describe("draw horizon", () => {
  it("draws and stores at most 31 days for a 2-year trip, and the next ones on a later request without touching earlier rows", async () => {
    const fx = await newTrip({ momentMode: "photo", startsAt: Date.now() - DAY, endsAt: Date.now() + 730 * DAY, revealAt: Date.now() + 731 * DAY });
    const trip = await tripRow(fx.tripId);
    const now = Date.now();
    const first = await getMyMoments(env.DB, trip, fx.adminUserId, now);
    const rows1 = await momentRows(fx.tripId, fx.adminUserId);
    expect(rows1.length).toBeLessThanOrEqual(MOMENT_DRAW_DAYS);
    expect(rows1.length).toBeGreaterThan(25);
    expect(first.length).toBeLessThanOrEqual(MOMENT_DRAW_DAYS);
    const later = await getMyMoments(env.DB, trip, fx.adminUserId, now + 40 * DAY);
    const rows2 = await momentRows(fx.tripId, fx.adminUserId);
    expect(rows2.length).toBeGreaterThan(rows1.length);
    expect(rows2.length).toBeLessThanOrEqual(rows1.length + MOMENT_DRAW_DAYS);
    for (const r of rows1) expect(rows2.find((x) => x.day === r.day)).toEqual(r);
    expect(later.length).toBeLessThanOrEqual(MOMENT_DRAW_DAYS);
  });
});

describe("today's moment is never drawn in the past", () => {
  // 15:00 and 22:40 local (UTC-3) on a 9-23 band.
  const at = (h: number, m: number) => Date.UTC(2030, 0, 10, h + 3, m);
  const dayOf = (n: number) => localDate(n, "America/Argentina/Buenos_Aires");
  const fixedTrip = () =>
    newTrip({ momentMode: "photo", startsAt: Date.UTC(2030, 0, 9, 12), endsAt: Date.UTC(2030, 0, 14, 12), revealAt: Date.UTC(2030, 0, 15) });

  it("draws today from now + 1 minute when the first request comes at 15:00", async () => {
    const fx = await fixedTrip();
    const trip = await tripRow(fx.tripId);
    const now = at(15, 0);
    const res = await getMyMoments(env.DB, trip, fx.adminUserId, now, () => 0);
    const today = res.find((m) => m.day === dayOf(now));
    expect(today).toBeDefined();
    expect(today!.notifyAt).toBeGreaterThanOrEqual(now + 60_000);
  });

  it("has no moment today when the first request comes at 22:40 (under 30 minutes left)", async () => {
    const fx = await fixedTrip();
    const trip = await tripRow(fx.tripId);
    const now = at(22, 40);
    const res = await getMyMoments(env.DB, trip, fx.adminUserId, now, () => 0);
    expect(res.find((m) => m.day === dayOf(now))).toBeUndefined();
    expect((await momentRows(fx.tripId, fx.adminUserId)).find((r) => r.day === dayOf(now))).toBeUndefined();
    expect(res.length).toBeGreaterThan(0);
  });
});

void createTrip;
