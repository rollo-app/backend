import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { flushPendingPushes } from "../src/lib/push";
import { MyCommentsSchema } from "../src/modules/comments/comments.schemas";
import { api, joinAs, newTrip, uploadMedia } from "./helpers";

/** Revealed trip: Juani (admin) and Fede, one photo each and one video by Fede. */
async function revealedTrip() {
  const trip = await newTrip({ dailyPhotoLimit: 10 });
  const fede = await joinAs(trip.code, "Fede");
  const juaniPhoto = await uploadMedia(trip.tripId, trip.adminToken);
  const fedePhoto = await uploadMedia(trip.tripId, fede.token);
  const res = await api("POST", `/trips/${trip.tripId}/reveal`, { token: trip.adminToken });
  if (res.status !== 200) throw new Error(`reveal failed: ${res.status}`);
  await flushPendingPushes();
  const juani = { token: trip.adminToken, userId: trip.adminUserId };
  return { ...trip, juani, fede, juaniPhoto, fedePhoto };
}

const comment = async (token: string, mediaId: string, text: string): Promise<string> => {
  const res = await api("POST", `/media/${mediaId}/comments`, { token, body: { text } });
  expect(res.status).toBe(201);
  return res.body.id;
};
const myComments = (token: string, query = "") => api("GET", `/me/comments${query}`, { token });
const ids = (res: { body: { items: { commentId: string }[] } }) => res.body.items.map((i) => i.commentId);
const commentedAt = (commentId: string, at: number) => env.DB.prepare("UPDATE comments SET created_at = ? WHERE id = ?").bind(at, commentId).run();

describe("GET /me/comments", () => {
  it("401 without a session", async () => {
    expect((await api("GET", "/me/comments")).status).toBe(401);
  });

  it("is empty when you never commented", async () => {
    const t = await revealedTrip();
    const res = await myComments(t.juani.token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], nextCursor: null, total: 0 });
  });

  it("lists only your comments, newest first, with the photo to open", async () => {
    const t = await revealedTrip();
    const first = await comment(t.juani.token, t.fedePhoto, "Qué foto");
    const second = await comment(t.juani.token, t.juaniPhoto, "Mi foto");
    await comment(t.fede.token, t.juaniPhoto, "De Fede");
    await commentedAt(first, 1_000);
    await commentedAt(second, 2_000);

    const res = await myComments(t.juani.token);
    expect(res.status).toBe(200);
    MyCommentsSchema.parse(res.body);
    expect(ids(res)).toEqual([second, first]);
    expect(res.body.total).toBe(2);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.items[1]).toEqual({
      commentId: first,
      mediaId: t.fedePhoto,
      tripId: t.tripId,
      text: "Qué foto",
      createdAt: 1_000,
      thumbPath: `/trips/${t.tripId}/media/${t.fedePhoto}/thumb`,
      thumbHash: null,
    });
  });

  it("paginates with an opaque cursor, also across comments with the same time", async () => {
    const t = await revealedTrip();
    const all: string[] = [];
    for (const text of ["a", "b", "c"]) {
      const id = await comment(t.juani.token, t.fedePhoto, text);
      await commentedAt(id, 5_000);
      all.push(id);
    }
    const first = await myComments(t.juani.token, "?limit=2");
    expect(first.body.items).toHaveLength(2);
    expect(first.body.total).toBe(3);
    const second = await myComments(t.juani.token, `?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
    expect([...ids(first), ...ids(second)].sort()).toEqual([...all].sort());
  });

  it("400 for a cursor that is not ours or a bad limit", async () => {
    const t = await revealedTrip();
    expect((await myComments(t.juani.token, "?cursor=nope")).status).toBe(400);
    expect((await myComments(t.juani.token, "?limit=0")).status).toBe(400);
    expect((await myComments(t.juani.token, "?limit=101")).status).toBe(400);
  });

  describe("what you can open today", () => {
    it("drops deleted comments", async () => {
      const t = await revealedTrip();
      const id = await comment(t.juani.token, t.fedePhoto, "hola");
      expect((await api("DELETE", `/comments/${id}`, { token: t.juani.token })).status).toBe(204);
      const res = await myComments(t.juani.token);
      expect(res.body.items).toEqual([]);
      expect(res.body.total).toBe(0);
    });

    it("drops comments on a deleted photo", async () => {
      const t = await revealedTrip();
      await comment(t.juani.token, t.fedePhoto, "hola");
      await env.DB.prepare("UPDATE media SET deleted_at = ? WHERE id = ?").bind(Date.now(), t.fedePhoto).run();
      expect((await myComments(t.juani.token)).body.total).toBe(0);
    });

    it("drops comments on a photo the author archived, but keeps the ones on your own archived photo", async () => {
      const t = await revealedTrip();
      await comment(t.juani.token, t.fedePhoto, "de Fede");
      const own = await comment(t.juani.token, t.juaniPhoto, "mía");
      expect((await api("POST", `/media/${t.fedePhoto}/archive`, { token: t.fede.token })).status).toBe(204);
      expect((await api("POST", `/media/${t.juaniPhoto}/archive`, { token: t.juani.token })).status).toBe(204);
      expect(ids(await myComments(t.juani.token))).toEqual([own]);
      expect((await api("POST", `/media/${t.fedePhoto}/unarchive`, { token: t.fede.token })).status).toBe(204);
      expect((await myComments(t.juani.token)).body.total).toBe(2);
    });

    it("drops them when the rollo is not revealed", async () => {
      const t = await revealedTrip();
      await comment(t.juani.token, t.fedePhoto, "hola");
      await env.DB.prepare("UPDATE trips SET revealed_at = NULL, reveal_at = ? WHERE id = ?").bind(Date.now() + 86_400_000, t.tripId).run();
      expect((await myComments(t.juani.token)).body.total).toBe(0);
    });

    it("drops them when you left the rollo and brings them back if you return", async () => {
      const t = await revealedTrip();
      await comment(t.fede.token, t.juaniPhoto, "hola");
      expect((await api("DELETE", `/trips/${t.tripId}/members/me`, { token: t.fede.token })).status).toBe(204);
      expect((await myComments(t.fede.token)).body.total).toBe(0);
      await env.DB.prepare("UPDATE members SET left_at = NULL WHERE trip_id = ? AND user_id = ?").bind(t.tripId, t.fede.userId).run();
      expect((await myComments(t.fede.token)).body.total).toBe(1);
    });

    it("drops them with a block with the photo's author in either direction", async () => {
      const t = await revealedTrip();
      await comment(t.juani.token, t.fedePhoto, "hola");
      await comment(t.fede.token, t.juaniPhoto, "chau");
      await api("PUT", `/blocks/${t.juani.userId}`, { token: t.fede.token });
      expect((await myComments(t.juani.token)).body.total).toBe(0);
      expect((await myComments(t.fede.token)).body.total).toBe(0);
    });

    it("drops them when you reported the photo", async () => {
      const t = await revealedTrip();
      await comment(t.juani.token, t.fedePhoto, "hola");
      expect((await api("POST", "/reports", { token: t.juani.token, body: { mediaId: t.fedePhoto, reason: "offensive" } })).status).toBe(204);
      expect((await myComments(t.juani.token)).body.total).toBe(0);
    });
  });
});
