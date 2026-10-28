import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { purgeDeletedFiles } from "../src/lib/r2-purge";
import { api, befriend, joinAs, newTrip, photoBody, uploadMedia } from "./helpers";

const GONE = "Este rollo se borró";

/** Revealed rollo: Juani (creator), Ana (admin), Fede (friend of Juani) with photos, a like, a comment and a featured photo. */
async function setup() {
  const trip = await newTrip({ dailyPhotoLimit: 10 });
  const ana = await joinAs(trip.code, "Ana");
  const fede = await joinAs(trip.code, "Fede");
  expect((await api("POST", `/trips/${trip.tripId}/members/${ana.memberId}/admin`, { token: trip.adminToken })).status).toBe(200);
  const juaniPhoto = await uploadMedia(trip.tripId, trip.adminToken);
  const fedePhoto = await uploadMedia(trip.tripId, fede.token);
  expect((await api("POST", `/trips/${trip.tripId}/reveal`, { token: trip.adminToken })).status).toBe(200);
  await befriend(trip.adminToken, fede.token);
  expect((await api("PUT", `/media/${fedePhoto}/like`, { token: trip.adminToken })).status).toBe(204);
  expect((await api("POST", `/media/${fedePhoto}/comments`, { token: trip.adminToken, body: { text: "linda" } })).status).toBe(201);
  expect((await api("PUT", `/me/featured/${fedePhoto}`, { token: trip.adminToken })).status).toBe(204);
  return { trip, ana, fede, juaniPhoto, fedePhoto };
}

const count = async (sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;

describe("DELETE /trips/{tripId}", () => {
  it("only the creator deletes the rollo", async () => {
    const t = await setup();
    const denied = await api("DELETE", `/trips/${t.trip.tripId}`, { token: t.ana.token });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe("Solo quien creó el rollo puede hacer esto");
    expect((await api("DELETE", `/trips/${t.trip.tripId}`, { token: t.fede.token })).status).toBe(403);
    expect((await api("DELETE", `/trips/${t.trip.tripId}`, { token: t.trip.adminToken })).status).toBe(204);
  });

  it("deleting removes everything at once", async () => {
    const t = await setup();
    const files = await env.DB.prepare("SELECT original_key o, thumb_key t FROM media WHERE trip_id = ?").bind(t.trip.tripId).all<{ o: string; t: string }>();
    expect(files.results).toHaveLength(2);
    expect((await api("DELETE", `/trips/${t.trip.tripId}`, { token: t.trip.adminToken })).status).toBe(204);

    const gone = await api("GET", `/trips/${t.trip.tripId}`, { token: t.fede.token });
    expect(gone.status).toBe(410);
    expect(gone.body.error).toBe(GONE);
    for (const token of [t.trip.adminToken, t.ana.token, t.fede.token]) {
      const trips = await api("GET", "/me/trips", { token });
      expect(trips.body.trips.map((x: { id: string }) => x.id)).not.toContain(t.trip.tripId);
    }
    expect((await api("GET", "/me/likes", { token: t.trip.adminToken })).body.items).toEqual([]);
    expect((await api("GET", "/me/comments", { token: t.trip.adminToken })).body.items).toEqual([]);
    expect((await api("GET", "/me/featured-by", { token: t.fede.token })).body.items).toEqual([]);
    const profile = await api("GET", `/users/${t.trip.adminUserId}/featured`, { token: t.fede.token });
    expect(JSON.stringify(profile.body)).not.toContain(t.fedePhoto);

    expect(await count("SELECT COUNT(*) n FROM media WHERE trip_id = ?", t.trip.tripId)).toBe(0);
    expect(await count("SELECT COUNT(*) n FROM members WHERE trip_id = ?", t.trip.tripId)).toBe(0);
    expect(await count("SELECT COUNT(*) n FROM trips WHERE id = ?", t.trip.tripId)).toBe(0);
    expect(await count("SELECT COUNT(*) n FROM likes WHERE media_id = ?", t.fedePhoto)).toBe(0);
    expect(await count("SELECT COUNT(*) n FROM deleted_trips WHERE trip_id = ?", t.trip.tripId)).toBe(1);
    const queued = (await env.DB.prepare("SELECT key FROM r2_purge").all<{ key: string }>()).results.map((r) => r.key);
    for (const f of files.results) expect(queued).toEqual(expect.arrayContaining([f.o, f.t]));
  });

  it("uploading to a deleted rollo is 410", async () => {
    const trip = await newTrip();
    const body = photoBody();
    // Registered before the delete: its `complete` has no trip in the URL, so it stays the usual 404 (no media tombstones).
    expect((await api("POST", `/trips/${trip.tripId}/media`, { token: trip.adminToken, body })).status).toBe(201);
    expect((await api("DELETE", `/trips/${trip.tripId}`, { token: trip.adminToken })).status).toBe(204);
    const res = await api("POST", `/trips/${trip.tripId}/media`, { token: trip.adminToken, body: photoBody() });
    expect(res.status).toBe(410);
    expect(res.body.error).toBe(GONE);
    expect((await api("POST", `/media/${body.id}/complete`, { token: trip.adminToken })).status).toBe(404);
  });

  it("a rollo that never existed is still 404", async () => {
    const trip = await newTrip();
    expect((await api("GET", `/trips/${crypto.randomUUID()}`, { token: trip.adminToken })).status).toBe(404);
  });

  it("the cron purges the files", async () => {
    const t = await setup();
    const keys = (await env.DB.prepare("SELECT original_key o, thumb_key t FROM media WHERE trip_id = ?").bind(t.trip.tripId).all<{ o: string; t: string }>()).results.flatMap((r) => [r.o, r.t]);
    for (const k of keys) expect(await env.MEDIA.head(k)).not.toBeNull();
    await api("DELETE", `/trips/${t.trip.tripId}`, { token: t.trip.adminToken });
    await purgeDeletedFiles(env, Date.now());
    for (const k of keys) expect(await env.MEDIA.head(k)).toBeNull();
    expect(await count("SELECT COUNT(*) n FROM r2_purge")).toBe(0);
  });
});
