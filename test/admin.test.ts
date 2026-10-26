import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { localDate } from "../src/lib/util";
import { TZ, api, joinAs, newTrip, uploadMedia } from "./helpers";

const ENV = { ADMIN_TOKEN: "secret" };
const admin = (method: string, path: string, token: string | null = "secret") =>
  api(method, path, { env: ENV, ...(token && { headers: { authorization: `Bearer ${token}` } }) });

async function setup() {
  const trip = await newTrip();
  const a = await joinAs(trip.code, "Ana");
  const b = await joinAs(trip.code, "Beto");
  const mediaId = await uploadMedia(trip.tripId, b.token);
  return { trip, a, b, mediaId };
}

const feedIds = async (tripId: string, token: string) =>
  (await api("GET", `/trips/${tripId}/feed`, { token })).body.items.map((i: any) => i.id);

describe("/admin", () => {
  it("admin routes are 404 without the token or with a wrong one", async () => {
    const { mediaId, b } = await setup();
    const path = `/admin/media/${mediaId}`;
    expect((await api("DELETE", path)).status).toBe(404); // ADMIN_TOKEN not configured
    expect((await api("DELETE", path, { headers: { authorization: "Bearer secret" } })).status).toBe(404);
    expect((await admin("DELETE", path, null)).status).toBe(404);
    expect((await admin("DELETE", path, "wrong")).status).toBe(404);
    expect((await admin("GET", "/admin/reports", "secreT")).status).toBe(404);
    expect((await admin("DELETE", `/admin/users/${b.userId}`, "nope")).status).toBe(404);
    const row = await env.DB.prepare("SELECT deleted_at d FROM media WHERE id = ?").bind(mediaId).first<{ d: number | null }>();
    expect(row!.d).toBeNull();
  });

  it("DELETE /admin/media removes the photo for everyone", async () => {
    const { trip, a, b, mediaId } = await setup();
    expect(await feedIds(trip.tripId, a.token)).toContain(mediaId);
    expect((await admin("DELETE", `/admin/media/${mediaId}`)).status).toBe(204);
    expect(await feedIds(trip.tripId, a.token)).not.toContain(mediaId);
    expect(await feedIds(trip.tripId, b.token)).not.toContain(mediaId);
    expect(await env.MEDIA.head(`trips/${trip.tripId}/${mediaId}/original.jpg`)).toBeNull();
    expect(await env.MEDIA.head(`trips/${trip.tripId}/${mediaId}/thumb.jpg`)).toBeNull();
    expect((await admin("DELETE", `/admin/media/${mediaId}`)).status).toBe(404);
    expect((await admin("DELETE", `/admin/media/nope`)).status).toBe(404);
  });

  it("DELETE /admin/media of a moment's main photo also deletes its selfie", async () => {
    const trip = await newTrip({ momentMode: "photo_selfie" });
    const day = localDate(Date.now(), TZ);
    await env.DB.prepare("INSERT INTO trip_moments (trip_id, user_id, day, notify_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(trip.tripId, trip.adminUserId, day, Date.now() - 60_000, Date.now())
      .run();
    const main = await uploadMedia(trip.tripId, trip.adminToken, { momentDay: day });
    const selfie = await uploadMedia(trip.tripId, trip.adminToken, { pairedMediaId: main });
    expect((await admin("DELETE", `/admin/media/${main}`)).status).toBe(204);
    const rows = await env.DB.prepare("SELECT id, deleted_at d FROM media WHERE id IN (?, ?)").bind(main, selfie).all<{ id: string; d: number | null }>();
    expect(rows.results.every((r) => r.d !== null)).toBe(true);
    expect(await env.MEDIA.head(`trips/${trip.tripId}/${selfie}/original.jpg`)).toBeNull();
    expect(await env.MEDIA.head(`trips/${trip.tripId}/${selfie}/thumb.jpg`)).toBeNull();
  });

  it("DELETE /admin/users deletes the account like DELETE /me", async () => {
    const { trip, a, b, mediaId } = await setup();
    expect((await admin("DELETE", `/admin/users/${b.userId}`)).status).toBe(204);
    expect((await api("GET", "/me", { token: b.token })).status).toBe(401);
    expect(await feedIds(trip.tripId, a.token)).not.toContain(mediaId);
    expect(await env.MEDIA.head(`trips/${trip.tripId}/${mediaId}/original.jpg`)).toBeNull();
    expect((await admin("DELETE", `/admin/users/${b.userId}`)).status).toBe(404);
  });

  it("GET /admin/reports lists newest first", async () => {
    const { a, b, mediaId } = await setup();
    await api("POST", "/reports", { token: a.token, body: { mediaId, reason: "offensive" } });
    await new Promise((r) => setTimeout(r, 5));
    await api("POST", "/reports", { token: a.token, body: { userId: b.userId, reason: "abuse" } });
    const res = await admin("GET", "/admin/reports?limit=50");
    expect(res.status).toBe(200);
    const mine = res.body.reports.filter((r: any) => r.reporter.id === a.userId);
    expect(mine.map((r: any) => r.reason)).toEqual(["abuse", "offensive"]);
    expect(mine[0].target).toMatchObject({ id: b.userId, name: "Beto" });
    expect(mine[0].target.email).toContain("@");
    expect(mine[0].mediaId).toBeNull();
    expect(mine[1].mediaId).toBe(mediaId);
    expect(mine[1].tripId).toBeTruthy();
    expect(mine[0].reporter).toHaveProperty("username");
    expect((await admin("GET", "/admin/reports?limit=1")).body.reports).toHaveLength(1);
  });

  it("admin routes are not in openapi.json", async () => {
    const res = await api("GET", "/openapi.json");
    expect(Object.keys(res.body.paths).filter((p) => p.startsWith("/admin"))).toEqual([]);
  });
});
