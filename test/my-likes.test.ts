import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { flushPendingPushes } from "../src/lib/push";
import { MyLikesSchema } from "../src/modules/likes/likes.schemas";
import { api, befriend, joinAs, newTrip, signUp, uploadMedia } from "./helpers";

/** Revealed trip: Juani (admin) and Fede, one photo each and one video by Fede. */
async function revealedTrip() {
  const trip = await newTrip({ dailyPhotoLimit: 10 });
  const fede = await joinAs(trip.code, "Fede");
  const juaniPhoto = await uploadMedia(trip.tripId, trip.adminToken);
  const fedePhoto = await uploadMedia(trip.tripId, fede.token);
  const fedeVideo = await uploadMedia(trip.tripId, fede.token, { type: "video" });
  const res = await api("POST", `/trips/${trip.tripId}/reveal`, { token: trip.adminToken });
  if (res.status !== 200) throw new Error(`reveal failed: ${res.status}`);
  await flushPendingPushes();
  const juani = { token: trip.adminToken, userId: trip.adminUserId };
  return { ...trip, juani, fede, juaniPhoto, fedePhoto, fedeVideo };
}

const like = async (token: string, mediaId: string) => expect((await api("PUT", `/media/${mediaId}/like`, { token })).status).toBe(204);
const myLikes = (token: string, query = "") => api("GET", `/me/likes${query}`, { token });
const ids = (res: { body: { items: { mediaId: string }[] } }) => res.body.items.map((i) => i.mediaId);

/** Pins the like time so order and cursors do not depend on the clock. */
const likedAt = (userId: string, mediaId: string, at: number) =>
  env.DB.prepare("UPDATE likes SET created_at = ? WHERE user_id = ? AND media_id = ?").bind(at, userId, mediaId).run();

describe("GET /me/likes", () => {
  it("401 without a session", async () => {
    expect((await api("GET", "/me/likes")).status).toBe(401);
  });

  it("is empty when nothing was liked", async () => {
    const t = await revealedTrip();
    const res = await myLikes(t.juani.token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], nextCursor: null, total: 0 });
  });

  it("lists the liked photos newest like first, with where to open each one", async () => {
    const t = await revealedTrip();
    await like(t.juani.token, t.juaniPhoto);
    await like(t.juani.token, t.fedePhoto);
    await likedAt(t.juani.userId, t.juaniPhoto, 2_000);
    await likedAt(t.juani.userId, t.fedePhoto, 1_000);

    const res = await myLikes(t.juani.token);
    expect(res.status).toBe(200);
    MyLikesSchema.parse(res.body);
    expect(ids(res)).toEqual([t.juaniPhoto, t.fedePhoto]);
    expect(res.body.total).toBe(2);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.items[1]).toMatchObject({
      mediaId: t.fedePhoto,
      likedAt: 1_000,
      authorUserId: t.fede.userId,
      thumbPath: `/trips/${t.tripId}/media/${t.fedePhoto}/thumb`,
      source: { kind: "trip", tripId: t.tripId },
    });
    expect(res.body.items[0].authorUserId).toBe(t.juani.userId);
  });

  it("only returns your own likes", async () => {
    const t = await revealedTrip();
    await like(t.juani.token, t.fedePhoto);
    expect(ids(await myLikes(t.fede.token))).toEqual([]);
  });

  it("paginates by like time with an opaque cursor", async () => {
    const t = await revealedTrip();
    const third = await insertPhoto(t.tripId, t.fede.memberId);
    for (const [i, id] of [t.juaniPhoto, t.fedePhoto, third].entries()) {
      await like(t.juani.token, id);
      await likedAt(t.juani.userId, id, 1_000 + i);
    }
    const first = await myLikes(t.juani.token, "?limit=2");
    expect(ids(first)).toEqual([third, t.fedePhoto]);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    expect(first.body.total).toBe(3);

    const second = await myLikes(t.juani.token, `?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(ids(second)).toEqual([t.juaniPhoto]);
    expect(second.body.nextCursor).toBeNull();
  });

  it("does not skip likes that share the same time", async () => {
    const t = await revealedTrip();
    const third = await insertPhoto(t.tripId, t.fede.memberId);
    for (const id of [t.juaniPhoto, t.fedePhoto, third]) {
      await like(t.juani.token, id);
      await likedAt(t.juani.userId, id, 5_000);
    }
    const first = await myLikes(t.juani.token, "?limit=2");
    const second = await myLikes(t.juani.token, `?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect([...ids(first), ...ids(second)].sort()).toEqual([t.juaniPhoto, t.fedePhoto, third].sort());
  });

  it("400 for a cursor that is not ours or a bad limit", async () => {
    const t = await revealedTrip();
    expect((await myLikes(t.juani.token, "?cursor=nope")).status).toBe(400);
    expect((await myLikes(t.juani.token, "?limit=0")).status).toBe(400);
    expect((await myLikes(t.juani.token, "?limit=101")).status).toBe(400);
  });

  describe("what you can see today", () => {
    it("drops a photo of a rollo that is not revealed", async () => {
      const t = await revealedTrip();
      await like(t.juani.token, t.fedePhoto);
      await env.DB.prepare("UPDATE trips SET revealed_at = NULL, reveal_at = ? WHERE id = ?").bind(Date.now() + 86_400_000, t.tripId).run();
      const res = await myLikes(t.juani.token);
      expect(ids(res)).toEqual([]);
      expect(res.body.total).toBe(0);
    });

    it("drops a deleted photo and never lists videos", async () => {
      const t = await revealedTrip();
      await like(t.juani.token, t.fedePhoto);
      await env.DB.prepare("UPDATE media SET deleted_at = ? WHERE id = ?").bind(Date.now(), t.fedePhoto).run();
      await env.DB.prepare("INSERT INTO likes (user_id, media_id, created_at) VALUES (?, ?, ?)").bind(t.juani.userId, t.fedeVideo, Date.now()).run();
      expect(ids(await myLikes(t.juani.token))).toEqual([]);
    });

    it("drops the photos of a rollo you left, unless a profile you can see still features them", async () => {
      const t = await revealedTrip();
      await like(t.fede.token, t.juaniPhoto);
      expect((await api("DELETE", `/trips/${t.tripId}/members/me`, { token: t.fede.token })).status).toBe(204);
      expect(ids(await myLikes(t.fede.token))).toEqual([]);

      // Juani features his own photo on a public profile: Fede still sees it there.
      expect((await api("PUT", `/me/featured/${t.juaniPhoto}`, { token: t.juani.token })).status).toBe(204);
      expect(ids(await myLikes(t.fede.token))).toEqual([]);
      await api("PATCH", "/me", { token: t.juani.token, body: { profileVisibility: "public" } });
      const res = await myLikes(t.fede.token);
      expect(ids(res)).toEqual([t.juaniPhoto]);
      expect(res.body.items[0].source).toEqual({ kind: "featured", userId: t.juani.userId });
      expect(res.body.items[0].thumbPath).toBe(`/featured/${t.juani.userId}/${t.juaniPhoto}/thumb`);
    });

    describe("through a profile", () => {
      /** Juani features Fede's photo (private profile); Cami, a friend of Juani and not in the rollo, likes it. */
      async function featuredAndLikedByCami() {
        const t = await revealedTrip();
        const cami = await signUp(undefined, "Cami");
        await befriend(t.juani.token, cami.token);
        expect((await api("PUT", `/me/featured/${t.fedePhoto}`, { token: t.juani.token })).status).toBe(204);
        await like(cami.token, t.fedePhoto);
        return { ...t, cami };
      }

      it("lists it as featured, and hides the rollo", async () => {
        const t = await featuredAndLikedByCami();
        const res = await myLikes(t.cami.token);
        expect(res.body.items).toEqual([
          {
            mediaId: t.fedePhoto,
            likedAt: expect.any(Number),
            authorUserId: t.fede.userId,
            thumbPath: `/featured/${t.juani.userId}/${t.fedePhoto}/thumb`,
            thumbHash: null,
            source: { kind: "featured", userId: t.juani.userId },
          },
        ]);
        expect(JSON.stringify(res.body)).not.toContain(t.tripId);
      });

      it("drops it when the photo leaves the profile and brings it back if it returns", async () => {
        const t = await featuredAndLikedByCami();
        await api("DELETE", `/me/featured/${t.fedePhoto}`, { token: t.juani.token });
        expect(ids(await myLikes(t.cami.token))).toEqual([]);
        await api("PUT", `/me/featured/${t.fedePhoto}`, { token: t.juani.token });
        expect(ids(await myLikes(t.cami.token))).toEqual([t.fedePhoto]);
      });

      it("drops it when the author blocks features of it", async () => {
        const t = await featuredAndLikedByCami();
        await api("PUT", `/media/${t.fedePhoto}/feature-block`, { token: t.fede.token });
        expect(ids(await myLikes(t.cami.token))).toEqual([]);
      });

      it("drops it when the profile is private and you are not a friend anymore", async () => {
        const t = await featuredAndLikedByCami();
        await api("PATCH", "/me", { token: t.juani.token, body: { profileVisibility: "public" } });
        const stranger = await signUp();
        await like(stranger.token, t.fedePhoto);
        await api("PATCH", "/me", { token: t.juani.token, body: { profileVisibility: "friends" } });
        expect(ids(await myLikes(stranger.token))).toEqual([]);
        expect(ids(await myLikes(t.cami.token))).toEqual([t.fedePhoto]);
        expect((await api("DELETE", `/friends/${t.juani.userId}`, { token: t.cami.token })).status).toBe(204);
        expect(ids(await myLikes(t.cami.token))).toEqual([]);
      });

      it("drops it with a block between you and the profile owner, in either direction", async () => {
        const t = await featuredAndLikedByCami();
        await api("PATCH", "/me", { token: t.juani.token, body: { profileVisibility: "public" } });
        await api("PUT", `/blocks/${t.cami.userId}`, { token: t.juani.token });
        expect(ids(await myLikes(t.cami.token))).toEqual([]);
        await api("DELETE", `/blocks/${t.cami.userId}`, { token: t.juani.token });
        expect(ids(await myLikes(t.cami.token))).toEqual([t.fedePhoto]);
        await api("PUT", `/blocks/${t.juani.userId}`, { token: t.cami.token });
        expect(ids(await myLikes(t.cami.token))).toEqual([]);
      });

      it("the rollo wins when both ways work", async () => {
        const t = await featuredAndLikedByCami();
        // Juani is a member and also features it himself... Fede's photo is featured by Juani, so Juani sees both ways.
        await like(t.juani.token, t.fedePhoto);
        const res = await myLikes(t.juani.token);
        expect(res.body.items).toHaveLength(1);
        expect(res.body.items[0].source).toEqual({ kind: "trip", tripId: t.tripId });
      });
    });

    it("drops photos from an author who blocked you or that you blocked", async () => {
      const t = await revealedTrip();
      await like(t.juani.token, t.fedePhoto);
      await like(t.fede.token, t.juaniPhoto);
      await api("PUT", `/blocks/${t.juani.userId}`, { token: t.fede.token });
      expect(ids(await myLikes(t.juani.token))).toEqual([]);
      expect(ids(await myLikes(t.fede.token))).toEqual([]);
    });

    it("drops a photo you reported", async () => {
      const t = await revealedTrip();
      await like(t.juani.token, t.fedePhoto);
      expect((await api("POST", "/reports", { token: t.juani.token, body: { mediaId: t.fedePhoto, reason: "offensive" } })).status).toBe(204);
      expect(ids(await myLikes(t.juani.token))).toEqual([]);
    });
  });
});

/** Another uploaded photo of a member straight into D1 (the rollo is already revealed). */
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
