import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { flushPendingPushes } from "../src/lib/push";
import { FeedResponseSchema } from "../src/modules/media/media.schemas";
import { FeaturedPhotosSchema } from "../src/modules/featured/featured.schemas";
import { MINUTE, api, befriend, joinAs, mockExpo, newTrip, registerToken, signUp, uploadMedia } from "./helpers";

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

const like = (token: string, mediaId: string) => api("PUT", `/media/${mediaId}/like`, { token });
const unlike = (token: string, mediaId: string) => api("DELETE", `/media/${mediaId}/like`, { token });

async function likeCount(mediaId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM likes WHERE media_id = ?").bind(mediaId).first<{ n: number }>();
  return row!.n;
}

async function feedItem(tripId: string, token: string, mediaId: string) {
  const res = await api("GET", `/trips/${tripId}/feed`, { token });
  expect(res.status).toBe(200);
  return res.body.items.find((i: { id: string }) => i.id === mediaId);
}

/** Juani features Fede's photo on her profile (private by default). */
async function featuredByJuani() {
  const t = await revealedTrip();
  await befriend(t.juani.token, t.fede.token);
  expect((await api("PUT", `/me/featured/${t.fedePhoto}`, { token: t.juani.token })).status).toBe(204);
  await flushPendingPushes();
  return t;
}

describe("PUT /media/{mediaId}/like — who can like", () => {
  it("an active member of a revealed rollo, idempotently, with one counter per photo", async () => {
    const t = await revealedTrip();
    expect((await like(t.juani.token, t.fedePhoto)).status).toBe(204);
    expect((await like(t.juani.token, t.fedePhoto)).status).toBe(204);
    expect(await likeCount(t.fedePhoto)).toBe(1);
    // The author can like their own photo too.
    expect((await like(t.fede.token, t.fedePhoto)).status).toBe(204);
    expect(await likeCount(t.fedePhoto)).toBe(2);
  });

  it("404 while the rollo is not revealed", async () => {
    const trip = await newTrip();
    const fede = await joinAs(trip.code, "Fede");
    const photo = await uploadMedia(trip.tripId, fede.token);
    expect((await like(trip.adminToken, photo)).status).toBe(404);
    expect(await likeCount(photo)).toBe(0);
  });

  it("404 for someone who is not a member, left or was removed", async () => {
    const t = await revealedTrip();
    const stranger = await signUp();
    expect((await like(stranger.token, t.fedePhoto)).status).toBe(404);
    const res = await api("DELETE", `/trips/${t.tripId}/members/me`, { token: t.fede.token });
    expect(res.status).toBe(204);
    expect((await like(t.fede.token, t.juaniPhoto)).status).toBe(404);
  });

  it("404 for a photo that does not exist or was deleted", async () => {
    const t = await revealedTrip();
    expect((await like(t.juani.token, crypto.randomUUID())).status).toBe(404);
    await env.DB.prepare("UPDATE media SET deleted_at = ? WHERE id = ?").bind(Date.now(), t.fedePhoto).run();
    expect((await like(t.juani.token, t.fedePhoto)).status).toBe(404);
  });

  it("400 for a video a member can see", async () => {
    const t = await revealedTrip();
    const res = await like(t.juani.token, t.fedeVideo);
    expect(res.status).toBe(400);
    expect(await likeCount(t.fedeVideo)).toBe(0);
  });

  it("404 if there is a block with the author, in either direction", async () => {
    const t = await revealedTrip();
    expect((await api("PUT", `/blocks/${t.juani.userId}`, { token: t.fede.token })).status).toBe(204);
    expect((await like(t.juani.token, t.fedePhoto)).status).toBe(404);
    expect((await like(t.fede.token, t.juaniPhoto)).status).toBe(404);
  });

  it("someone who can see a profile where the photo is featured (friend of a private profile)", async () => {
    const t = await featuredByJuani();
    const friend = await signUp(undefined, "Cami");
    expect((await like(friend.token, t.fedePhoto)).status).toBe(404);
    await befriend(t.juani.token, friend.token);
    expect((await like(friend.token, t.fedePhoto)).status).toBe(204);
    expect(await likeCount(t.fedePhoto)).toBe(1);
    // Only photos that are featured: Juani's own photo is not, so it stays hidden.
    expect((await like(friend.token, t.juaniPhoto)).status).toBe(404);
  });

  it("anyone signed in when the profile featuring it is public", async () => {
    const t = await featuredByJuani();
    const stranger = await signUp();
    expect((await like(stranger.token, t.fedePhoto)).status).toBe(404);
    expect((await api("PATCH", "/me", { token: t.juani.token, body: { profileVisibility: "public" } })).status).toBe(200);
    expect((await like(stranger.token, t.fedePhoto)).status).toBe(204);
  });

  it("404 once the photo is no longer featured (unfeatured, feature-blocked or the owner left)", async () => {
    const t = await featuredByJuani();
    await api("PATCH", "/me", { token: t.juani.token, body: { profileVisibility: "public" } });
    const stranger = await signUp();

    await api("DELETE", `/me/featured/${t.fedePhoto}`, { token: t.juani.token });
    expect((await like(stranger.token, t.fedePhoto)).status).toBe(404);

    await api("PUT", `/me/featured/${t.fedePhoto}`, { token: t.juani.token });
    await api("PUT", `/media/${t.fedePhoto}/feature-block`, { token: t.fede.token });
    expect((await like(stranger.token, t.fedePhoto)).status).toBe(404);

    // Fede features Juani's photo on his public profile, then leaves the rollo (the admin can't leave).
    await api("DELETE", `/media/${t.fedePhoto}/feature-block`, { token: t.fede.token });
    await befriend(t.juani.token, t.fede.token);
    expect((await api("PUT", `/me/featured/${t.juaniPhoto}`, { token: t.fede.token })).status).toBe(204);
    await api("PATCH", "/me", { token: t.fede.token, body: { profileVisibility: "public" } });
    expect((await like(stranger.token, t.juaniPhoto)).status).toBe(204);
    await api("DELETE", `/trips/${t.tripId}/members/me`, { token: t.fede.token });
    await unlike(stranger.token, t.juaniPhoto);
    expect((await like(stranger.token, t.juaniPhoto)).status).toBe(404);
  });

  it("404 through a profile if the viewer blocked the author, even when the profile is public", async () => {
    const t = await featuredByJuani();
    await api("PATCH", "/me", { token: t.juani.token, body: { profileVisibility: "public" } });
    const stranger = await signUp();
    expect((await api("PUT", `/blocks/${t.fede.userId}`, { token: stranger.token })).status).toBe(204);
    expect((await like(stranger.token, t.fedePhoto)).status).toBe(404);
  });

  it("401 without a session", async () => {
    const t = await revealedTrip();
    expect((await api("PUT", `/media/${t.fedePhoto}/like`)).status).toBe(401);
  });
});

describe("DELETE /media/{mediaId}/like", () => {
  it("removes your like, idempotently, and never someone else's", async () => {
    const t = await revealedTrip();
    await like(t.juani.token, t.fedePhoto);
    await like(t.fede.token, t.fedePhoto);
    expect((await unlike(t.juani.token, t.fedePhoto)).status).toBe(204);
    expect((await unlike(t.juani.token, t.fedePhoto)).status).toBe(204);
    expect(await likeCount(t.fedePhoto)).toBe(1);
  });

  it("204 also for a photo you can't see (reveals nothing)", async () => {
    const stranger = await signUp();
    expect((await unlike(stranger.token, crypto.randomUUID())).status).toBe(204);
  });
});

describe("likeCount / likedByMe", () => {
  it("come in the revealed feed", async () => {
    const t = await revealedTrip();
    await like(t.juani.token, t.fedePhoto);
    await like(t.fede.token, t.fedePhoto);

    const mine = await feedItem(t.tripId, t.juani.token, t.fedePhoto);
    expect(mine).toMatchObject({ likeCount: 2, likedByMe: true });
    const other = await feedItem(t.tripId, t.juani.token, t.juaniPhoto);
    expect(other).toMatchObject({ likeCount: 0, likedByMe: false });

    await unlike(t.juani.token, t.fedePhoto);
    expect(await feedItem(t.tripId, t.juani.token, t.fedePhoto)).toMatchObject({ likeCount: 1, likedByMe: false });
    expect(await feedItem(t.tripId, t.fede.token, t.fedePhoto)).toMatchObject({ likeCount: 1, likedByMe: true });

    const res = await api("GET", `/trips/${t.tripId}/feed`, { token: t.juani.token });
    expect(FeedResponseSchema.safeParse(res.body).success).toBe(true);
  });

  it("are not in the feed before the reveal", async () => {
    const trip = await newTrip();
    const photo = await uploadMedia(trip.tripId, trip.adminToken);
    const item = await feedItem(trip.tripId, trip.adminToken, photo);
    expect(item).not.toHaveProperty("likeCount");
    expect(item).not.toHaveProperty("likedByMe");
  });

  it("come in a profile's featured photos (one counter with the rollo's likes)", async () => {
    const t = await featuredByJuani();
    const friend = await signUp(undefined, "Cami");
    await befriend(t.juani.token, friend.token);
    await like(t.fede.token, t.fedePhoto); // from the rollo
    await like(friend.token, t.fedePhoto); // from the profile

    const res = await api("GET", `/users/${t.juani.userId}/featured`, { token: friend.token });
    expect(res.status).toBe(200);
    expect(FeaturedPhotosSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.photos).toEqual([expect.objectContaining({ mediaId: t.fedePhoto, likeCount: 2, likedByMe: true })]);

    const own = await api("GET", `/users/${t.juani.userId}/featured`, { token: t.juani.token });
    expect(own.body.photos[0]).toMatchObject({ likeCount: 2, likedByMe: false });
    expect(await feedItem(t.tripId, t.juani.token, t.fedePhoto)).toMatchObject({ likeCount: 2 });
  });
});

describe("photoLiked push", () => {
  it("notifies the author with the name of who liked it, opening the photo in its rollo", async () => {
    const expo = mockExpo();
    const t = await revealedTrip();
    const fedeToken = await registerToken(t.fede.token);
    const juaniToken = await registerToken(t.juani.token);

    await like(t.juani.token, t.fedePhoto);
    await flushPendingPushes();
    expect(expo.sent.map((m) => [m.to, m.body, m.data.url])).toEqual([
      [fedeToken, "A Juani le gustó tu foto", `/photo/${t.fedePhoto}?tripId=${t.tripId}`],
    ]);
    expect(expo.sent.some((m) => m.to === juaniToken)).toBe(false);
  });

  it("does not notify your own likes, a repeated like or an unlike", async () => {
    const expo = mockExpo();
    const t = await revealedTrip();
    await registerToken(t.fede.token);
    await like(t.fede.token, t.fedePhoto);
    await flushPendingPushes();
    expect(expo.sent).toEqual([]);

    await like(t.juani.token, t.fedePhoto);
    await flushPendingPushes();
    expect(expo.sent).toHaveLength(1);
    await like(t.juani.token, t.fedePhoto);
    await unlike(t.juani.token, t.fedePhoto);
    await flushPendingPushes();
    expect(expo.sent).toHaveLength(1);
  });

  it("anti-spam: the first notifies, the next 30 min are counted silently, the next one after adds them up", async () => {
    const expo = mockExpo();
    const t = await revealedTrip();
    const fedeToken = await registerToken(t.fede.token);
    const others = await Promise.all(["Cami", "Tomi", "Lu", "Nacho"].map((n) => joinMember(t.tripId, n)));

    const start = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(start);
    await like(t.juani.token, t.fedePhoto);
    await flushPendingPushes();
    expect(expo.sent.map((m) => m.body)).toEqual(["A Juani le gustó tu foto"]);

    // Within the window: counted, silent.
    vi.spyOn(Date, "now").mockReturnValue(start + 10 * MINUTE);
    await like(others[0]!.token, t.fedePhoto);
    vi.spyOn(Date, "now").mockReturnValue(start + 29 * MINUTE);
    await like(others[1]!.token, t.fedePhoto);
    await like(others[2]!.token, t.fedePhoto);
    await flushPendingPushes();
    expect(expo.sent).toHaveLength(1);

    // After the window: notifies with the silenced ones and opens a new window.
    vi.spyOn(Date, "now").mockReturnValue(start + 31 * MINUTE);
    await like(others[3]!.token, t.fedePhoto);
    await flushPendingPushes();
    expect(expo.sent.map((m) => [m.to, m.body])).toEqual([
      [fedeToken, "A Juani le gustó tu foto"],
      [fedeToken, "A Nacho y 3 más les gustó tu foto"],
    ]);

    // The window restarted: silent again.
    vi.spyOn(Date, "now").mockReturnValue(start + 40 * MINUTE);
    await unlike(t.juani.token, t.fedePhoto);
    await like(t.juani.token, t.fedePhoto);
    await flushPendingPushes();
    expect(expo.sent).toHaveLength(2);
  });

  it("the window is per photo", async () => {
    const expo = mockExpo();
    const t = await revealedTrip();
    await registerToken(t.fede.token);
    const second = await uploadMediaRevealed(t.tripId, t.fede.memberId);
    await like(t.juani.token, t.fedePhoto);
    await like(t.juani.token, second);
    await flushPendingPushes();
    expect(expo.sent).toHaveLength(2);
  });

  it("respects the author's photoLiked setting and blocks are 404 anyway", async () => {
    const expo = mockExpo();
    const t = await revealedTrip();
    await registerToken(t.fede.token);
    expect((await api("PATCH", "/me/settings", { token: t.fede.token, body: { notifications: { photoLiked: false } } })).status).toBe(200);
    await like(t.juani.token, t.fedePhoto);
    await flushPendingPushes();
    expect(expo.sent).toEqual([]);
  });

  it("a failing Expo never breaks the like", async () => {
    const t = await revealedTrip();
    await registerToken(t.fede.token);
    mockExpo({ fail: true });
    expect((await like(t.juani.token, t.fedePhoto)).status).toBe(204);
    await flushPendingPushes();
    expect(await likeCount(t.fedePhoto)).toBe(1);
  });
});

// ---------- helpers ----------

/** Joins a revealed trip through D1 (joining by code after the reveal may not be allowed). */
async function joinMember(tripId: string, name: string) {
  const user = await signUp(undefined, name);
  await env.DB.prepare(
    "INSERT INTO members (id, trip_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)",
  )
    .bind(crypto.randomUUID(), tripId, user.userId, Date.now())
    .run();
  return user;
}

/** Inserts another uploaded photo of a member straight into D1 (the rollo is already revealed). */
async function uploadMediaRevealed(tripId: string, memberId: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO media (id, trip_id, member_id, type, taken_at, local_date, original_key, thumb_key, status, created_at)
     VALUES (?, ?, ?, 'photo', ?, '2027-01-12', ?, ?, 'uploaded', ?)`,
  )
    .bind(id, tripId, memberId, Date.now(), `trips/${tripId}/${id}/original.jpg`, `trips/${tripId}/${id}/thumb.jpg`, Date.now())
    .run();
  return id;
}
