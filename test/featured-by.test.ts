import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { FeaturedByListSchema } from "../src/modules/featured/featured.schemas";
import { api, befriend, joinAs, newTrip, signUp, uploadMedia } from "./helpers";

/** Revealed trip: Juani (admin) and Fede, one photo each. Juani and Fede are friends. */
async function revealedTrip() {
  const trip = await newTrip({ dailyPhotoLimit: 10 });
  const fede = await joinAs(trip.code, "Fede");
  const juaniPhoto = await uploadMedia(trip.tripId, trip.adminToken);
  const fedePhoto = await uploadMedia(trip.tripId, fede.token);
  const res = await api("POST", `/trips/${trip.tripId}/reveal`, { token: trip.adminToken });
  if (res.status !== 200) throw new Error(`reveal failed: ${res.status}`);
  const juani = { token: trip.adminToken, userId: trip.adminUserId };
  await befriend(juani.token, fede.token);
  return { ...trip, juani, fede, juaniPhoto, fedePhoto };
}

const feature = async (token: string, mediaId: string) => expect((await api("PUT", `/me/featured/${mediaId}`, { token })).status).toBe(204);
const featuredBy = (token: string, query = "") => api("GET", `/me/featured-by${query}`, { token });
const ids = (res: { body: { items: { mediaId: string }[] } }) => res.body.items.map((i) => i.mediaId);
const featuredAt = (userId: string, mediaId: string, at: number) =>
  env.DB.prepare("UPDATE featured SET created_at = ? WHERE user_id = ? AND media_id = ?").bind(at, userId, mediaId).run();

describe("GET /me/featured-by", () => {
  it("401 without a session", async () => {
    expect((await api("GET", "/me/featured-by")).status).toBe(401);
  });

  it("is empty when nobody featured your photos", async () => {
    const t = await revealedTrip();
    const res = await featuredBy(t.juani.token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], nextCursor: null, total: 0 });
  });

  it("lists who featured your photos, newest first, and never your own featuring", async () => {
    const t = await revealedTrip();
    await feature(t.juani.token, t.fedePhoto);
    await feature(t.fede.token, t.fedePhoto); // yours on your own profile: not listed
    await featuredAt(t.juani.userId, t.fedePhoto, 3_000);

    const res = await featuredBy(t.fede.token);
    expect(res.status).toBe(200);
    FeaturedByListSchema.parse(res.body);
    expect(res.body).toEqual({
      items: [
        {
          mediaId: t.fedePhoto,
          user: { id: t.juani.userId, name: "Juani", username: expect.any(String), avatarUrl: null, bio: null },
          featuredAt: 3_000,
          thumbPath: `/featured/${t.juani.userId}/${t.fedePhoto}/thumb`,
          thumbHash: null,
        },
      ],
      nextCursor: null,
      total: 1,
    });
    // Juani's own photo featured by Fede shows up for Juani, not for Fede.
    await feature(t.fede.token, t.juaniPhoto);
    expect(ids(await featuredBy(t.juani.token))).toEqual([t.juaniPhoto]);
  });

  it("orders newest first and paginates, also across rows with the same time", async () => {
    const t = await revealedTrip();
    const extra = await insertPhoto(t.tripId, t.fede.memberId);
    const extra2 = await insertPhoto(t.tripId, t.fede.memberId);
    for (const id of [t.fedePhoto, extra, extra2]) {
      await feature(t.juani.token, id);
      await featuredAt(t.juani.userId, id, 5_000);
    }
    await featuredAt(t.juani.userId, extra2, 9_000);
    const first = await featuredBy(t.fede.token, "?limit=2");
    expect(first.body.items).toHaveLength(2);
    expect(first.body.items[0].mediaId).toBe(extra2);
    expect(first.body.total).toBe(3);
    const second = await featuredBy(t.fede.token, `?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
    expect([...ids(first), ...ids(second)].sort()).toEqual([t.fedePhoto, extra, extra2].sort());
  });

  it("400 for a cursor that is not ours or a bad limit", async () => {
    const t = await revealedTrip();
    expect((await featuredBy(t.fede.token, "?cursor=nope")).status).toBe(400);
    expect((await featuredBy(t.fede.token, "?limit=0")).status).toBe(400);
    expect((await featuredBy(t.fede.token, "?limit=101")).status).toBe(400);
  });

  describe("what you can see today", () => {
    it("drops it when the photo leaves the profile", async () => {
      const t = await revealedTrip();
      await feature(t.juani.token, t.fedePhoto);
      expect((await api("DELETE", `/me/featured/${t.fedePhoto}`, { token: t.juani.token })).status).toBe(204);
      expect((await featuredBy(t.fede.token)).body.total).toBe(0);
    });

    it("drops it when the photo is archived or deleted", async () => {
      const t = await revealedTrip();
      await feature(t.juani.token, t.fedePhoto);
      await api("POST", `/media/${t.fedePhoto}/archive`, { token: t.fede.token });
      expect((await featuredBy(t.fede.token)).body.total).toBe(0);
    });

    it("drops it when the featurer's profile is private and you are not friends (legacy row)", async () => {
      const t = await revealedTrip();
      const stranger = await signUp(undefined, "Cami");
      await joinInto(t.tripId, stranger.userId);
      const camiPhoto = await uploadInserted(t.tripId, stranger.userId);
      // Juani and Cami are not friends: a row from before friends-only featuring.
      await env.DB.prepare("INSERT INTO featured (user_id, media_id, created_at) VALUES (?, ?, ?)").bind(t.juani.userId, camiPhoto, Date.now()).run();
      expect((await featuredBy(stranger.token)).body.total).toBe(0);
      await api("PATCH", "/me", { token: t.juani.token, body: { profileVisibility: "public" } });
      const res = await featuredBy(stranger.token);
      expect(ids(res)).toEqual([camiPhoto]);
      await api("PATCH", "/me", { token: t.juani.token, body: { profileVisibility: "friends" } });
      expect((await featuredBy(stranger.token)).body.total).toBe(0);
    });

    it("drops it with a block between the two, in either direction", async () => {
      const t = await revealedTrip();
      await feature(t.juani.token, t.fedePhoto);
      await api("PATCH", "/me", { token: t.juani.token, body: { profileVisibility: "public" } });
      // A block already wipes the featured rows; insert one back to prove the read side filters too.
      await api("PUT", `/blocks/${t.fede.userId}`, { token: t.juani.token });
      await env.DB.prepare("INSERT OR IGNORE INTO featured (user_id, media_id, created_at) VALUES (?, ?, ?)").bind(t.juani.userId, t.fedePhoto, Date.now()).run();
      expect((await featuredBy(t.fede.token)).body.total).toBe(0);
      await api("DELETE", `/blocks/${t.fede.userId}`, { token: t.juani.token });
      await api("PUT", `/blocks/${t.juani.userId}`, { token: t.fede.token });
      await env.DB.prepare("INSERT OR IGNORE INTO featured (user_id, media_id, created_at) VALUES (?, ?, ?)").bind(t.juani.userId, t.fedePhoto, Date.now()).run();
      expect((await featuredBy(t.fede.token)).body.total).toBe(0);
    });

    it("drops it when the featurer left the rollo", async () => {
      const t = await revealedTrip();
      await feature(t.juani.token, t.fedePhoto);
      await env.DB.prepare("UPDATE members SET left_at = ? WHERE trip_id = ? AND user_id = ?").bind(Date.now(), t.tripId, t.juani.userId).run();
      expect((await featuredBy(t.fede.token)).body.total).toBe(0);
    });
  });
});

async function joinInto(tripId: string, userId: string) {
  await env.DB.prepare("INSERT INTO members (id, trip_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)")
    .bind(crypto.randomUUID(), tripId, userId, Date.now())
    .run();
}

/** An uploaded photo of a user already in the rollo, straight into D1. */
async function uploadInserted(tripId: string, userId: string): Promise<string> {
  const member = await env.DB.prepare("SELECT id FROM members WHERE trip_id = ? AND user_id = ?").bind(tripId, userId).first<{ id: string }>();
  return insertPhoto(tripId, member!.id);
}

async function insertPhoto(tripId: string, memberId: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO media (id, trip_id, member_id, type, taken_at, local_date, original_key, thumb_key, status, created_at)
     VALUES (?, ?, ?, 'photo', ?, '2027-01-12', ?, ?, 'uploaded', ?)`,
  )
    .bind(id, tripId, memberId, Date.now(), `trips/${tripId}/${id}/original.jpg`, `trips/${tripId}/${id}/thumb.jpg`, Date.now())
    .run();
  return id;
}
