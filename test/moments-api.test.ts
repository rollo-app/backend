import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MOMENT_WINDOW_MS, dayWindow, tripDays } from "../src/lib/moments";
import { getMyMoments } from "../src/modules/moments/moments.service";
import type { TripRow } from "../src/types";
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
    expect(a.body.moments.map((m) => m.day)).toEqual(b.body.moments.map((m) => m.day));
  });

  it("stores but does not return today's moment when its window already ended", async () => {
    const fx = await newTrip({ momentMode: "photo" });
    const trip = await tripRow(fx.tripId);
    const { localDate } = await import("../src/lib/util");
    const now = Date.now();
    const today = localDate(now, trip.timezone);
    const user = { id: fx.adminUserId };
    // Force the draw to the start of every window, then ask after today's moment is over.
    const w = dayWindow(trip, today);
    const later = (w ? w.from : now) + MOMENT_WINDOW_MS + 60_000;
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

  it("404s for someone who is not a member", async () => {
    const fx = await newTrip({ momentMode: "photo" });
    const stranger = await signUp(undefined, "Lu");
    expect((await get(fx.tripId, stranger.token)).status).toBe(404);
  });

  it("404s for someone who left", async () => {
    const fx = await newTrip({ momentMode: "photo" });
    const other = await signUp(undefined, "Cami");
    await join(fx.code, other.token);
    expect((await api("DELETE", `/trips/${fx.tripId}/members/me`, { token: other.token })).status).toBe(204);
    expect((await get(fx.tripId, other.token)).status).toBe(404);
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

void createTrip;
