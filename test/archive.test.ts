import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { localDate } from "../src/lib/util";
import { flushPendingPushes } from "../src/lib/push";
import { DAY, MINUTE, TZ, api, befriend, joinAs, mockExpo, newTrip, registerToken, signUp, uploadMedia } from "./helpers";

/**
 * Revealed rollo: Juani (admin), Fede and Cami. Fede took `photo` (the one archived/deleted in the tests) and `other`,
 * plus a video; Juani took `juani`. Before the tests act, Juani and Cami like `photo`, Juani comments on it, and both
 * Juani and Fede feature it. Fede's profile is public.
 */
async function revealedTrip() {
  const trip = await newTrip({ dailyPhotoLimit: 10, dailyVideoLimit: 1 });
  const fede = await joinAs(trip.code, "Fede");
  const cami = await joinAs(trip.code, "Cami");
  const photo = await uploadMedia(trip.tripId, fede.token);
  const other = await uploadMedia(trip.tripId, fede.token);
  const video = await uploadMedia(trip.tripId, fede.token, { type: "video" });
  const juaniPhoto = await uploadMedia(trip.tripId, trip.adminToken);
  expect((await api("POST", `/trips/${trip.tripId}/reveal`, { token: trip.adminToken })).status).toBe(200);
  const juani = { token: trip.adminToken, userId: trip.adminUserId };
  await api("PATCH", "/me", { token: fede.token, body: { profileVisibility: "public" } });
  // Featuring someone else's photo is for friends only.
  await befriend(juani.token, fede.token);
  await befriend(cami.token, fede.token);
  expect((await api("PUT", `/media/${photo}/like`, { token: juani.token })).status).toBe(204);
  expect((await api("PUT", `/media/${photo}/like`, { token: cami.token })).status).toBe(204);
  expect((await api("POST", `/media/${photo}/comments`, { token: juani.token, body: { text: "qué foto" } })).status).toBe(201);
  expect((await api("PUT", `/me/featured/${photo}`, { token: juani.token })).status).toBe(204);
  expect((await api("PUT", `/me/featured/${photo}`, { token: fede.token })).status).toBe(204);
  return { ...trip, juani, fede, cami, photo, other, video, juaniPhoto };
}

/** Revealed rollo with Fede's daily moment (main photo + linked image). */
async function revealedMoment() {
  const trip = await newTrip({ momentMode: "photo_selfie", startsAt: Date.now() - 5 * DAY });
  const fede = await joinAs(trip.code, "Fede");
  const notifyAt = Date.now() - 2 * MINUTE;
  const day = localDate(notifyAt, TZ);
  await env.DB.prepare("INSERT INTO trip_moments (trip_id, user_id, day, notify_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(trip.tripId, fede.userId, day, notifyAt, Date.now())
    .run();
  const mainId = await uploadMedia(trip.tripId, fede.token, { momentDay: day, takenAt: notifyAt + MINUTE });
  const linkedId = await uploadMedia(trip.tripId, fede.token, { pairedMediaId: mainId });
  expect((await api("POST", `/trips/${trip.tripId}/reveal`, { token: trip.adminToken })).status).toBe(200);
  return { ...trip, fede, mainId, linkedId };
}

const archive = (token: string, id: string) => api("POST", `/media/${id}/archive`, { token });
const unarchive = (token: string, id: string) => api("POST", `/media/${id}/unarchive`, { token });
const remove = (token: string, id: string) => api("DELETE", `/media/${id}`, { token });
const feed = (tripId: string, token: string) => api("GET", `/trips/${tripId}/feed`, { token });
const feedIds = async (tripId: string, token: string) => (await feed(tripId, token)).body.items.map((i: { id: string }) => i.id);
const file = (tripId: string, id: string, variant: string, token: string) => api("GET", `/trips/${tripId}/media/${id}/${variant}`, { token });
const featuredIds = async (token: string, userId: string) =>
  (await api("GET", `/users/${userId}/featured`, { token })).body.photos.map((p: { mediaId: string }) => p.mediaId);
const myLikeIds = async (token: string) => (await api("GET", "/me/likes", { token })).body.items.map((i: { mediaId: string }) => i.mediaId);

describe("POST /media/:id/archive", () => {
  it("hides the photo from everyone but its author, who still sees it marked as archived", async () => {
    const t = await revealedTrip();
    expect((await archive(t.fede.token, t.photo)).status).toBe(204);

    expect(await feedIds(t.tripId, t.juani.token)).not.toContain(t.photo);
    expect(await feedIds(t.tripId, t.cami.token)).not.toContain(t.photo);
    const own = (await feed(t.tripId, t.fede.token)).body.items;
    expect(own.find((i: any) => i.id === t.photo)).toMatchObject({ archived: true });
    expect(own.find((i: any) => i.id === t.other)).toMatchObject({ archived: false });
  });

  it("is idempotent", async () => {
    const t = await revealedTrip();
    expect((await archive(t.fede.token, t.photo)).status).toBe(204);
    expect((await archive(t.fede.token, t.photo)).status).toBe(204);
  });

  it("its files can only be downloaded by the author", async () => {
    const t = await revealedTrip();
    await archive(t.fede.token, t.photo);
    for (const variant of ["thumb", "original"]) {
      expect((await file(t.tripId, t.photo, variant, t.juani.token)).status).toBe(404);
      expect((await file(t.tripId, t.photo, variant, t.cami.token)).status).toBe(404);
      expect((await file(t.tripId, t.photo, variant, t.fede.token)).status).toBe(200);
    }
  });

  it("others can't like or unlike-count it, and it leaves their 'Tu actividad'", async () => {
    const t = await revealedTrip();
    expect(await myLikeIds(t.juani.token)).toContain(t.photo);
    await archive(t.fede.token, t.photo);

    expect((await api("PUT", `/media/${t.photo}/like`, { token: t.juani.token })).status).toBe(404);
    expect(await myLikeIds(t.juani.token)).not.toContain(t.photo);
    expect((await api("GET", "/me/likes", { token: t.juani.token })).body.total).toBe(0);
    // The author can still like their own archived photo and sees it in their list.
    expect((await api("PUT", `/media/${t.photo}/like`, { token: t.fede.token })).status).toBe(204);
    expect(await myLikeIds(t.fede.token)).toContain(t.photo);
  });

  it("others can't read or write its comments", async () => {
    const t = await revealedTrip();
    await archive(t.fede.token, t.photo);
    expect((await api("GET", `/media/${t.photo}/comments`, { token: t.juani.token })).status).toBe(404);
    expect((await api("POST", `/media/${t.photo}/comments`, { token: t.cami.token, body: { text: "hola" } })).status).toBe(404);
    expect((await api("GET", `/media/${t.photo}/comments`, { token: t.fede.token })).status).toBe(200);
  });

  it("the author commenting on it doesn't notify the others who commented before", async () => {
    const t = await revealedTrip();
    const { sent } = mockExpo();
    await registerToken(t.juani.token);
    await archive(t.fede.token, t.photo);
    // Outside the anti-spam window, so the comment would notify.
    await env.DB.prepare("UPDATE media SET comment_notified_at = NULL WHERE id = ?").bind(t.photo).run();
    expect((await api("POST", `/media/${t.photo}/comments`, { token: t.fede.token, body: { text: "para mí" } })).status).toBe(201);
    await flushPendingPushes();
    expect(sent).toHaveLength(0);
  });

  it("the author's own archived photo comes with canFeature false (old builds would offer to feature it)", async () => {
    const t = await revealedTrip();
    await archive(t.fede.token, t.other);
    const own = (await feed(t.tripId, t.fede.token)).body.items.find((i: any) => i.id === t.other);
    expect(own).toMatchObject({ archived: true, canFeature: false });
  });

  it("the author can still report someone else's comment on their archived photo; others can't", async () => {
    const t = await revealedTrip();
    const comments = await api("GET", `/media/${t.photo}/comments`, { token: t.fede.token });
    const commentId = comments.body.comments?.[0]?.id ?? comments.body[0]?.id ?? comments.body.items?.[0]?.id;
    expect(commentId).toBeTruthy();
    await archive(t.fede.token, t.photo);
    expect((await api("POST", "/reports", { token: t.fede.token, body: { commentId, reason: "offensive" } })).status).toBe(204);
    expect((await api("POST", "/reports", { token: t.cami.token, body: { commentId, reason: "offensive" } })).status).toBe(404);
  });

  it("others can't report it", async () => {
    const t = await revealedTrip();
    await archive(t.fede.token, t.photo);
    expect((await api("POST", "/reports", { token: t.juani.token, body: { mediaId: t.photo, reason: "offensive" } })).status).toBe(404);
  });

  it("removes it from every profile where it was featured, and unarchiving doesn't bring it back", async () => {
    const t = await revealedTrip();
    expect(await featuredIds(t.juani.token, t.juani.userId)).toContain(t.photo);
    expect(await featuredIds(t.juani.token, t.fede.userId)).toContain(t.photo);

    await archive(t.fede.token, t.photo);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM featured WHERE media_id = ?").bind(t.photo).first<{ n: number }>();
    expect(rows!.n).toBe(0);
    expect(await featuredIds(t.juani.token, t.juani.userId)).not.toContain(t.photo);
    expect(await featuredIds(t.cami.token, t.fede.userId)).not.toContain(t.photo);
    expect((await api("GET", `/featured/${t.fede.userId}/${t.photo}/thumb`, { token: t.cami.token })).status).toBe(404);

    await unarchive(t.fede.token, t.photo);
    expect(await featuredIds(t.juani.token, t.juani.userId)).not.toContain(t.photo);
    expect(await featuredIds(t.fede.token, t.fede.userId)).not.toContain(t.photo);
    // It can be featured again.
    expect((await api("PUT", `/me/featured/${t.photo}`, { token: t.juani.token })).status).toBe(204);
  });

  it("an archived photo can't be featured: 404 for others, 409 for the author", async () => {
    const t = await revealedTrip();
    await archive(t.fede.token, t.other);
    expect((await api("PUT", `/me/featured/${t.other}`, { token: t.cami.token })).status).toBe(404);
    expect((await api("PUT", `/me/featured/${t.other}`, { token: t.fede.token })).status).toBe(409);
  });

  it("totals shown to others don't count it", async () => {
    const t = await revealedTrip();
    const before = (await api("GET", `/trips/${t.tripId}`, { token: t.juani.token })).body.totalUploaded;
    const myTripsBefore = (await api("GET", "/me/trips", { token: t.juani.token })).body.trips[0].totalUploaded;
    await archive(t.fede.token, t.photo);
    expect((await api("GET", `/trips/${t.tripId}`, { token: t.juani.token })).body.totalUploaded).toBe(before - 1);
    expect((await api("GET", "/me/trips", { token: t.juani.token })).body.trips[0].totalUploaded).toBe(myTripsBefore - 1);
    // The author still counts it: it is still in their gallery.
    expect((await api("GET", `/trips/${t.tripId}`, { token: t.fede.token })).body.totalUploaded).toBe(before);
  });

  it("only the author can archive: another member (even the admin) 403, an outsider 404", async () => {
    const t = await revealedTrip();
    expect((await archive(t.juani.token, t.photo)).status).toBe(403);
    expect((await archive(t.cami.token, t.photo)).status).toBe(403);
    const outsider = await signUp(undefined, "Tomi");
    expect((await archive(outsider.token, t.photo)).status).toBe(404);
    expect((await archive(t.fede.token, crypto.randomUUID())).status).toBe(404);
  });

  it("the author must still be an active member", async () => {
    const t = await revealedTrip();
    expect((await api("DELETE", `/trips/${t.tripId}/members/me`, { token: t.fede.token })).status).toBe(204);
    expect((await archive(t.fede.token, t.photo)).status).toBe(404);
  });

  it("only once revealed (409 before)", async () => {
    const trip = await newTrip();
    const fede = await joinAs(trip.code, "Fede");
    const id = await uploadMedia(trip.tripId, fede.token);
    expect((await archive(fede.token, id)).status).toBe(409);
    expect((await unarchive(fede.token, id)).status).toBe(409);
  });

  it("requires a session", async () => {
    const t = await revealedTrip();
    expect((await api("POST", `/media/${t.photo}/archive`)).status).toBe(401);
  });
});

describe("POST /media/:id/unarchive", () => {
  it("shows it to everyone again", async () => {
    const t = await revealedTrip();
    await archive(t.fede.token, t.photo);
    expect((await unarchive(t.fede.token, t.photo)).status).toBe(204);
    expect(await feedIds(t.tripId, t.juani.token)).toContain(t.photo);
    expect((await file(t.tripId, t.photo, "thumb", t.juani.token)).status).toBe(200);
    expect(await myLikeIds(t.juani.token)).toContain(t.photo);
    const own = (await feed(t.tripId, t.fede.token)).body.items.find((i: any) => i.id === t.photo);
    expect(own.archived).toBe(false);
  });

  it("is idempotent and author-only", async () => {
    const t = await revealedTrip();
    expect((await unarchive(t.fede.token, t.photo)).status).toBe(204);
    await archive(t.fede.token, t.photo);
    expect((await unarchive(t.juani.token, t.photo)).status).toBe(403);
    expect(await feedIds(t.tripId, t.juani.token)).not.toContain(t.photo);
  });
});

describe("archiving a daily moment", () => {
  it("archiving the main photo hides its linked image too", async () => {
    const t = await revealedMoment();
    expect((await archive(t.fede.token, t.mainId)).status).toBe(204);
    expect(await feedIds(t.tripId, t.adminToken)).not.toContain(t.mainId);
    expect((await file(t.tripId, t.linkedId, "thumb", t.adminToken)).status).toBe(404);
    const own = (await feed(t.tripId, t.fede.token)).body.items.find((i: any) => i.id === t.mainId);
    expect(own).toMatchObject({ archived: true, selfie: { id: t.linkedId } });

    expect((await unarchive(t.fede.token, t.mainId)).status).toBe(204);
    expect((await file(t.tripId, t.linkedId, "thumb", t.adminToken)).status).toBe(200);
  });

  it("archiving, unarchiving or deleting the linked image directly is 400", async () => {
    const t = await revealedMoment();
    expect((await archive(t.fede.token, t.linkedId)).status).toBe(400);
    expect((await unarchive(t.fede.token, t.linkedId)).status).toBe(400);
    expect((await remove(t.fede.token, t.linkedId)).status).toBe(400);
  });

  it("deleting the main photo deletes its linked image", async () => {
    const t = await revealedMoment();
    expect((await remove(t.fede.token, t.mainId)).status).toBe(204);
    expect((await file(t.tripId, t.linkedId, "thumb", t.fede.token)).status).toBe(404);
    const row = await env.DB.prepare("SELECT deleted_at FROM media WHERE id = ?").bind(t.linkedId).first<{ deleted_at: number | null }>();
    expect(row!.deleted_at).not.toBeNull();
  });
});

describe("DELETE /media/:id by the author (after the reveal)", () => {
  it("deletes it for everyone, with its files, likes, comments and featured rows", async () => {
    const t = await revealedTrip();
    expect((await remove(t.fede.token, t.photo)).status).toBe(204);

    for (const token of [t.juani.token, t.fede.token, t.cami.token]) expect(await feedIds(t.tripId, token)).not.toContain(t.photo);
    expect(await env.MEDIA.head(`trips/${t.tripId}/${t.photo}/original.jpg`)).toBeNull();
    expect(await env.MEDIA.head(`trips/${t.tripId}/${t.photo}/thumb.jpg`)).toBeNull();
    const count = async (sql: string) => (await env.DB.prepare(sql).bind(t.photo).first<{ n: number }>())!.n;
    expect(await count("SELECT COUNT(*) AS n FROM likes WHERE media_id = ?")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM featured WHERE media_id = ?")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM comments WHERE media_id = ? AND deleted_at IS NULL")).toBe(0);
    expect(await myLikeIds(t.juani.token)).not.toContain(t.photo);
  });

  it("works on an archived photo too", async () => {
    const t = await revealedTrip();
    await archive(t.fede.token, t.photo);
    expect((await remove(t.fede.token, t.photo)).status).toBe(204);
    expect(await feedIds(t.tripId, t.fede.token)).not.toContain(t.photo);
  });

  it("deleting twice is 404", async () => {
    const t = await revealedTrip();
    expect((await remove(t.fede.token, t.photo)).status).toBe(204);
    expect((await remove(t.fede.token, t.photo)).status).toBe(404);
  });

  it("another member can't (403), not even the admin once revealed (409)", async () => {
    const t = await revealedTrip();
    expect((await remove(t.cami.token, t.photo)).status).toBe(403);
    expect((await remove(t.juani.token, t.photo)).status).toBe(409);
    expect(await feedIds(t.tripId, t.cami.token)).toContain(t.photo);
  });

  it("the admin can delete their own photo once revealed", async () => {
    const t = await revealedTrip();
    expect((await remove(t.juani.token, t.juaniPhoto)).status).toBe(204);
  });

  it("before the reveal the author who is not admin still can't (403)", async () => {
    const trip = await newTrip();
    const fede = await joinAs(trip.code, "Fede");
    const id = await uploadMedia(trip.tripId, fede.token);
    expect((await remove(fede.token, id)).status).toBe(403);
  });

  it("friends of the author don't see it on the profile either", async () => {
    const t = await revealedTrip();
    await befriend(t.fede.token, t.cami.token);
    await remove(t.fede.token, t.photo);
    expect(await featuredIds(t.cami.token, t.fede.userId)).not.toContain(t.photo);
  });
});

describe("the author's videos (old rollos still have them)", () => {
  it("archiving hides it from everyone but the author, in the feed, downloads and totals; unarchiving restores it", async () => {
    const t = await revealedTrip();
    const before = (await api("GET", `/trips/${t.tripId}`, { token: t.juani.token })).body.totalUploaded;
    expect((await archive(t.fede.token, t.video)).status).toBe(204);
    expect((await archive(t.fede.token, t.video)).status).toBe(204);

    expect(await feedIds(t.tripId, t.juani.token)).not.toContain(t.video);
    expect(await feedIds(t.tripId, t.cami.token)).not.toContain(t.video);
    const own = (await feed(t.tripId, t.fede.token)).body.items;
    expect(own.find((i: any) => i.id === t.video)).toMatchObject({ archived: true, type: "video" });
    for (const variant of ["thumb", "original"]) {
      expect((await file(t.tripId, t.video, variant, t.juani.token)).status).toBe(404);
      expect((await file(t.tripId, t.video, variant, t.fede.token)).status).toBe(200);
    }
    expect((await api("GET", `/trips/${t.tripId}`, { token: t.juani.token })).body.totalUploaded).toBe(before - 1);
    expect((await api("GET", `/trips/${t.tripId}`, { token: t.fede.token })).body.totalUploaded).toBe(before);

    expect((await unarchive(t.fede.token, t.video)).status).toBe(204);
    expect(await feedIds(t.tripId, t.juani.token)).toContain(t.video);
    expect((await file(t.tripId, t.video, "original", t.juani.token)).status).toBe(200);
  });

  it("only the author: another member 403, even the admin", async () => {
    const t = await revealedTrip();
    for (const token of [t.cami.token, t.juani.token]) {
      expect((await archive(token, t.video)).status).toBe(403);
      expect((await unarchive(token, t.video)).status).toBe(403);
      expect((await remove(token, t.video)).status).toBe(token === t.juani.token ? 409 : 403);
    }
    expect(await feedIds(t.tripId, t.cami.token)).toContain(t.video);
  });

  it("deleting removes it for everyone and deletes its files", async () => {
    const t = await revealedTrip();
    expect((await remove(t.fede.token, t.video)).status).toBe(204);
    for (const token of [t.juani.token, t.fede.token, t.cami.token]) expect(await feedIds(t.tripId, token)).not.toContain(t.video);
    const row = await env.DB.prepare("SELECT original_key, thumb_key, deleted_at FROM media WHERE id = ?").bind(t.video).first<any>();
    expect(row.deleted_at).not.toBeNull();
    expect(await env.MEDIA.head(row.original_key)).toBeNull();
    expect(await env.MEDIA.head(row.thumb_key)).toBeNull();
    expect((await remove(t.fede.token, t.video)).status).toBe(404);
  });

  it("works on an archived video too", async () => {
    const t = await revealedTrip();
    await archive(t.fede.token, t.video);
    expect((await remove(t.fede.token, t.video)).status).toBe(204);
  });
});
