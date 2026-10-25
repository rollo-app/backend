import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { localDate } from "../src/lib/util";
import { DAY, MINUTE, TZ, api, newTrip, photoBody, uploadMedia } from "./helpers";

async function fixture(overrides: Record<string, unknown> = {}) {
  const fx = await newTrip({ momentMode: "photo_selfie", startsAt: Date.now() - 5 * DAY, ...overrides });
  const notifyAt = Date.now() - 2 * MINUTE;
  const day = localDate(notifyAt, TZ);
  await env.DB.prepare("INSERT INTO trip_moments (trip_id, user_id, day, notify_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(fx.tripId, fx.adminUserId, day, notifyAt, Date.now())
    .run();
  const mainId = await uploadMedia(fx.tripId, fx.adminToken, { momentDay: day, takenAt: notifyAt + MINUTE, thumbhash: "MAIN" });
  const selfieId = await uploadMedia(fx.tripId, fx.adminToken, { pairedMediaId: mainId, thumbhash: "SELF" });
  return { ...fx, day, mainId, selfieId };
}

const feed = (tripId: string, token: string) => api("GET", `/trips/${tripId}/feed`, { token });

describe("feed with moments", () => {
  it("before the reveal: the main photo carries momentDay and a selfie without files; the selfie is not an item", async () => {
    const fx = await fixture();
    const res = await feed(fx.tripId, fx.adminToken);
    expect(res.body.revealed).toBe(false);
    expect(res.body.items.map((i: any) => i.id)).toEqual([fx.mainId]);
    const item = res.body.items[0];
    expect(item.momentDay).toBe(fx.day);
    expect(item.selfie).toMatchObject({ id: fx.selfieId, thumbhash: "SELF", files: null });
  });

  it("after the reveal: the selfie has its files and can be downloaded by id", async () => {
    const fx = await fixture();
    await api("POST", `/trips/${fx.tripId}/reveal`, { token: fx.adminToken });
    const res = await feed(fx.tripId, fx.adminToken);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].selfie).toMatchObject({
      id: fx.selfieId,
      files: {
        thumb: `/trips/${fx.tripId}/media/${fx.selfieId}/thumb`,
        original: `/trips/${fx.tripId}/media/${fx.selfieId}/original`,
      },
    });
    for (const variant of ["thumb", "original"]) {
      expect((await api("GET", `/trips/${fx.tripId}/media/${fx.selfieId}/${variant}`, { token: fx.adminToken })).status).toBe(200);
    }
  });

  it("the selfie is not downloadable before the reveal", async () => {
    const fx = await fixture();
    expect((await api("GET", `/trips/${fx.tripId}/media/${fx.selfieId}/thumb`, { token: fx.adminToken })).status).toBe(403);
  });

  it("ordinary photos have no momentDay or selfie, and a moment without selfie has selfie null", async () => {
    const fx = await newTrip({ momentMode: "photo_selfie", startsAt: Date.now() - 5 * DAY });
    const id = await uploadMedia(fx.tripId, fx.adminToken);
    const res = await feed(fx.tripId, fx.adminToken);
    expect(res.body.items.map((i: any) => i.id)).toEqual([id]);
    expect(res.body.items[0].momentDay ?? null).toBeNull();
    expect(res.body.items[0].selfie ?? null).toBeNull();
  });

  it("a selfie that is not uploaded yet or was deleted is not exposed", async () => {
    const fx = await fixture();
    await env.DB.prepare("UPDATE media SET deleted_at = ? WHERE id = ?").bind(Date.now(), fx.selfieId).run();
    const res = await feed(fx.tripId, fx.adminToken);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].selfie ?? null).toBeNull();
  });

  it("selfies don't count in the user-visible totals", async () => {
    const fx = await fixture();
    const detail = await api("GET", `/trips/${fx.tripId}`, { token: fx.adminToken });
    expect(detail.body.totalUploaded).toBe(1);
    const mine = await api("GET", "/me/trips", { token: fx.adminToken });
    expect(mine.body.trips.find((t: any) => t.id === fx.tripId).totalUploaded).toBe(1);
  });
});
