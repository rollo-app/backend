import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, befriend, joinAs, newTrip, uploadMedia } from "./helpers";

const NOT_FRIEND = "Solo podés destacar fotos tuyas o de tus amigos";

/** Revealed trip: Juani (admin), Fede and Cami, one photo each. Nobody is friends with anybody yet. */
async function revealedTrip() {
  const trip = await newTrip({ dailyPhotoLimit: 10 });
  const fede = await joinAs(trip.code, "Fede");
  const cami = await joinAs(trip.code, "Cami");
  const juaniPhoto = await uploadMedia(trip.tripId, trip.adminToken);
  const fedePhoto = await uploadMedia(trip.tripId, fede.token);
  const camiPhoto = await uploadMedia(trip.tripId, cami.token);
  await api("POST", `/trips/${trip.tripId}/reveal`, { token: trip.adminToken });
  return { ...trip, juani: { token: trip.adminToken, userId: trip.adminUserId }, fede, cami, juaniPhoto, fedePhoto, camiPhoto };
}

const feature = (token: string, mediaId: string) => api("PUT", `/me/featured/${mediaId}`, { token });
/** The media a user has featured, straight from D1 (their profile may not be visible to whoever is asking). */
const featured = async (_token: string, userId: string) =>
  (await env.DB.prepare("SELECT media_id FROM featured WHERE user_id = ? ORDER BY media_id").bind(userId).all<{ media_id: string }>()).results.map((r) => r.media_id);
const feedItem = async (tripId: string, token: string, id: string) =>
  (await api("GET", `/trips/${tripId}/feed`, { token })).body.items.find((i: any) => i.id === id);
const sorted = (...ids: string[]) => ids.sort();

describe("only your photos or a friend's can be featured", () => {
  it("PUT 409 for a photo of someone who is not your friend, even in your rollo", async () => {
    const t = await revealedTrip();
    const res = await feature(t.juani.token, t.fedePhoto);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: NOT_FRIEND });
    expect(await featured(t.juani.token, t.juani.userId)).toEqual([]);
  });

  it("PUT works for your own photos and for a friend's", async () => {
    const t = await revealedTrip();
    await befriend(t.juani.token, t.fede.token);
    expect((await feature(t.juani.token, t.juaniPhoto)).status).toBe(204);
    expect((await feature(t.juani.token, t.fedePhoto)).status).toBe(204);
    expect((await feature(t.juani.token, t.camiPhoto)).status).toBe(409);
    expect(await featured(t.juani.token, t.juani.userId)).toEqual(sorted(t.juaniPhoto, t.fedePhoto));
  });

  it("canFeature in the feed is true for yours and your friends' photos only", async () => {
    const t = await revealedTrip();
    await befriend(t.juani.token, t.fede.token);
    expect(await feedItem(t.tripId, t.juani.token, t.juaniPhoto)).toMatchObject({ canFeature: true });
    expect(await feedItem(t.tripId, t.juani.token, t.fedePhoto)).toMatchObject({ canFeature: true });
    expect(await feedItem(t.tripId, t.juani.token, t.camiPhoto)).toMatchObject({ canFeature: false });
    expect(await feedItem(t.tripId, t.cami.token, t.camiPhoto)).toMatchObject({ canFeature: true });
  });

  it("the private rollo still blocks even your own photos and friends' photos", async () => {
    const t = await revealedTrip();
    await befriend(t.juani.token, t.fede.token);
    await api("PATCH", `/trips/${t.tripId}`, { token: t.juani.token, body: { featuringDisabled: true } });
    expect((await feature(t.juani.token, t.fedePhoto)).status).toBe(409);
    expect(await feedItem(t.tripId, t.juani.token, t.fedePhoto)).toMatchObject({ canFeature: false });
  });
});

/** Juani and Fede are friends and each features the other's photo (and their own); Cami and Juani are friends too and Cami features Fede's... no: Cami features Juani's. */
async function friendsFeaturing() {
  const t = await revealedTrip();
  await befriend(t.juani.token, t.fede.token);
  await befriend(t.juani.token, t.cami.token);
  for (const [who, media] of [
    [t.juani, t.juaniPhoto],
    [t.juani, t.fedePhoto],
    [t.fede, t.fedePhoto],
    [t.fede, t.juaniPhoto],
    [t.cami, t.juaniPhoto],
  ] as const) {
    expect((await feature(who.token, media)).status).toBe(204);
  }
  return t;
}

describe("when the friendship ends or a block is created, each profile loses the other's photos", () => {
  it.each([
    ["Juani deletes Fede", "juani"],
    ["Fede deletes Juani", "fede"],
  ] as const)("%s", async (_label, who) => {
    const t = await friendsFeaturing();
    const other = who === "juani" ? t.fede : t.juani;
    const res = await api("DELETE", `/friends/${other.userId}`, { token: t[who].token });
    expect(res.status).toBe(204);
    // Own photos stay on their own profile; the other's photos are gone from both.
    expect(await featured(t.juani.token, t.juani.userId)).toEqual([t.juaniPhoto]);
    expect(await featured(t.fede.token, t.fede.userId)).toEqual([t.fedePhoto]);
    // Cami (still Juani's friend) keeps featuring Juani's photo.
    expect(await featured(t.cami.token, t.cami.userId)).toEqual([t.juaniPhoto]);
  });

  it("being friends again does not bring them back", async () => {
    const t = await friendsFeaturing();
    await api("DELETE", `/friends/${t.fede.userId}`, { token: t.juani.token });
    await befriend(t.juani.token, t.fede.token);
    expect(await featured(t.juani.token, t.juani.userId)).toEqual([t.juaniPhoto]);
    expect(await featured(t.fede.token, t.fede.userId)).toEqual([t.fedePhoto]);
    // ...but they can be featured again by hand.
    expect((await feature(t.juani.token, t.fedePhoto)).status).toBe(204);
  });

  it.each([
    ["Juani blocks Fede", "juani"],
    ["Fede blocks Juani", "fede"],
  ] as const)("%s", async (_label, who) => {
    const t = await friendsFeaturing();
    const other = who === "juani" ? t.fede : t.juani;
    expect((await api("PUT", `/blocks/${other.userId}`, { token: t[who].token })).status).toBe(204);
    expect(await featured(t.juani.token, t.juani.userId)).toEqual([t.juaniPhoto]);
    expect(await featured(t.fede.token, t.fede.userId)).toEqual([t.fedePhoto]);
    expect(await featured(t.cami.token, t.cami.userId)).toEqual([t.juaniPhoto]);
  });
});

describe("migration 0028_featured_only_friends", () => {
  it("deletes featured rows whose author is neither the owner nor a friend, and keeps the rest", async () => {
    const t = await revealedTrip();
    await befriend(t.juani.token, t.fede.token);
    const insert = (userId: string, mediaId: string) =>
      env.DB.prepare("INSERT INTO featured (user_id, media_id, created_at) VALUES (?, ?, ?)").bind(userId, mediaId, Date.now()).run();
    await insert(t.juani.userId, t.juaniPhoto); // own
    await insert(t.juani.userId, t.fedePhoto); // friend
    await insert(t.juani.userId, t.camiPhoto); // stranger: goes
    await insert(t.fede.userId, t.camiPhoto); // stranger: goes

    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0028_featured_only_friends"));
    expect(migration).toBeDefined();
    await env.DB.batch(migration!.queries.map((q) => env.DB.prepare(q)));

    const { results } = await env.DB.prepare("SELECT user_id, media_id FROM featured ORDER BY media_id").all<{ user_id: string; media_id: string }>();
    expect(results.map((r) => `${r.user_id}:${r.media_id}`).sort()).toEqual(
      [`${t.juani.userId}:${t.juaniPhoto}`, `${t.juani.userId}:${t.fedePhoto}`].sort(),
    );
  });
});
