import { describe, expect, it } from "vitest";
import { localDate } from "../src/lib/util";
import { DAY, MINUTE, TZ, api, joinAs, newTrip, uploadMedia } from "./helpers";
import { env } from "cloudflare:workers";

/** Revealed trip: Juani (admin), Fede and Cami, one photo each. Nobody is friends with anybody. */
async function revealedTrip(overrides: Record<string, unknown> = {}) {
  const trip = await newTrip(overrides);
  const fede = await joinAs(trip.code, "Fede");
  const cami = await joinAs(trip.code, "Cami");
  const juaniPhoto = await uploadMedia(trip.tripId, trip.adminToken);
  const fedePhoto = await uploadMedia(trip.tripId, fede.token);
  const camiPhoto = await uploadMedia(trip.tripId, cami.token);
  await api("POST", `/trips/${trip.tripId}/reveal`, { token: trip.adminToken });
  return { ...trip, juani: { token: trip.adminToken, userId: trip.adminUserId }, fede, cami, juaniPhoto, fedePhoto, camiPhoto };
}

const setAccount = (token: string, allowFeaturing: boolean) => api("PATCH", "/me/settings", { token, body: { privacy: { allowFeaturing } } });
const setMember = (tripId: string, token: string, allowFeaturing: boolean) =>
  api("PATCH", `/trips/${tripId}/members/me`, { token, body: { allowFeaturing } });
const setPrivate = (tripId: string, token: string, featuringDisabled: boolean) =>
  api("PATCH", `/trips/${tripId}`, { token, body: { featuringDisabled } });
const feedItem = async (tripId: string, token: string, id: string) =>
  (await api("GET", `/trips/${tripId}/feed`, { token })).body.items.find((i: any) => i.id === id);

describe("shareable in the revealed feed (featuring rule without friendship)", () => {
  it("another member's photo is shareable without being friends", async () => {
    const t = await revealedTrip();
    expect(await feedItem(t.tripId, t.juani.token, t.fedePhoto)).toMatchObject({ shareable: true, canFeature: false });
  });

  it("your own photo is shareable", async () => {
    const t = await revealedTrip();
    expect(await feedItem(t.tripId, t.juani.token, t.juaniPhoto)).toMatchObject({ shareable: true });
  });

  it("feature-block makes it not shareable", async () => {
    const t = await revealedTrip();
    expect((await api("PUT", `/media/${t.fedePhoto}/feature-block`, { token: t.fede.token })).status).toBe(204);
    expect(await feedItem(t.tripId, t.juani.token, t.fedePhoto)).toMatchObject({ shareable: false });
    expect(await feedItem(t.tripId, t.fede.token, t.fedePhoto)).toMatchObject({ shareable: true });
  });

  it("the author's rollo setting and account setting make it not shareable", async () => {
    const t = await revealedTrip();
    await setMember(t.tripId, t.fede.token, false);
    expect(await feedItem(t.tripId, t.juani.token, t.fedePhoto)).toMatchObject({ shareable: false });
    expect(await feedItem(t.tripId, t.fede.token, t.fedePhoto)).toMatchObject({ shareable: true });

    const u = await revealedTrip();
    await setAccount(u.fede.token, false);
    expect(await feedItem(u.tripId, u.juani.token, u.fedePhoto)).toMatchObject({ shareable: false });
    expect(await feedItem(u.tripId, u.fede.token, u.fedePhoto)).toMatchObject({ shareable: true });
  });

  it("a private rollo makes nothing shareable, not even your own", async () => {
    const t = await revealedTrip();
    expect((await setPrivate(t.tripId, t.juani.token, true)).status).toBe(200);
    expect(await feedItem(t.tripId, t.juani.token, t.juaniPhoto)).toMatchObject({ shareable: false });
    expect(await feedItem(t.tripId, t.juani.token, t.fedePhoto)).toMatchObject({ shareable: false });
  });

  it("moment photos, archived photos and videos are never shareable", async () => {
    const fx = await newTrip({ momentMode: "photo_selfie", startsAt: Date.now() - 5 * DAY });
    const notifyAt = Date.now() - 2 * MINUTE;
    const day = localDate(notifyAt, TZ);
    await env.DB.prepare("INSERT INTO trip_moments (trip_id, user_id, day, notify_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(fx.tripId, fx.adminUserId, day, notifyAt, Date.now())
      .run();
    const mainId = await uploadMedia(fx.tripId, fx.adminToken, { momentDay: day, takenAt: notifyAt + MINUTE, thumbhash: "MAIN" });
    await uploadMedia(fx.tripId, fx.adminToken, { pairedMediaId: mainId, thumbhash: "SELF" });
    const archivedId = await uploadMedia(fx.tripId, fx.adminToken);
    const videoId = await uploadMedia(fx.tripId, fx.adminToken, { type: "video" });
    await api("POST", `/trips/${fx.tripId}/reveal`, { token: fx.adminToken });
    expect((await api("POST", `/media/${archivedId}/archive`, { token: fx.adminToken })).status).toBe(204);

    expect(await feedItem(fx.tripId, fx.adminToken, mainId)).toMatchObject({ shareable: false });
    expect(await feedItem(fx.tripId, fx.adminToken, archivedId)).toMatchObject({ shareable: false });
    expect(await feedItem(fx.tripId, fx.adminToken, videoId)).toMatchObject({ type: "video", shareable: false });
  });

  it("before the reveal the field is absent", async () => {
    const trip = await newTrip();
    const id = await uploadMedia(trip.tripId, trip.adminToken);
    expect(await feedItem(trip.tripId, trip.adminToken, id)).not.toHaveProperty("shareable");
  });
});
