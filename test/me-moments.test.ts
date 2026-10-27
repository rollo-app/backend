import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DAY, HOUR, api, createTrip, join, joinAs, newTrip, signUp } from "./helpers";

type Moment = { day: string; notifyAt: number };
type MyMoments = { trips: { tripId: string; tripName: string; momentMode: string; moments: Moment[] }[] };

const getAll = (token: string) => api<MyMoments>("GET", "/me/moments", { token });
const getOne = (tripId: string, token: string) => api<{ moments: Moment[] }>("GET", `/trips/${tripId}/moments`, { token });

describe("GET /me/moments", () => {
  it("returns 401 without a session", async () => {
    expect((await api("GET", "/me/moments")).status).toBe(401);
  });

  it("returns an empty list for a user without rollos", async () => {
    const u = await signUp(undefined, "Solo");
    const res = await getAll(u.token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ trips: [] });
  });

  it("lists the trips in the window with name, mode and moments", async () => {
    const fx = await newTrip({ name: "Bariloche", momentMode: "photo_selfie" });
    const res = await getAll(fx.adminToken);
    expect(res.status).toBe(200);
    expect(res.body.trips).toHaveLength(1);
    const t = res.body.trips[0]!;
    expect(t.tripId).toBe(fx.tripId);
    expect(t.tripName).toBe("Bariloche");
    expect(t.momentMode).toBe("photo_selfie");
    expect(t.moments.length).toBeGreaterThan(0);
    console.log(JSON.stringify(res.body));
  });

  it("matches the per-trip endpoint and does not duplicate rows when both are called", async () => {
    const fx = await newTrip({ momentMode: "photo" });
    const all = await getAll(fx.adminToken);
    const one = await getOne(fx.tripId, fx.adminToken);
    expect(all.body.trips[0]!.moments).toEqual(one.body.moments);
    const again = await getAll(fx.adminToken);
    expect(again.body).toEqual(all.body);
    const { results } = await env.DB.prepare("SELECT day FROM trip_moments WHERE trip_id = ? AND user_id = ?")
      .bind(fx.tripId, fx.adminUserId)
      .all<{ day: string }>();
    expect(new Set(results.map((r) => r.day)).size).toBe(results.length);
    expect(results.length).toBe(one.body.moments.length);
  });

  it("includes several trips, ordered by trip id, and a trip whose moments are empty", async () => {
    const u = await signUp(undefined, "Multi");
    const a = await createTrip(u.token, { momentMode: "photo" });
    const b = await createTrip(u.token, { momentMode: "photo_selfie" });
    // Moment notifications turned off: the trip is still listed, with no moments.
    await api("PATCH", "/me/settings", { token: u.token, body: { notifications: { dailyMoment: false } } });
    const res = await getAll(u.token);
    expect(res.body.trips.map((t) => t.tripId)).toEqual([a.tripId, b.tripId].sort());
    expect(res.body.trips.every((t) => t.moments.length === 0)).toBe(true);
  });

  it("excludes revealed trips, trips with the moment off and trips outside the window", async () => {
    const now = Date.now();
    const u = await signUp(undefined, "Filtros");
    // Trips are created by someone else (creation limits) and the user joins them, then the dates are set.
    const make = async (momentMode: string, dates: { startsAt: number; endsAt: number; revealAt: number }) => {
      const owner = await signUp(undefined, "Dueño");
      const t = await createTrip(owner.token, { momentMode });
      await join(t.code, u.token);
      await env.DB.prepare("UPDATE trips SET starts_at = ?, ends_at = ?, reveal_at = ? WHERE id = ?")
        .bind(dates.startsAt, dates.endsAt, dates.revealAt, t.tripId)
        .run();
      return t.tripId;
    };
    const ongoing = { startsAt: now - DAY, endsAt: now + 9 * DAY, revealAt: now + 10 * DAY };
    const ok = await make("photo", ongoing);
    await make("off", ongoing);
    await make("photo", { startsAt: now - 5 * DAY, endsAt: now + 5 * DAY, revealAt: now - HOUR });
    await make("photo", { startsAt: now - 5 * DAY, endsAt: now - HOUR, revealAt: now + 5 * DAY });
    await make("photo", { startsAt: now + 4 * DAY, endsAt: now + 8 * DAY, revealAt: now + 9 * DAY });
    const early = await make("photo", { startsAt: now + 2 * DAY, endsAt: now + 6 * DAY, revealAt: now + 7 * DAY });
    const res = await getAll(u.token);
    expect(res.body.trips.map((t) => t.tripId)).toEqual([ok, early].sort());
  });

  it("excludes trips the user left or was removed from", async () => {
    const fx = await newTrip({ momentMode: "photo" });
    const left = await joinAs(fx.code, "Fede");
    const removed = await joinAs(fx.code, "Cami");
    expect((await getAll(left.token)).body.trips).toHaveLength(1);
    expect((await api("DELETE", `/trips/${fx.tripId}/members/me`, { token: left.token })).status).toBe(204);
    await env.DB.prepare("UPDATE members SET removed_at = ? WHERE id = ?").bind(Date.now(), removed.memberId).run();
    expect((await getAll(left.token)).body.trips).toEqual([]);
    expect((await getAll(removed.token)).body.trips).toEqual([]);
    expect((await getAll(fx.adminToken)).body.trips).toHaveLength(1);
    void join;
  });
});
