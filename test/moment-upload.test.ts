import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MOMENT_WINDOW_MS } from "../src/lib/moments";
import { localDate } from "../src/lib/util";
import { registerMedia } from "../src/modules/media/media.service";
import type { MemberRow, TripRow } from "../src/types";
import { DAY, HOUR, MINUTE, TZ, api, joinAs, newTrip, photoBody } from "./helpers";

async function fixture(overrides: Record<string, unknown> = {}) {
  const fx = await newTrip({ momentMode: "photo_selfie", startsAt: Date.now() - 5 * DAY, ...overrides });
  return fx;
}

/** Inserts the member's moment row for the day of `notifyAt` (what GET /moments would have drawn). */
async function seedMoment(tripId: string, userId: string, notifyAt: number, mode: string | null = null) {
  const day = localDate(notifyAt, TZ);
  await env.DB.prepare("INSERT INTO trip_moments (trip_id, user_id, day, notify_at, created_at, mode) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(tripId, userId, day, notifyAt, Date.now(), mode)
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

/** Env whose DB runs `beforeBatch` once, right before the first batch: the window between the pre-check and the write. */
function racingEnv(beforeBatch: () => Promise<void>) {
  let fired = false;
  const DB = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "batch") {
        return async (stmts: D1PreparedStatement[]) => {
          if (!fired) {
            fired = true;
            await beforeBatch();
          }
          return target.batch(stmts);
        };
      }
      const v = (target as any)[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { ...env, DB } as typeof env;
}

async function rows(tripId: string) {
  const t = (await env.DB.prepare("SELECT * FROM trips WHERE id = ?").bind(tripId).first<TripRow>())!;
  const m = (await env.DB.prepare("SELECT * FROM members WHERE trip_id = ? AND role = 'admin'").bind(tripId).first<MemberRow>())!;
  return { t, m };
}
const count = async (id: string) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM media WHERE id = ?").bind(id).first<any>()).n;

describe("concurrent moment uploads", () => {
  it("a main photo that loses the slot race is rejected and leaves no quota-free row", async () => {
    const fx = await fixture();
    const notifyAt = Date.now() - 2 * MINUTE;
    const day = await seedMoment(fx.tripId, fx.adminUserId, notifyAt);
    const { t, m } = await rows(fx.tripId);
    const winner = photoBody({ momentDay: day, takenAt: notifyAt + MINUTE });
    const loser = photoBody({ momentDay: day, takenAt: notifyAt + MINUTE });
    const raced = racingEnv(async () => {
      await env.DB.prepare("UPDATE trip_moments SET media_id = ? WHERE trip_id = ? AND day = ?").bind(winner.id, fx.tripId, day).run();
    });
    await expect(registerMedia(raced, "http://x", t, m, loser as any)).rejects.toMatchObject({ kind: "conflict" });
    expect(await count(loser.id)).toBe(0);
    expect((await momentRow(fx.tripId, fx.adminUserId, day)).media_id).toBe(winner.id);
  });

  it("a selfie that loses the slot race is rejected and leaves no row", async () => {
    const fx = await fixture();
    const notifyAt = Date.now() - 2 * MINUTE;
    const day = await seedMoment(fx.tripId, fx.adminUserId, notifyAt);
    const main = photoBody({ momentDay: day, takenAt: notifyAt + MINUTE });
    await post(fx.tripId, fx.adminToken, main);
    const { t, m } = await rows(fx.tripId);
    const winner = crypto.randomUUID();
    const loser = photoBody({ pairedMediaId: main.id });
    const raced = racingEnv(async () => {
      await env.DB.prepare("UPDATE trip_moments SET selfie_media_id = ? WHERE trip_id = ? AND day = ?").bind(winner, fx.tripId, day).run();
    });
    await expect(registerMedia(raced, "http://x", t, m, loser as any)).rejects.toMatchObject({ kind: "conflict" });
    expect(await count(loser.id)).toBe(0);
  });

  it("a second selfie for the same main is 409 and a selfie with another momentDay is 400", async () => {
    const fx = await fixture();
    const notifyAt = Date.now() - 2 * MINUTE;
    const day = await seedMoment(fx.tripId, fx.adminUserId, notifyAt);
    const main = photoBody({ momentDay: day, takenAt: notifyAt + MINUTE });
    await post(fx.tripId, fx.adminToken, main);
    expect((await post(fx.tripId, fx.adminToken, photoBody({ pairedMediaId: main.id, momentDay: "2020-01-01" }))).status).toBe(400);
    expect((await post(fx.tripId, fx.adminToken, photoBody({ pairedMediaId: main.id }))).status).toBe(201);
    expect((await post(fx.tripId, fx.adminToken, photoBody({ pairedMediaId: main.id }))).status).toBe(409);
  });
});

describe("moment mode and pairing guards", () => {
  it("400s momentDay on a trip with momentMode off, and a selfie unless the mode is photo_selfie", async () => {
    const off = await fixture({ momentMode: "off" });
    const notifyAt = Date.now() - 2 * MINUTE;
    const day = localDate(notifyAt, TZ); // no row for it: an off trip has nothing to take
    expect((await post(off.tripId, off.adminToken, photoBody({ momentDay: day, takenAt: notifyAt + MINUTE }))).status).toBe(400);
    expect((await post(off.tripId, off.adminToken, photoBody({ pairedMediaId: crypto.randomUUID() }))).status).toBe(400);

    const only = await fixture({ momentMode: "photo" });
    const d2 = await seedMoment(only.tripId, only.adminUserId, notifyAt);
    const main = photoBody({ momentDay: d2, takenAt: notifyAt + MINUTE });
    expect((await post(only.tripId, only.adminToken, main)).status).toBe(201);
    expect((await post(only.tripId, only.adminToken, photoBody({ pairedMediaId: main.id }))).status).toBe(400);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM media WHERE paired_media_id IS NOT NULL").first<any>()).toEqual({ n: 0 });
  });

  it("400s a selfie paired to a moment_day media that is not the moment's photo", async () => {
    const fx = await fixture();
    const notifyAt = Date.now() - 2 * MINUTE;
    const day = await seedMoment(fx.tripId, fx.adminUserId, notifyAt);
    const main = photoBody({ momentDay: day, takenAt: notifyAt + MINUTE });
    await post(fx.tripId, fx.adminToken, main);
    // A stray media with moment_day set that the moment does not point to.
    const stray = photoBody();
    await post(fx.tripId, fx.adminToken, stray);
    await env.DB.prepare("UPDATE media SET moment_day = ? WHERE id = ?").bind(day, stray.id).run();
    expect((await post(fx.tripId, fx.adminToken, photoBody({ pairedMediaId: stray.id }))).status).toBe(400);
  });
});

describe("moment uploads after the rollo's config changed", () => {
  const setMode = (tripId: string, mode: string) => env.DB.prepare("UPDATE trips SET moment_mode = ? WHERE id = ?").bind(mode, tripId).run();

  it("accepts the main photo and the selfie of a row drawn with photo_selfie after the moment was turned off", async () => {
    const fx = await fixture();
    const notifyAt = Date.now() - 2 * MINUTE;
    const day = await seedMoment(fx.tripId, fx.adminUserId, notifyAt, "photo_selfie");
    await setMode(fx.tripId, "off");
    const main = photoBody({ momentDay: day, takenAt: notifyAt + MINUTE });
    expect((await post(fx.tripId, fx.adminToken, main)).status).toBe(201);
    expect((await post(fx.tripId, fx.adminToken, photoBody({ pairedMediaId: main.id }))).status).toBe(201);
  });

  it("accepts the selfie when the trip switched to photo after the row was drawn with photo_selfie", async () => {
    const fx = await fixture();
    const notifyAt = Date.now() - 2 * MINUTE;
    const day = await seedMoment(fx.tripId, fx.adminUserId, notifyAt, "photo_selfie");
    const main = photoBody({ momentDay: day, takenAt: notifyAt + MINUTE });
    expect((await post(fx.tripId, fx.adminToken, main)).status).toBe(201);
    await setMode(fx.tripId, "photo");
    expect((await post(fx.tripId, fx.adminToken, photoBody({ pairedMediaId: main.id }))).status).toBe(201);
  });

  it("rejects the selfie of a row drawn with photo even if the trip later allows selfies", async () => {
    const fx = await fixture();
    const notifyAt = Date.now() - 2 * MINUTE;
    const day = await seedMoment(fx.tripId, fx.adminUserId, notifyAt, "photo");
    const main = photoBody({ momentDay: day, takenAt: notifyAt + MINUTE });
    expect((await post(fx.tripId, fx.adminToken, main)).status).toBe(201);
    const res = await post(fx.tripId, fx.adminToken, photoBody({ pairedMediaId: main.id }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Este rollo no admite selfie del momento");
  });

  it("still 400s a moment photo when the trip is off and there is no row", async () => {
    const fx = await fixture({ momentMode: "off" });
    const res = await post(fx.tripId, fx.adminToken, photoBody({ momentDay: localDate(Date.now(), TZ) }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Este rollo no tiene momento del día");
  });
});
