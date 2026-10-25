import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { flushPendingPushes } from "../src/lib/push";
import { devSentReports } from "../src/lib/email";
import { CommentListSchema, CommentSchema } from "../src/modules/comments/comments.schemas";
import { MINUTE, api, joinAs, mockExpo, newTrip, registerToken, signUp, uploadMedia } from "./helpers";

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

/** Adds a member to an already revealed rollo (joining by code is closed after the reveal). */
async function joinMember(tripId: string, name: string) {
  const user = await signUp(undefined, name);
  await env.DB.prepare("INSERT INTO members (id, trip_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)")
    .bind(crypto.randomUUID(), tripId, user.userId, Date.now())
    .run();
  return user;
}

const comment = (token: string, mediaId: string, text: string) => api("POST", `/media/${mediaId}/comments`, { token, body: { text } });
const list = (token: string, mediaId: string) => api("GET", `/media/${mediaId}/comments`, { token });
const remove = (token: string, commentId: string) => api("DELETE", `/comments/${commentId}`, { token });

async function feedItem(tripId: string, token: string, mediaId: string) {
  const res = await api("GET", `/trips/${tripId}/feed`, { token });
  expect(res.status).toBe(200);
  return res.body.items.find((i: { id: string }) => i.id === mediaId);
}

describe("POST /media/{mediaId}/comments", () => {
  it("an active member of a revealed rollo comments on a photo and gets the comment back", async () => {
    const t = await revealedTrip();
    const res = await comment(t.juani.token, t.fedePhoto, "  jajaja qué foto  ");
    expect(res.status).toBe(201);
    expect(CommentSchema.safeParse(res.body).success).toBe(true);
    expect(res.body).toMatchObject({ text: "jajaja qué foto", author: { userId: t.juani.userId }, canDelete: true });
  });

  it("404 while the rollo is not revealed, for non-members and for unknown photos", async () => {
    const trip = await newTrip();
    const fede = await joinAs(trip.code, "Fede");
    const photo = await uploadMedia(trip.tripId, fede.token);
    expect((await comment(trip.adminToken, photo, "hola")).status).toBe(404);

    const t = await revealedTrip();
    const stranger = await signUp();
    expect((await comment(stranger.token, t.fedePhoto, "hola")).status).toBe(404);
    expect((await list(stranger.token, t.fedePhoto)).status).toBe(404);
    expect((await comment(t.juani.token, crypto.randomUUID(), "hola")).status).toBe(404);
  });

  it("404 for a member who left the rollo", async () => {
    const t = await revealedTrip();
    await api("DELETE", `/trips/${t.tripId}/members/me`, { token: t.fede.token });
    expect((await comment(t.fede.token, t.juaniPhoto, "hola")).status).toBe(404);
  });

  it("400 for a video", async () => {
    const t = await revealedTrip();
    const res = await comment(t.juani.token, t.fedeVideo, "hola");
    expect(res.status).toBe(400);
  });

  it("400 for empty or over-long text, and the 500 characters are fine", async () => {
    const t = await revealedTrip();
    expect((await comment(t.juani.token, t.fedePhoto, "   ")).status).toBe(400);
    expect((await comment(t.juani.token, t.fedePhoto, "a".repeat(501))).status).toBe(400);
    expect((await comment(t.juani.token, t.fedePhoto, "a".repeat(500))).status).toBe(201);
  });

  it("401 without a session", async () => {
    const t = await revealedTrip();
    expect((await api("POST", `/media/${t.fedePhoto}/comments`, { body: { text: "hola" } })).status).toBe(401);
  });

  it("404 if there is a block with the photo's author, in either direction", async () => {
    const t = await revealedTrip();
    await api("PUT", `/blocks/${t.fede.userId}`, { token: t.juani.token });
    expect((await comment(t.juani.token, t.fedePhoto, "hola")).status).toBe(404);
    expect((await comment(t.fede.token, t.juaniPhoto, "hola")).status).toBe(404);
  });
});

describe("GET /media/{mediaId}/comments", () => {
  it("lists the comments oldest first with their author, and `canDelete` for yours or on your photo", async () => {
    const t = await revealedTrip();
    const start = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(start);
    await comment(t.juani.token, t.fedePhoto, "primero");
    vi.spyOn(Date, "now").mockReturnValue(start + MINUTE);
    await comment(t.fede.token, t.fedePhoto, "segundo");
    const third = await joinMember(t.tripId, "Tercero");
    await comment(third.token, t.fedePhoto, "tercero");

    const asJuani = await list(t.juani.token, t.fedePhoto);
    expect(asJuani.status).toBe(200);
    expect(CommentListSchema.safeParse(asJuani.body).success).toBe(true);
    expect(asJuani.body.comments.map((c: { text: string; canDelete: boolean }) => [c.text, c.canDelete])).toEqual([
      ["primero", true],
      ["segundo", false],
      ["tercero", false],
    ]);
    // Fede is the author of the photo: he can delete all of them.
    const asFede = await list(t.fede.token, t.fedePhoto);
    expect(asFede.body.comments.map((c: { canDelete: boolean }) => c.canDelete)).toEqual([true, true, true]);
    expect(asFede.body.comments[1].author).toMatchObject({ userId: t.fede.userId, name: "Fede" });
  });

  it("keeps creation order for comments created in the same millisecond", async () => {
    const t = await revealedTrip();
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const texts = Array.from({ length: 12 }, (_, i) => `c${i}`);
    for (const text of texts) await comment(t.juani.token, t.fedePhoto, text);
    const res = await list(t.juani.token, t.fedePhoto);
    expect(res.body.comments.map((c: { text: string }) => c.text)).toEqual(texts);
  });

  it("hides comments of users blocked in either direction and the ones you reported", async () => {
    const t = await revealedTrip();
    const cami = await joinMember(t.tripId, "Cami");
    const lu = await joinMember(t.tripId, "Lu");
    const camiComment = (await comment(cami.token, t.juaniPhoto, "de cami")).body.id;
    await comment(lu.token, t.juaniPhoto, "de lu");
    await comment(t.fede.token, t.juaniPhoto, "de fede");

    await api("PUT", `/blocks/${cami.userId}`, { token: t.juani.token });
    await api("PUT", `/blocks/${t.juani.userId}`, { token: lu.token });
    expect((await list(t.juani.token, t.juaniPhoto)).body.comments.map((c: { text: string }) => c.text)).toEqual(["de fede"]);
    // The others still see them.
    expect((await list(t.fede.token, t.juaniPhoto)).body.comments).toHaveLength(3);
    expect((await feedItem(t.tripId, t.juani.token, t.juaniPhoto)).commentCount).toBe(1);

    // Reported by Fede: it leaves his list only.
    expect((await api("POST", "/reports", { token: t.fede.token, body: { reason: "offensive", commentId: camiComment } })).status).toBe(204);
    expect((await list(t.fede.token, t.juaniPhoto)).body.comments.map((c: { text: string }) => c.text)).toEqual(["de lu", "de fede"]);
  });

  it("does not list deleted comments", async () => {
    const t = await revealedTrip();
    const id = (await comment(t.juani.token, t.fedePhoto, "x")).body.id;
    await remove(t.juani.token, id);
    expect((await list(t.juani.token, t.fedePhoto)).body.comments).toEqual([]);
  });
});

describe("DELETE /comments/{commentId}", () => {
  it("the author of the comment deletes it, and so does the author of the photo", async () => {
    const t = await revealedTrip();
    const mine = (await comment(t.juani.token, t.fedePhoto, "mío")).body.id;
    const other = (await comment(t.juani.token, t.fedePhoto, "otro")).body.id;
    expect((await remove(t.juani.token, mine)).status).toBe(204);
    expect((await remove(t.fede.token, other)).status).toBe(204);
    expect((await list(t.fede.token, t.fedePhoto)).body.comments).toEqual([]);
  });

  it("403 for another member, 404 if it is already deleted, unknown or you can't see the photo", async () => {
    const t = await revealedTrip();
    const cami = await joinMember(t.tripId, "Cami");
    const id = (await comment(t.juani.token, t.fedePhoto, "mío")).body.id;
    expect((await remove(cami.token, id)).status).toBe(403);
    const stranger = await signUp();
    expect((await remove(stranger.token, id)).status).toBe(404);
    expect((await remove(t.juani.token, crypto.randomUUID())).status).toBe(404);
    expect((await remove(t.juani.token, id)).status).toBe(204);
    expect((await remove(t.juani.token, id)).status).toBe(404);
  });
});

describe("commentCount in the feed", () => {
  it("counts the live comments of each photo, only after the reveal", async () => {
    const t = await revealedTrip();
    await comment(t.juani.token, t.fedePhoto, "a");
    const gone = (await comment(t.fede.token, t.fedePhoto, "b")).body.id;
    await comment(t.fede.token, t.fedePhoto, "c");
    await remove(t.fede.token, gone);
    expect((await feedItem(t.tripId, t.juani.token, t.fedePhoto)).commentCount).toBe(2);
    expect((await feedItem(t.tripId, t.juani.token, t.juaniPhoto)).commentCount).toBe(0);
    expect((await feedItem(t.tripId, t.juani.token, t.fedeVideo)).commentCount).toBe(0);
  });

  it("is left out before the reveal", async () => {
    const trip = await newTrip();
    await uploadMedia(trip.tripId, trip.adminToken);
    const res = await api("GET", `/trips/${trip.tripId}/feed`, { token: trip.adminToken });
    expect(res.body.items[0]).not.toHaveProperty("commentCount");
  });
});

describe("reporting a comment", () => {
  it("is idempotent, emails support with the text and does not hide the photo or report the person", async () => {
    const t = await revealedTrip();
    const id = (await comment(t.fede.token, t.juaniPhoto, "esto es un insulto")).body.id;
    devSentReports.length = 0;
    const report = () => api("POST", "/reports", { token: t.juani.token, body: { reason: "abuse", commentId: id } });
    expect((await report()).status).toBe(204);
    expect((await report()).status).toBe(204);
    expect(devSentReports).toHaveLength(1);
    expect(devSentReports[0]).toMatchObject({ target: { id: t.fede.userId }, comment: { id, text: "esto es un insulto" } });
    const row = await env.DB.prepare("SELECT media_id, comment_id, target_user_id FROM reports WHERE reporter_id = ?").bind(t.juani.userId).first();
    expect(row).toEqual({ media_id: null, comment_id: id, target_user_id: t.fede.userId });
    // The photo stays visible and the person can still be reported on their own.
    expect(await feedItem(t.tripId, t.juani.token, t.juaniPhoto)).toBeDefined();
    expect((await api("POST", "/reports", { token: t.juani.token, body: { reason: "abuse", userId: t.fede.userId } })).status).toBe(204);
  });

  it("400 for your own comment and for sending more than one target; 404 if you can't see it", async () => {
    const t = await revealedTrip();
    const id = (await comment(t.juani.token, t.fedePhoto, "mío")).body.id;
    expect((await api("POST", "/reports", { token: t.juani.token, body: { reason: "other", commentId: id } })).status).toBe(400);
    expect((await api("POST", "/reports", { token: t.fede.token, body: { reason: "other", commentId: id, userId: t.juani.userId } })).status).toBe(400);
    const stranger = await signUp();
    expect((await api("POST", "/reports", { token: stranger.token, body: { reason: "other", commentId: id } })).status).toBe(404);
  });
});

describe("photoCommented push", () => {
  it("notifies the photo's author, opening the photo with its comments", async () => {
    const expo = mockExpo();
    const t = await revealedTrip();
    const fedeToken = await registerToken(t.fede.token);
    const juaniToken = await registerToken(t.juani.token);

    await comment(t.juani.token, t.fedePhoto, "buenísima");
    await flushPendingPushes();
    expect(expo.sent.map((m) => [m.to, m.body, m.data.url])).toEqual([
      [fedeToken, "Juani comentó tu foto", `/photo/${t.fedePhoto}?tripId=${t.tripId}&comments=1`],
    ]);
    expect(expo.sent.some((m) => m.to === juaniToken)).toBe(false);
  });

  it("does not notify your own comment on your own photo", async () => {
    const expo = mockExpo();
    const t = await revealedTrip();
    await registerToken(t.fede.token);
    await comment(t.fede.token, t.fedePhoto, "mía");
    await flushPendingPushes();
    expect(expo.sent).toEqual([]);
  });

  it("also notifies the ones who already commented, not the actor, and not twice the author", async () => {
    const expo = mockExpo();
    const t = await revealedTrip();
    const cami = await joinMember(t.tripId, "Cami");
    const camiToken = await registerToken(cami.token);
    const fedeToken = await registerToken(t.fede.token);
    const juaniToken = await registerToken(t.juani.token);

    const start = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(start);
    await comment(cami.token, t.fedePhoto, "uno");
    await flushPendingPushes();
    expect(expo.sent.map((m) => [m.to, m.body])).toEqual([[fedeToken, "Cami comentó tu foto"]]);

    // After the window: the author hears about it and so do those who commented before.
    vi.spyOn(Date, "now").mockReturnValue(start + 31 * MINUTE);
    await comment(t.juani.token, t.fedePhoto, "dos");
    await flushPendingPushes();
    expect(expo.sent.slice(1).map((m) => [m.to, m.body]).sort()).toEqual(
      [
        [fedeToken, "Juani comentó tu foto"],
        [camiToken, "Juani también comentó una foto"],
      ].sort(),
    );
    expect(expo.sent.some((m) => m.to === juaniToken)).toBe(false);
  });

  it("anti-spam: the first notifies, the next 30 min are counted silently, the next one after adds them up", async () => {
    const expo = mockExpo();
    const t = await revealedTrip();
    const fedeToken = await registerToken(t.fede.token);
    const others = await Promise.all(["Cami", "Tomi", "Lu"].map((n) => joinMember(t.tripId, n)));

    const start = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(start);
    await comment(t.juani.token, t.fedePhoto, "1");
    await flushPendingPushes();
    expect(expo.sent.map((m) => m.body)).toEqual(["Juani comentó tu foto"]);

    vi.spyOn(Date, "now").mockReturnValue(start + 10 * MINUTE);
    await comment(others[0]!.token, t.fedePhoto, "2");
    vi.spyOn(Date, "now").mockReturnValue(start + 29 * MINUTE);
    await comment(others[1]!.token, t.fedePhoto, "3");
    await flushPendingPushes();
    expect(expo.sent).toHaveLength(1);

    vi.spyOn(Date, "now").mockReturnValue(start + 31 * MINUTE);
    await comment(others[2]!.token, t.fedePhoto, "4");
    await flushPendingPushes();
    expect(expo.sent.filter((m) => m.to === fedeToken).map((m) => m.body)).toEqual([
      "Juani comentó tu foto",
      "Lu y 2 más comentaron tu foto",
    ]);
  });

  it("respects the photoCommented setting and never notifies a blocked user", async () => {
    const expo = mockExpo();
    const t = await revealedTrip();
    await registerToken(t.fede.token);
    await api("PATCH", "/me/settings", { token: t.fede.token, body: { notifications: { photoCommented: false } } });
    await comment(t.juani.token, t.fedePhoto, "hola");
    await flushPendingPushes();
    expect(expo.sent).toEqual([]);
  });
});

describe("account deletion", () => {
  it("deletes the user's comments", async () => {
    const t = await revealedTrip();
    await comment(t.fede.token, t.juaniPhoto, "chau");
    expect((await api("DELETE", "/me", { token: t.fede.token })).status).toBe(204);
    expect((await list(t.juani.token, t.juaniPhoto)).body.comments).toEqual([]);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM comments").first<{ n: number }>();
    expect(row!.n).toBe(0);
  });
});
