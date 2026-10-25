import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MOMENT_WINDOW_MS } from "../src/lib/moments";
import { localDate } from "../src/lib/util";
import { DAY, HOUR, MINUTE, TZ, api, joinAs, newTrip, photoBody } from "./helpers";

async function fixture(overrides: Record<string, unknown> = {}) {
  const fx = await newTrip({ momentMode: "photo_selfie", startsAt: Date.now() - 5 * DAY, ...overrides });
  return fx;
}

/** Inserts the member's moment row for the day of `notifyAt` (what GET /moments would have drawn). */
async function seedMoment(tripId: string, userId: string, notifyAt: number) {
  const day = localDate(notifyAt, TZ);
  await env.DB.prepare("INSERT INTO trip_moments (trip_id, user_id, day, notify_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(tripId, userId, day, notifyAt, Date.now())
    .run();
  return day;
}

const post = (tripId: string, token: string, body: unknown) => api("POST", `/trips/${tripId}/media`, { token, body });
const momentRow = (tripId: string, userId: string, day: string) =>
  env.DB.prepare("SELECT * FROM trip_moments WHERE trip_id = ? AND user_id = ? AND day = ?").bind(tripId, userId, day).first<any>();

describe("moment photo upload", () => {
  it("records the photo in its moment, in window, and does not use the day's quota", async () => {
    const fx = await fixture({ dailyPhotoLimit: 1 });
    const notifyAt = Date.now() - 2 * MINUTE;
    const day = await seedMoment(fx.tripId, fx.adminUserId, notifyAt);
    const body = photoBody({ momentDay: day, takenAt: notifyAt + MINUTE });
    expect((await post(fx.tripId, fx.adminToken, body)).status).toBe(201);

    const row = await momentRow(fx.tripId, fx.adminUserId, day);
    expect(row).toMatchObject({ media_id: body.id, in_window: 1, taken_at: body.takenAt });
    const media = await env.DB.prepare("SELECT moment_day FROM media WHERE id = ?").bind(body.id).first<any>();
    expect(media.moment_day).toBe(day);
    // The single normal photo of the day still fits.
    expect((await post(fx.tripId, fx.adminToken, photoBody())).status).toBe(201);
    expect((await post(fx.tripId, fx.adminToken, photoBody())).status).toBe(429);
  });

  it("does not use the total quota either", async () => {
    const fx = await fixture({ photoLimitMode: "total", totalPhotoLimit: 1 });
    const notifyAt = Date.now() - 2 * MINUTE;
    const day = await seedMoment(fx.tripId, fx.adminUserId, notifyAt);
    expect((await post(fx.tripId, fx.adminToken, photoBody({ momentDay: day, takenAt: notifyAt + MINUTE }))).status).toBe(201);
    expect((await post(fx.tripId, fx.adminToken, photoBody())).status).toBe(201);
  });

  it("a moment photo does not reduce today's remaining photos", async () => {
    const fx = await fixture({ dailyPhotoLimit: 2 });
    const notifyAt = Date.now() - 2 * MINUTE;
    const day = await seedMoment(fx.tripId, fx.adminUserId, notifyAt);
    await post(fx.tripId, fx.adminToken, photoBody({ momentDay: day, takenAt: notifyAt + MINUTE }));
    const res = await api("GET", `/trips/${fx.tripId}`, { token: fx.adminToken });
    expect(res.body.today.photosLeft).toBe(2);
  });

  it("a moment photo does not reduce the total remaining photos", async () => {
    const fx = await fixture({ photoLimitMode: "total", totalPhotoLimit: 3 });
    const notifyAt = Date.now() - 2 * MINUTE;
    const day = await seedMoment(fx.tripId, fx.adminUserId, notifyAt);
    await post(fx.tripId, fx.adminToken, photoBody({ momentDay: day, takenAt: notifyAt + MINUTE }));
    const res = await api("GET", `/trips/${fx.tripId}`, { token: fx.adminToken });
    expect(res.body.today.photosLeft).toBe(3);
  });

  it("marks in_window = 0 when taken after the window", async () => {
    const fx = await fixture();
    const notifyAt = Date.now() - 2 * DAY;
    const day = await seedMoment(fx.tripId, fx.adminUserId, notifyAt);
    const body = photoBody({ momentDay: day, takenAt: notifyAt + 2 * DAY - MINUTE });
    expect(notifyAt + MOMENT_WINDOW_MS).toBeLessThan(body.takenAt as number);
    expect((await post(fx.tripId, fx.adminToken, body)).status).toBe(201);
    expect(await momentRow(fx.tripId, fx.adminUserId, day)).toMatchObject({ media_id: body.id, in_window: 0 });
  });

  it("409s when there is no moment for that day", async () => {
    const fx = await fixture();
    const res = await post(fx.tripId, fx.adminToken, photoBody({ momentDay: "2020-01-01" }));
    expect(res.status).toBe(409);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM media").first<any>();
    expect(n.n).toBe(0);
  });

  it("409s on a second, different photo for the same moment day; the same id is idempotent", async () => {
    const fx = await fixture();
    const notifyAt = Date.now() - 2 * MINUTE;
    const day = await seedMoment(fx.tripId, fx.adminUserId, notifyAt);
    const body = photoBody({ momentDay: day, takenAt: notifyAt + MINUTE });
    expect((await post(fx.tripId, fx.adminToken, body)).status).toBe(201);
    expect((await post(fx.tripId, fx.adminToken, body)).status).toBe(200);
    const second = await post(fx.tripId, fx.adminToken, photoBody({ momentDay: day, takenAt: notifyAt + MINUTE }));
    expect(second.status).toBe(409);
    expect((await momentRow(fx.tripId, fx.adminUserId, day)).media_id).toBe(body.id);
  });

  it("only the member's own moment counts", async () => {
    const fx = await fixture();
    const fede = await joinAs(fx.code, "Fede");
    const notifyAt = Date.now() - 2 * MINUTE;
    const day = await seedMoment(fx.tripId, fx.adminUserId, notifyAt);
    expect((await post(fx.tripId, fede.token, photoBody({ momentDay: day, takenAt: notifyAt + MINUTE }))).status).toBe(409);
  });

  it("400s for a video with momentDay", async () => {
    const fx = await fixture();
    const notifyAt = Date.now() - 2 * MINUTE;
    const day = await seedMoment(fx.tripId, fx.adminUserId, notifyAt);
    const res = await post(fx.tripId, fx.adminToken, photoBody({ type: "video", durationS: 5, momentDay: day, takenAt: notifyAt + MINUTE }));
    expect(res.status).toBe(400);
  });
});

describe("moment selfie upload", () => {
  async function withMain() {
    const fx = await fixture({ dailyPhotoLimit: 1 });
    const notifyAt = Date.now() - 2 * MINUTE;
    const day = await seedMoment(fx.tripId, fx.adminUserId, notifyAt);
    const main = photoBody({ momentDay: day, takenAt: notifyAt + MINUTE });
    await post(fx.tripId, fx.adminToken, main);
    return { fx, day, main, notifyAt };
  }

  it("stores the selfie in the moment, inherits moment_day and uses no quota", async () => {
    const { fx, day, main } = await withMain();
    const selfie = photoBody({ pairedMediaId: main.id });
    expect((await post(fx.tripId, fx.adminToken, selfie)).status).toBe(201);
    const row = await momentRow(fx.tripId, fx.adminUserId, day);
    expect(row.selfie_media_id).toBe(selfie.id);
    expect(row.media_id).toBe(main.id);
    const media = await env.DB.prepare("SELECT moment_day, paired_media_id FROM media WHERE id = ?").bind(selfie.id).first<any>();
    expect(media).toEqual({ moment_day: day, paired_media_id: main.id });
    expect((await post(fx.tripId, fx.adminToken, photoBody())).status).toBe(201);
    // Retry of the selfie keeps working.
    expect((await post(fx.tripId, fx.adminToken, selfie)).status).toBe(200);
  });

  it("400s when pairedMediaId is someone else's photo", async () => {
    const { fx, main } = await withMain();
    const fede = await joinAs(fx.code, "Fede");
    expect((await post(fx.tripId, fede.token, photoBody({ pairedMediaId: main.id }))).status).toBe(400);
  });

  it("400s when pairedMediaId is from another trip", async () => {
    const { main, fx } = await withMain();
    const other = await newTrip({ momentMode: "photo_selfie" });
    expect((await post(other.tripId, other.adminToken, photoBody({ pairedMediaId: main.id }))).status).toBe(400);
    void fx;
  });

  it("400s when pairedMediaId is a photo without moment_day, or does not exist", async () => {
    const fx = await fixture();
    const normal = photoBody();
    await post(fx.tripId, fx.adminToken, normal);
    expect((await post(fx.tripId, fx.adminToken, photoBody({ pairedMediaId: normal.id }))).status).toBe(400);
    expect((await post(fx.tripId, fx.adminToken, photoBody({ pairedMediaId: crypto.randomUUID() }))).status).toBe(400);
  });

  it("400s when pairing to a selfie", async () => {
    const { fx, main } = await withMain();
    const selfie = photoBody({ pairedMediaId: main.id });
    await post(fx.tripId, fx.adminToken, selfie);
    expect((await post(fx.tripId, fx.adminToken, photoBody({ pairedMediaId: selfie.id }))).status).toBe(400);
  });
});

describe("requests without moment fields", () => {
  it("behave as before, with the quota counting normally", async () => {
    const fx = await fixture({ dailyPhotoLimit: 1 });
    expect((await post(fx.tripId, fx.adminToken, photoBody())).status).toBe(201);
    expect((await post(fx.tripId, fx.adminToken, photoBody())).status).toBe(429);
    const row = await env.DB.prepare("SELECT moment_day, paired_media_id FROM media").first<any>();
    expect(row).toEqual({ moment_day: null, paired_media_id: null });
  });
});
void HOUR;
