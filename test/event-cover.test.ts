import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { api, createTrip, newTrip, signUp, grantEvents } from "./helpers";
import { BASELINE_JPEG, indexOfBytes, photoWithMetadata } from "./jpeg-fixture";

// A well-formed JPEG: the cover is stripped of metadata on complete, which rejects anything else.
const jpeg = () => BASELINE_JPEG;

async function eventFixture() {
  const org = await signUp(undefined, "Org");
  await grantEvents(org.userId);
  const { tripId, code } = await createTrip(org.token, {
    type: "event",
    groups: ["A"],
    photoLimitMode: "total",
    totalPhotoLimit: 20,
    dailyPhotoLimit: undefined,
    dailyVideoLimit: undefined,
  });
  const guest = await signUp(undefined, "Guest");
  const detail = await api("GET", `/trips/${tripId}`, { token: org.token });
  await api("POST", "/trips/join", { token: guest.token, body: { code, groupIds: [detail.body.trip.groups[0].id] } });
  return { org, guest, tripId };
}

const keys = (tripId: string) =>
  env.DB.prepare("SELECT cover_key c, pending_cover_key p FROM trips WHERE id = ?").bind(tripId).first<{ c: string | null; p: string | null }>();

async function setCover(token: string, tripId: string, bytes: Uint8Array = jpeg()) {
  const req = await api("POST", `/trips/${tripId}/cover`, { token, body: { sizeBytes: bytes.length } });
  expect(req.status).toBe(200);
  await env.MEDIA.put((await keys(tripId))!.p!, bytes);
  return api("POST", `/trips/${tripId}/cover/complete`, { token });
}

describe("event cover", () => {
  it("full cycle: request, upload, complete, serve", async () => {
    const ev = await eventFixture();
    const req = await api("POST", `/trips/${ev.tripId}/cover`, { token: ev.org.token, body: { sizeBytes: jpeg().length } });
    expect(req.status).toBe(200);
    expect(req.body.expiresIn).toBe(900);
    expect(typeof req.body.upload).toBe("string");
    expect((await keys(ev.tripId))!.p).toMatch(new RegExp(`^trips/${ev.tripId}/cover/[0-9a-f-]+\\.jpg$`));

    const done = await setCover(ev.org.token, ev.tripId, jpeg());
    expect(done.status).toBe(200);
    expect(done.body.coverUrl).toMatch(new RegExp(`^/covers/${ev.tripId}/[0-9a-f-]+\\.jpg$`));
    expect((await keys(ev.tripId))!.p).toBeNull();

    const detail = await api("GET", `/trips/${ev.tripId}`, { token: ev.guest.token });
    expect(detail.body.trip.coverUrl).toBe(done.body.coverUrl);

    const file = await api("GET", done.body.coverUrl);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/jpeg");
    expect(file.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("replacing the cover deletes the old one from R2 and only the current file is served", async () => {
    const ev = await eventFixture();
    const first = await setCover(ev.org.token, ev.tripId, jpeg());
    const oldKey = (await keys(ev.tripId))!.c!;
    const second = await setCover(ev.org.token, ev.tripId, jpeg());
    expect(second.body.coverUrl).not.toBe(first.body.coverUrl);
    expect(await env.MEDIA.get(oldKey)).toBeNull();
    expect((await api("GET", first.body.coverUrl)).status).toBe(404);
    expect((await api("GET", second.body.coverUrl)).status).toBe(200);
  });

  it("the published cover has no EXIF metadata", async () => {
    const ev = await eventFixture();
    const input = photoWithMetadata("secreto en el cerro");
    expect(indexOfBytes(input, "Exif\0\0")).toBeGreaterThan(0);
    const done = await setCover(ev.org.token, ev.tripId, input);
    expect(done.status).toBe(200);
    const key = (await keys(ev.tripId))!.c!;
    const stored = new Uint8Array(await (await env.MEDIA.get(key))!.arrayBuffer());
    expect(indexOfBytes(stored, "Exif\0\0")).toBe(-1);
    expect(indexOfBytes(stored, "http://ns.adobe.com/xap/1.0/")).toBe(-1);
    expect(indexOfBytes(stored, "secreto en el cerro")).toBe(-1);
    expect((await api("GET", done.body.coverUrl)).status).toBe(200);
  });

  it("rejects a malformed JPEG and discards it", async () => {
    const ev = await eventFixture();
    const res = await setCover(ev.org.token, ev.tripId, new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]));
    expect(res.status).toBe(400);
    const k = (await keys(ev.tripId))!;
    expect(k.c).toBeNull();
    expect(k.p).toBeNull();
  });

  it("rejects a file that is not a JPEG and discards it", async () => {
    const ev = await eventFixture();
    const bytes = new TextEncoder().encode("not a jpeg");
    const res = await setCover(ev.org.token, ev.tripId, bytes);
    expect(res.status).toBe(400);
    const k = (await keys(ev.tripId))!;
    expect(k.c).toBeNull();
    expect(k.p).toBeNull();
  });

  it("validates the size and the order of the calls", async () => {
    const ev = await eventFixture();
    expect((await api("POST", `/trips/${ev.tripId}/cover`, { token: ev.org.token, body: { sizeBytes: 3 * 1024 * 1024 } })).status).toBe(400);
    expect((await api("POST", `/trips/${ev.tripId}/cover/complete`, { token: ev.org.token })).status).toBe(400);
  });

  it("only organizers can change the cover", async () => {
    const ev = await eventFixture();
    expect((await api("POST", `/trips/${ev.tripId}/cover`, { token: ev.guest.token, body: { sizeBytes: 10 } })).status).toBe(403);
    expect((await api("POST", `/trips/${ev.tripId}/cover/complete`, { token: ev.guest.token })).status).toBe(403);
  });

  it("a regular trip has no cover", async () => {
    const t = await newTrip();
    expect((await api("POST", `/trips/${t.tripId}/cover`, { token: t.adminToken, body: { sizeBytes: 10 } })).status).toBe(409);
  });

  it("an unknown event or file is a 404", async () => {
    const ev = await eventFixture();
    expect((await api("GET", `/covers/${ev.tripId}/nope.jpg`)).status).toBe(404);
    expect((await api("GET", `/covers/missing/nope.jpg`)).status).toBe(404);
  });

  it("deleting the event queues its cover for removal", async () => {
    const ev = await eventFixture();
    await setCover(ev.org.token, ev.tripId);
    const key = (await keys(ev.tripId))!.c!;
    expect((await api("DELETE", `/trips/${ev.tripId}`, { token: ev.org.token })).status).toBe(204);
    expect(await env.DB.prepare("SELECT 1 FROM r2_purge WHERE key = ?").bind(key).first()).not.toBeNull();
  });

  it("cover upload is refused after the reveal", async () => {
    const ev = await eventFixture();
    const reveal = (at: number) => env.DB.prepare("UPDATE trips SET revealed_at = ? WHERE id = ?").bind(at, ev.tripId).run();

    // Request before the reveal, reveal, then complete: 409, pending object discarded and key cleared.
    const req = await api("POST", `/trips/${ev.tripId}/cover`, { token: ev.org.token, body: { sizeBytes: jpeg().length } });
    expect(req.status).toBe(200);
    const pendingKey = (await keys(ev.tripId))!.p!;
    await env.MEDIA.put(pendingKey, jpeg());
    await reveal(Date.now() - 1000);
    const done = await api("POST", `/trips/${ev.tripId}/cover/complete`, { token: ev.org.token });
    expect(done.status).toBe(409);
    expect(done.body.error).toBe("Este evento ya se reveló.");
    expect(await env.MEDIA.get(pendingKey)).toBeNull();
    expect(await keys(ev.tripId)).toEqual({ c: null, p: null });

    // A new request is refused too.
    const again = await api("POST", `/trips/${ev.tripId}/cover`, { token: ev.org.token, body: { sizeBytes: jpeg().length } });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("Este evento ya se reveló.");
  });
});
