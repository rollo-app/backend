import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { flushPendingPushes } from "../src/lib/push";
import { localDate } from "../src/lib/util";
import { DAY, MINUTE, TZ, api, joinAs, mockExpo, newTrip, registerToken, signUp, uploadMedia } from "./helpers";

/** A rollo (not revealed) where the admin posted a moment (main + linked image) and an ordinary photo; Fede and Lu are members. */
async function fixture() {
  const fx = await newTrip({ momentMode: "photo_selfie", startsAt: Date.now() - 5 * DAY });
  const fede = await joinAs(fx.code, "Fede");
  const lu = await joinAs(fx.code, "Lu");
  const notifyAt = Date.now() - 2 * MINUTE;
  const day = localDate(notifyAt, TZ);
  await env.DB.prepare("INSERT INTO trip_moments (trip_id, user_id, day, notify_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(fx.tripId, fx.adminUserId, day, notifyAt, Date.now())
    .run();
  const mainId = await uploadMedia(fx.tripId, fx.adminToken, { momentDay: day, takenAt: notifyAt + MINUTE });
  const selfieId = await uploadMedia(fx.tripId, fx.adminToken, { pairedMediaId: mainId });
  const plainId = await uploadMedia(fx.tripId, fx.adminToken);
  return { ...fx, fede, lu, mainId, selfieId, plainId };
}

const comment = (token: string, mediaId: string, text: string) => api("POST", `/media/${mediaId}/comments`, { token, body: { text } });
const list = (token: string, mediaId: string) => api("GET", `/media/${mediaId}/comments`, { token });

describe("comments on a moment before the reveal", () => {
  it("members list, create and delete comments on the main photo", async () => {
    const fx = await fixture();
    const created = await comment(fx.fede.token, fx.mainId, "qué buena");
    expect(created.status).toBe(201);
    expect((await list(fx.lu.token, fx.mainId)).body.comments.map((c: any) => c.text)).toEqual(["qué buena"]);
    // The photo's author can delete someone else's comment; another member cannot.
    expect((await api("DELETE", `/comments/${created.body.id}`, { token: fx.lu.token })).status).toBe(403);
    expect((await api("DELETE", `/comments/${created.body.id}`, { token: fx.adminToken })).status).toBe(204);
    expect((await list(fx.lu.token, fx.mainId)).body.comments).toEqual([]);
  });

  it("a member reports a comment", async () => {
    const fx = await fixture();
    const id = (await comment(fx.fede.token, fx.mainId, "insulto")).body.id;
    const res = await api("POST", "/reports", { token: fx.lu.token, body: { reason: "abuse", commentId: id } });
    expect(res.status).toBe(204);
    expect((await list(fx.lu.token, fx.mainId)).body.comments).toEqual([]);
  });

  it("a normal photo still gives 404 before the reveal", async () => {
    const fx = await fixture();
    expect((await comment(fx.fede.token, fx.plainId, "hola")).status).toBe(404);
    expect((await list(fx.fede.token, fx.plainId)).status).toBe(404);
  });

  it("the linked image is rejected with 400", async () => {
    const fx = await fixture();
    expect((await comment(fx.fede.token, fx.selfieId, "hola")).status).toBe(400);
  });

  it("non-members get 404", async () => {
    const fx = await fixture();
    const outsider = await signUp(undefined, "Tomi");
    expect((await comment(outsider.token, fx.mainId, "hola")).status).toBe(404);
    expect((await list(outsider.token, fx.mainId)).status).toBe(404);
  });

  it("an archived moment is hidden for others", async () => {
    const fx = await fixture();
    await env.DB.prepare("UPDATE media SET archived_at = ? WHERE id = ?").bind(Date.now(), fx.mainId).run();
    expect((await comment(fx.fede.token, fx.mainId, "hola")).status).toBe(404);
    expect((await comment(fx.adminToken, fx.mainId, "hola")).status).toBe(201);
  });

  it("the feed carries commentCount for the moment only, and no other reveal-only field", async () => {
    const fx = await fixture();
    await comment(fx.fede.token, fx.mainId, "uno");
    await comment(fx.lu.token, fx.mainId, "dos");
    const items = (await api("GET", `/trips/${fx.tripId}/feed`, { token: fx.fede.token })).body.items;
    const main = items.find((i: any) => i.id === fx.mainId);
    expect(main.commentCount).toBe(2);
    for (const k of ["likeCount", "likedByMe", "featuredByMe", "canFeature"]) expect(main).not.toHaveProperty(k);
    expect(items.find((i: any) => i.id === fx.plainId)).not.toHaveProperty("commentCount");
  });

  it("notifies the author with a link that opens the comments sheet", async () => {
    const expo = mockExpo();
    const fx = await fixture();
    const adminToken = await registerToken(fx.adminToken);
    await comment(fx.fede.token, fx.mainId, "buenísima");
    await flushPendingPushes();
    expect(expo.sent.map((m) => [m.to, m.body, m.data.url])).toEqual([
      [adminToken, "Fede comentó tu foto", `/photo/${fx.mainId}?tripId=${fx.tripId}&comments=1`],
    ]);
  });
});
