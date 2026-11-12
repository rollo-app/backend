import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { flushPendingPushes } from "../src/lib/push";
import { localDate } from "../src/lib/util";
import { DAY, MINUTE, TZ, addMediaDirect, addMembersDirect, addPushTokensDirect, api, mockExpo, newTrip, photoBody, putFiles } from "./helpers";

// Baseline characterization of a large rollo (event): 100 members + admin and 2,000 photos.
// The numbers logged here are the "before pagination" reference. Timings are never asserted.

const MEMBERS = 100;
const PHOTOS = 2_000;

// The database is reset before every test, so each scenario builds its own rollo.
async function setup() {
  const trip = await newTrip({ momentMode: "photo_selfie", startsAt: Date.now() - 5 * DAY });
  const members = await addMembersDirect(trip.tripId, MEMBERS, { namePrefix: "Invitado" });
  const authors = [{ userId: trip.adminUserId, memberId: trip.adminId }, ...members.map((m) => ({ userId: m.userId, memberId: m.memberId }))];
  await addMediaDirect(trip.tripId, authors, PHOTOS);
  return { ...trip, members, authors };
}

/** Calls the endpoint and logs duration and JSON size (baseline before pagination). */
async function measured(label: string, path: string, token: string) {
  const t0 = performance.now();
  const res = await api("GET", path, { token });
  const ms = Math.round(performance.now() - t0);
  const kb = (JSON.stringify(res.body).length / 1024).toFixed(1);
  console.log(`[large-rollo baseline] ${label}: ${ms} ms, ${kb} KB`);
  return res;
}

describe("large rollo (100 members, 2,000 photos)", () => {
  it("the feed before the reveal returns every item as metadata only, no files", async () => {
    const fx = await setup();
    const res = await measured("feed (unrevealed)", `/trips/${fx.tripId}/feed`, fx.members[0]!.token);
    expect(res.status).toBe(200);
    expect(res.body.revealed).toBe(false);
    expect(res.body.items).toHaveLength(PHOTOS);
    expect(new Set(res.body.items.map((i: { id: string }) => i.id)).size).toBe(PHOTOS);
    for (const item of res.body.items) {
      expect(item.type).toBe("photo");
      expect(item).not.toHaveProperty("files");
    }
    const times = res.body.items.map((i: { takenAt: number }) => i.takenAt);
    expect(times).toEqual([...times].sort((a: number, b: number) => a - b));
  }, 120_000);

  it("GET /trips/:id returns the detail with 101 members", async () => {
    const fx = await setup();
    const res = await measured("trip detail", `/trips/${fx.tripId}`, fx.members[0]!.token);
    expect(res.status).toBe(200);
    expect(res.body.members).toHaveLength(MEMBERS + 1);
  }, 120_000);

  it("the feed after the reveal returns every item with files and like/comment counts", async () => {
    const fx = await setup();
    const reveal = await api("POST", `/trips/${fx.tripId}/reveal`, { token: fx.adminToken });
    expect(reveal.status).toBeLessThan(300);
    const res = await measured("feed (revealed)", `/trips/${fx.tripId}/feed`, fx.members[0]!.token);
    expect(res.status).toBe(200);
    expect(res.body.revealed).toBe(true);
    expect(res.body.items).toHaveLength(PHOTOS);
    for (const item of res.body.items) {
      expect(item.files).toEqual({
        thumb: `/trips/${fx.tripId}/media/${item.id}/thumb`,
        original: `/trips/${fx.tripId}/media/${item.id}/original`,
      });
      expect(typeof item.likeCount).toBe("number");
      expect(typeof item.commentCount).toBe("number");
    }
  }, 120_000);
});

describe("momentPosted in a large rollo", () => {
  it("goes to the other 100 active members with push tokens, in batches of at most 100", async () => {
    const expo = mockExpo();
    const trip = await newTrip({ momentMode: "photo_selfie", startsAt: Date.now() - 5 * DAY });
    const members = await addMembersDirect(trip.tripId, MEMBERS);
    const tokens = await addPushTokensDirect(members.map((m) => m.userId));
    expect(tokens).toHaveLength(MEMBERS);

    const notifyAt = Date.now() - 2 * MINUTE;
    const day = localDate(notifyAt, TZ);
    await env.DB.prepare("INSERT INTO trip_moments (trip_id, user_id, day, notify_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(trip.tripId, trip.adminUserId, day, notifyAt, Date.now())
      .run();
    await flushPendingPushes();
    expo.sent.length = 0;
    expo.sendBatches.length = 0;

    const body = photoBody({ momentDay: day, takenAt: notifyAt + MINUTE });
    expect((await api("POST", `/trips/${trip.tripId}/media`, { body, token: trip.adminToken })).status).toBe(201);
    await putFiles(trip.tripId, body.id as string);
    expect((await api("POST", `/media/${body.id}/complete`, { token: trip.adminToken })).status).toBe(200);
    await flushPendingPushes();

    expect(expo.sent).toHaveLength(MEMBERS);
    expect(new Set(expo.sent.map((m) => m.to))).toEqual(new Set(tokens));
    expect(expo.sendBatches.every((n) => n <= 100)).toBe(true);
    expect(expo.sendBatches.reduce((a, b) => a + b, 0)).toBe(MEMBERS);
    expect(expo.sent[0]!.data.url).toBe(`/photo/${body.id}?tripId=${trip.tripId}`);
  }, 120_000);
});
