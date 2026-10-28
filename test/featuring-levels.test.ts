import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { insertFeaturedUnderCap } from "../src/modules/featured/featured.repository";
import { api, befriend, joinAs, newTrip, uploadMedia } from "./helpers";

/** Revealed trip: Juani (admin), Fede and Cami, one photo each. */
async function revealedTrip(overrides: Record<string, unknown> = {}) {
  const trip = await newTrip(overrides);
  const fede = await joinAs(trip.code, "Fede");
  const cami = await joinAs(trip.code, "Cami");
  const juaniPhoto = await uploadMedia(trip.tripId, trip.adminToken);
  const fedePhoto = await uploadMedia(trip.tripId, fede.token);
  const camiPhoto = await uploadMedia(trip.tripId, cami.token);
  await api("POST", `/trips/${trip.tripId}/reveal`, { token: trip.adminToken });
  // Featuring someone else's photo is for friends only.
  await befriend(trip.adminToken, fede.token);
  await befriend(trip.adminToken, cami.token);
  await befriend(fede.token, cami.token);
  return { ...trip, juani: { token: trip.adminToken, userId: trip.adminUserId }, fede, cami, juaniPhoto, fedePhoto, camiPhoto };
}

const feature = (token: string, mediaId: string) => api("PUT", `/me/featured/${mediaId}`, { token });
const featured = async (token: string, userId: string) =>
  ((await api("GET", `/users/${userId}/featured`, { token })).body.photos as { mediaId: string }[]).map((p) => p.mediaId);
const setAccount = (token: string, allowFeaturing: boolean) => api("PATCH", "/me/settings", { token, body: { privacy: { allowFeaturing } } });
const setMember = (tripId: string, token: string, allowFeaturing: boolean) =>
  api("PATCH", `/trips/${tripId}/members/me`, { token, body: { allowFeaturing } });
const setPrivate = (tripId: string, token: string, featuringDisabled: boolean) =>
  api("PATCH", `/trips/${tripId}`, { token, body: { featuringDisabled } });
const feedItem = async (tripId: string, token: string, id: string) =>
  (await api("GET", `/trips/${tripId}/feed`, { token })).body.items.find((i: any) => i.id === id);

describe("level 1: your account (PATCH /me/settings privacy.allowFeaturing)", () => {
  it("is on by default and is part of the settings", async () => {
    const t = await revealedTrip();
    expect((await api("GET", "/me/settings", { token: t.fede.token })).body.privacy).toEqual({ allowFeaturing: true });
  });

  it("turning it off stops others (409) but not the author, and the feed says so", async () => {
    const t = await revealedTrip();
    const res = await setAccount(t.fede.token, false);
    expect(res.status).toBe(200);
    expect(res.body.privacy).toEqual({ allowFeaturing: false });
    expect((await feature(t.juani.token, t.fedePhoto)).status).toBe(409);
    expect((await feature(t.fede.token, t.fedePhoto)).status).toBe(204);
    expect((await feature(t.juani.token, t.camiPhoto)).status).toBe(204);
    expect(await feedItem(t.tripId, t.juani.token, t.fedePhoto)).toMatchObject({ canFeature: false });
    expect(await feedItem(t.tripId, t.fede.token, t.fedePhoto)).toMatchObject({ canFeature: true });
    expect(await feedItem(t.tripId, t.juani.token, t.camiPhoto)).toMatchObject({ canFeature: true });
  });

  it("cleans the author's photos from other profiles in every rollo, and turning it back on restores nothing", async () => {
    const t = await revealedTrip();
    await feature(t.juani.token, t.fedePhoto);
    await feature(t.cami.token, t.fedePhoto);
    await feature(t.fede.token, t.fedePhoto);
    await feature(t.juani.token, t.camiPhoto);
    await setAccount(t.fede.token, false);
    expect(await featured(t.juani.token, t.juani.userId)).toEqual([t.camiPhoto]);
    expect(await featured(t.cami.token, t.cami.userId)).toEqual([]);
    expect(await featured(t.fede.token, t.fede.userId)).toEqual([t.fedePhoto]);
    await setAccount(t.fede.token, true);
    expect(await featured(t.juani.token, t.juani.userId)).toEqual([t.camiPhoto]);
    expect((await feature(t.juani.token, t.fedePhoto)).status).toBe(204);
  });

  it("a PATCH with only notifications still works (old client)", async () => {
    const t = await revealedTrip();
    const res = await api("PATCH", "/me/settings", { token: t.fede.token, body: { notifications: { photoLiked: false } } });
    expect(res.status).toBe(200);
    expect(res.body.notifications.photoLiked).toBe(false);
    expect(res.body.privacy).toEqual({ allowFeaturing: true });
  });
});

describe("level 2: your photos of one rollo (PATCH /trips/{id}/members/me)", () => {
  it("is on by default; off stops others in that rollo only, and cleans up", async () => {
    const t = await revealedTrip();
    const detail = await api("GET", `/trips/${t.tripId}`, { token: t.fede.token });
    expect(detail.body.me.allowFeaturing).toBe(true);
    await feature(t.juani.token, t.fedePhoto);
    await feature(t.fede.token, t.fedePhoto);

    const res = await setMember(t.tripId, t.fede.token, false);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ allowFeaturing: false, archived: false });
    expect((await api("GET", `/trips/${t.tripId}`, { token: t.fede.token })).body.me.allowFeaturing).toBe(false);
    expect(await featured(t.juani.token, t.juani.userId)).toEqual([]);
    expect(await featured(t.fede.token, t.fede.userId)).toEqual([t.fedePhoto]);
    expect((await feature(t.cami.token, t.fedePhoto)).status).toBe(409);
    expect((await feature(t.cami.token, t.juaniPhoto)).status).toBe(204);
    expect(await feedItem(t.tripId, t.cami.token, t.fedePhoto)).toMatchObject({ canFeature: false });

    await setMember(t.tripId, t.fede.token, true);
    expect(await featured(t.juani.token, t.juani.userId)).toEqual([]);
    expect((await feature(t.cami.token, t.fedePhoto)).status).toBe(204);
  });

  it("only affects the member's own photos", async () => {
    const t = await revealedTrip();
    await setMember(t.tripId, t.fede.token, false);
    expect((await feature(t.fede.token, t.camiPhoto)).status).toBe(204);
    expect(await feedItem(t.tripId, t.juani.token, t.camiPhoto)).toMatchObject({ canFeature: true });
  });

  it("401 without a session and 403 for someone who is not a member", async () => {
    const t = await revealedTrip();
    expect((await api("PATCH", `/trips/${t.tripId}/members/me`, { body: { allowFeaturing: false } })).status).toBe(401);
    const stranger = await joinAs((await newTrip()).code, "Otro");
    expect((await setMember(t.tripId, stranger.token, false)).status).toBe(403);
  });
});

describe("level 3: one photo (feature-block) still works and feeds canFeature", () => {
  it("a blocked photo has canFeature false for others and true for its author", async () => {
    const t = await revealedTrip();
    await api("PUT", `/media/${t.fedePhoto}/feature-block`, { token: t.fede.token });
    expect(await feedItem(t.tripId, t.juani.token, t.fedePhoto)).toMatchObject({ featureBlocked: true, canFeature: false });
    expect(await feedItem(t.tripId, t.fede.token, t.fedePhoto)).toMatchObject({ canFeature: true });
  });
});

describe("level 4: private rollo (featuringDisabled)", () => {
  it("is off by default and a trip created without the field works as before", async () => {
    const t = await revealedTrip();
    const detail = await api("GET", `/trips/${t.tripId}`, { token: t.juani.token });
    expect(detail.body.trip.featuringDisabled).toBe(false);
  });

  it("can be chosen when creating the rollo", async () => {
    const trip = await newTrip({ featuringDisabled: true });
    const detail = await api("GET", `/trips/${trip.tripId}`, { token: trip.adminToken });
    expect(detail.body.trip.featuringDisabled).toBe(true);
  });

  it("nobody can feature its photos, not even the author, and the feed says so", async () => {
    const t = await revealedTrip({ featuringDisabled: true });
    expect((await feature(t.fede.token, t.fedePhoto)).status).toBe(409);
    expect((await feature(t.juani.token, t.fedePhoto)).status).toBe(409);
    expect(await feedItem(t.tripId, t.fede.token, t.fedePhoto)).toMatchObject({ canFeature: false });
    expect(await feedItem(t.tripId, t.juani.token, t.fedePhoto)).toMatchObject({ canFeature: false });
  });

  it("turning it on cleans every featured photo of the rollo (the authors' own too); turning it off restores nothing", async () => {
    const t = await revealedTrip();
    await feature(t.juani.token, t.fedePhoto);
    await feature(t.fede.token, t.fedePhoto);
    await feature(t.fede.token, t.juaniPhoto);
    const res = await setPrivate(t.tripId, t.juani.token, true);
    expect(res.status).toBe(200);
    expect(res.body.trip.featuringDisabled).toBe(true);
    expect(await featured(t.juani.token, t.juani.userId)).toEqual([]);
    expect(await featured(t.fede.token, t.fede.userId)).toEqual([]);
    await setPrivate(t.tripId, t.juani.token, false);
    expect(await featured(t.fede.token, t.fede.userId)).toEqual([]);
    expect((await feature(t.fede.token, t.fedePhoto)).status).toBe(204);
  });

  it("only the admin can change it", async () => {
    const t = await revealedTrip();
    expect((await setPrivate(t.tripId, t.fede.token, true)).status).toBe(403);
  });

  it("does not touch other rollos' featured photos", async () => {
    const t = await revealedTrip();
    const other = await newTrip();
    const otherPhoto = await uploadMedia(other.tripId, other.adminToken);
    await api("POST", `/trips/${other.tripId}/reveal`, { token: other.adminToken });
    await feature(other.adminToken, otherPhoto);
    await setPrivate(t.tripId, t.juani.token, true);
    expect(await featured(other.adminToken, other.adminUserId)).toEqual([otherPhoto]);
  });
});

describe("the most restrictive level wins", () => {
  it("a photo stays blocked until every level that blocks it is turned back on", async () => {
    const t = await revealedTrip();
    await setAccount(t.fede.token, false);
    await setMember(t.tripId, t.fede.token, false);
    await api("PUT", `/media/${t.fedePhoto}/feature-block`, { token: t.fede.token });
    expect((await feature(t.juani.token, t.fedePhoto)).status).toBe(409);
    await setAccount(t.fede.token, true);
    expect((await feature(t.juani.token, t.fedePhoto)).status).toBe(409);
    await setMember(t.tripId, t.fede.token, true);
    expect((await feature(t.juani.token, t.fedePhoto)).status).toBe(409);
    await api("DELETE", `/media/${t.fedePhoto}/feature-block`, { token: t.fede.token });
    expect((await feature(t.juani.token, t.fedePhoto)).status).toBe(204);
  });
});

describe("the insert re-checks the levels (a level turned off after the service read it)", () => {
  it("inserts nothing when the account, the membership, the rollo or the photo now blocks it", async () => {
    const t = await revealedTrip();
    const insert = async () => (await insertFeaturedUnderCap(env.DB, t.juani.userId, t.fedePhoto, Date.now(), 60).run()).meta.changes;
    await env.DB.prepare("UPDATE members SET allow_featuring = 0 WHERE id = ?").bind(t.fede.memberId).run();
    expect(await insert()).toBe(0);
    await env.DB.prepare("UPDATE members SET allow_featuring = 1 WHERE id = ?").bind(t.fede.memberId).run();
    await env.DB.prepare("UPDATE trips SET featuring_disabled = 1 WHERE id = ?").bind(t.tripId).run();
    expect(await insert()).toBe(0);
    await env.DB.prepare("UPDATE trips SET featuring_disabled = 0 WHERE id = ?").bind(t.tripId).run();
    await setAccount(t.fede.token, false);
    expect(await insert()).toBe(0);
    await setAccount(t.fede.token, true);
    expect(await insert()).toBe(1);
  });
});
