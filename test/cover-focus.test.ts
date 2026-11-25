import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { api, joinAs, newTrip } from "./helpers";
import { BASELINE_JPEG } from "./jpeg-fixture";

const patch = (token: string, tripId: string, body: unknown) => api("PATCH", `/trips/${tripId}`, { token, body });
const focusInList = async (token: string, tripId: string) =>
  (await api("GET", "/me/trips", { token })).body.trips.find((t: { id: string }) => t.id === tripId).coverFocusY;
const focusInDetail = async (token: string, tripId: string) => (await api("GET", `/trips/${tripId}`, { token })).body.trip.coverFocusY;

async function setCover(token: string, tripId: string) {
  const req = await api("POST", `/trips/${tripId}/cover`, { token, body: { sizeBytes: BASELINE_JPEG.length } });
  expect(req.status).toBe(200);
  const row = await env.DB.prepare("SELECT pending_cover_key p FROM trips WHERE id = ?").bind(tripId).first<{ p: string }>();
  await env.MEDIA.put(row!.p, BASELINE_JPEG);
  return api("POST", `/trips/${tripId}/cover/complete`, { token });
}

describe("cover focus (coverFocusY)", () => {
  it("defaults to null, an admin sets it and it shows in /me/trips and /trips/{id}", async () => {
    const t = await newTrip();
    expect(await focusInList(t.adminToken, t.tripId)).toBeNull();
    expect(await focusInDetail(t.adminToken, t.tripId)).toBeNull();
    const res = await patch(t.adminToken, t.tripId, { coverFocusY: 0.2 });
    expect(res.status).toBe(200);
    expect(res.body.trip.coverFocusY).toBe(0.2);
    expect(await focusInList(t.adminToken, t.tripId)).toBe(0.2);
    expect(await focusInDetail(t.adminToken, t.tripId)).toBe(0.2);
  });

  it("null resets it and 0 and 1 are valid", async () => {
    const t = await newTrip();
    expect((await patch(t.adminToken, t.tripId, { coverFocusY: 1 })).status).toBe(200);
    expect(await focusInDetail(t.adminToken, t.tripId)).toBe(1);
    expect((await patch(t.adminToken, t.tripId, { coverFocusY: 0 })).status).toBe(200);
    expect(await focusInDetail(t.adminToken, t.tripId)).toBe(0);
    expect((await patch(t.adminToken, t.tripId, { coverFocusY: null })).status).toBe(200);
    expect(await focusInDetail(t.adminToken, t.tripId)).toBeNull();
  });

  it("rejects values outside 0..1", async () => {
    const t = await newTrip();
    expect((await patch(t.adminToken, t.tripId, { coverFocusY: 1.5 })).status).toBe(400);
    expect((await patch(t.adminToken, t.tripId, { coverFocusY: -0.1 })).status).toBe(400);
    expect(await focusInDetail(t.adminToken, t.tripId)).toBeNull();
  });

  it("a non-admin member gets 403", async () => {
    const t = await newTrip();
    const guest = await joinAs(t.code, "Guest");
    expect((await patch(guest.token, t.tripId, { coverFocusY: 0.3 })).status).toBe(403);
  });

  it("is frozen after the reveal with the per-type message", async () => {
    const t = await newTrip();
    await env.DB.prepare("UPDATE trips SET revealed_at = ? WHERE id = ?").bind(Date.now() - 1000, t.tripId).run();
    const res = await patch(t.adminToken, t.tripId, { coverFocusY: 0.4 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Este rollo ya se reveló.");
    await env.DB.prepare("UPDATE trips SET type = 'event' WHERE id = ?").bind(t.tripId).run();
    expect((await patch(t.adminToken, t.tripId, { coverFocusY: 0.4 })).body.error).toBe("Este evento ya se reveló.");
  });

  it("replacing the cover resets it to null", async () => {
    const t = await newTrip();
    expect((await setCover(t.adminToken, t.tripId)).status).toBe(200);
    await patch(t.adminToken, t.tripId, { coverFocusY: 0.8 });
    expect(await focusInDetail(t.adminToken, t.tripId)).toBe(0.8);
    expect((await setCover(t.adminToken, t.tripId)).status).toBe(200);
    expect(await focusInDetail(t.adminToken, t.tripId)).toBeNull();
    expect(await focusInList(t.adminToken, t.tripId)).toBeNull();
  });

  it("the public preview carries it, so the join link's image frames the cover like the app", async () => {
    const t = await newTrip();
    expect((await api("GET", `/events/${t.code}?any=1`)).body.coverFocusY).toBeNull();
    await patch(t.adminToken, t.tripId, { coverFocusY: 0.25 });
    expect((await api("GET", `/events/${t.code}?any=1`)).body.coverFocusY).toBe(0.25);
  });
});
