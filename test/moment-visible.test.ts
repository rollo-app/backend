import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { flushPendingPushes } from "../src/lib/push";
import { localDate } from "../src/lib/util";
import { DAY, MINUTE, TZ, api, joinAs, mockExpo, newTrip, originalContent, photoBody, putFiles, registerToken, signUp, thumbContent, uploadMedia } from "./helpers";

/** A rollo (not revealed) where the admin posted a moment (main + linked image) and an ordinary photo, and Fede is a member. */
async function fixture() {
  const fx = await newTrip({ momentMode: "photo_selfie", startsAt: Date.now() - 5 * DAY });
  const fede = await joinAs(fx.code, "Fede");
  const notifyAt = Date.now() - 2 * MINUTE;
  const day = localDate(notifyAt, TZ);
  await env.DB.prepare("INSERT INTO trip_moments (trip_id, user_id, day, notify_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(fx.tripId, fx.adminUserId, day, notifyAt, Date.now())
    .run();
  const mainId = await uploadMedia(fx.tripId, fx.adminToken, { momentDay: day, takenAt: notifyAt + MINUTE, thumbhash: "MAIN" });
  const selfieId = await uploadMedia(fx.tripId, fx.adminToken, { pairedMediaId: mainId, thumbhash: "SELF" });
  const plainId = await uploadMedia(fx.tripId, fx.adminToken);
  return { ...fx, fede, day, notifyAt, mainId, selfieId, plainId };
}

const feed = (tripId: string, token: string) => api("GET", `/trips/${tripId}/feed`, { token });
const media = (tripId: string, id: string, variant: string, token: string) => api("GET", `/trips/${tripId}/media/${id}/${variant}`, { token });
const paths = (tripId: string, id: string) => ({ thumb: `/trips/${tripId}/media/${id}/thumb`, original: `/trips/${tripId}/media/${id}/original` });

describe("moment files before the reveal", () => {
  it("an active member gets files and dimensions for the moment photo and its linked image; a normal photo stays metadata-only", async () => {
    const fx = await fixture();
    const res = await feed(fx.tripId, fx.fede.token);
    expect(res.body.revealed).toBe(false);
    const main = res.body.items.find((i: any) => i.id === fx.mainId);
    expect(main.files).toEqual(paths(fx.tripId, fx.mainId));
    expect(main.width).toBe(photoBody().width);
    expect(main.height).toBe(photoBody().height);
    expect(main.selfie).toMatchObject({ id: fx.selfieId, files: paths(fx.tripId, fx.selfieId), width: photoBody().width });
    const plain = res.body.items.find((i: any) => i.id === fx.plainId);
    expect(plain).not.toHaveProperty("files");
    expect(plain).not.toHaveProperty("width");
    // The reveal-only fields stay out until the reveal.
    for (const k of ["likeCount", "likedByMe", "commentCount", "featuredByMe", "canFeature"]) expect(main).not.toHaveProperty(k);
  });

  it("the files can be downloaded by id before the reveal; a normal photo cannot", async () => {
    const fx = await fixture();
    for (const id of [fx.mainId, fx.selfieId]) {
      for (const variant of ["thumb", "original"]) {
        const res = await media(fx.tripId, id, variant, fx.fede.token);
        expect(res.status).toBe(200);
      }
    }
    expect(await (await exportsFetch(fx.tripId, fx.mainId, "thumb", fx.fede.token)).text()).toBe(thumbContent(fx.mainId));
    expect(await (await exportsFetch(fx.tripId, fx.mainId, "original", fx.fede.token)).text()).toBe(originalContent(fx.mainId));
    for (const variant of ["thumb", "original"]) {
      expect((await media(fx.tripId, fx.plainId, variant, fx.fede.token)).status).toBe(403);
      expect((await media(fx.tripId, fx.plainId, variant, fx.adminToken)).status).toBe(403);
    }
  });

  it("a non-member cannot get a moment file, in the feed or by id", async () => {
    const fx = await fixture();
    const outsider = await signUp(undefined, "Tomi");
    expect((await feed(fx.tripId, outsider.token)).status).toBe(403);
    expect((await media(fx.tripId, fx.mainId, "thumb", outsider.token)).status).toBe(403);
    expect((await media(fx.tripId, fx.selfieId, "original", outsider.token)).status).toBe(403);
  });

  it("someone who left the rollo cannot get it either", async () => {
    const fx = await fixture();
    expect((await api("DELETE", `/trips/${fx.tripId}/members/me`, { token: fx.fede.token })).status).toBe(204);
    expect((await feed(fx.tripId, fx.fede.token)).status).toBe(403);
    expect((await media(fx.tripId, fx.mainId, "thumb", fx.fede.token)).status).toBe(403);
  });

  it("a moment's media is not served under another rollo's path", async () => {
    const fx = await fixture();
    const other = await newTrip();
    expect((await media(other.tripId, fx.mainId, "thumb", other.adminToken)).status).toBe(403);
  });

  it("an image that is not uploaded yet or was deleted is not served", async () => {
    const fx = await fixture();
    await env.DB.prepare("UPDATE media SET deleted_at = ? WHERE id = ?").bind(Date.now(), fx.selfieId).run();
    expect((await media(fx.tripId, fx.selfieId, "thumb", fx.fede.token)).status).toBe(403);
    const res = await feed(fx.tripId, fx.fede.token);
    expect(res.body.items.find((i: any) => i.id === fx.mainId).selfie ?? null).toBeNull();
  });

  it("blocks and reports apply as after the reveal: the feed hides them", async () => {
    const fx = await fixture();
    // The viewer who blocks the author no longer sees the moment.
    await api("PUT", `/blocks/${fx.adminUserId}`, { token: fx.fede.token });
    expect((await feed(fx.tripId, fx.fede.token)).body.items).toEqual([]);
    // Same semantics as after the reveal: the feed hides the author only from whoever blocked them.
    // A report hides the moment photo for the reporter only; a report on the linked image hides only that image.
    const lu = await joinAs(fx.code, "Lu");
    const rep = await api("POST", "/reports", { token: lu.token, body: { mediaId: fx.selfieId, reason: "offensive" } });
    expect(rep.status).toBe(204);
    const items = (await feed(fx.tripId, lu.token)).body.items;
    expect(items.find((i: any) => i.id === fx.mainId).selfie ?? null).toBeNull();
    const rep2 = await api("POST", "/reports", { token: lu.token, body: { mediaId: fx.mainId, reason: "offensive" } });
    expect(rep2.status).toBe(204);
    expect((await feed(fx.tripId, lu.token)).body.items.map((i: any) => i.id)).toEqual([fx.plainId]);
  });

  it("after the reveal everything works as before", async () => {
    const fx = await fixture();
    await api("POST", `/trips/${fx.tripId}/reveal`, { token: fx.adminToken });
    const res = await feed(fx.tripId, fx.fede.token);
    expect(res.body.items.find((i: any) => i.id === fx.plainId).files).toEqual(paths(fx.tripId, fx.plainId));
    expect((await media(fx.tripId, fx.plainId, "thumb", fx.fede.token)).status).toBe(200);
  });
});

async function exportsFetch(tripId: string, id: string, variant: string, token: string) {
  const { exports } = await import("cloudflare:workers");
  return exports.default.fetch(new Request(`http://localhost/trips/${tripId}/media/${id}/${variant}`, { headers: { authorization: `Bearer ${token}` } }));
}

describe("likes, comments and featuring on a moment before the reveal", () => {
  it("are rejected, for the main photo and the linked image", async () => {
    const fx = await fixture();
    const t = { token: fx.fede.token };
    for (const id of [fx.mainId, fx.selfieId]) {
      expect((await api("PUT", `/media/${id}/like`, t)).status).toBeGreaterThanOrEqual(400);
      expect((await api("POST", `/media/${id}/comments`, { ...t, body: { text: "hola" } })).status).toBeGreaterThanOrEqual(400);
      expect((await api("GET", `/media/${id}/comments`, t)).status).toBeGreaterThanOrEqual(400);
      expect((await api("PUT", `/me/featured/${id}`, t)).status).toBeGreaterThanOrEqual(400);
    }
    const author = { token: fx.adminToken };
    expect((await api("PUT", `/media/${fx.mainId}/like`, author)).status).toBeGreaterThanOrEqual(400);
    expect((await api("PUT", `/me/featured/${fx.mainId}`, author)).status).toBeGreaterThanOrEqual(400);
    const likes = await env.DB.prepare("SELECT COUNT(*) AS n FROM likes").first<{ n: number }>();
    const comments = await env.DB.prepare("SELECT COUNT(*) AS n FROM comments").first<{ n: number }>();
    expect([likes!.n, comments!.n]).toEqual([0, 0]);
  });

  it("are rejected on a normal photo too", async () => {
    const fx = await fixture();
    const t = { token: fx.fede.token };
    expect((await api("PUT", `/media/${fx.plainId}/like`, t)).status).toBeGreaterThanOrEqual(400);
    expect((await api("POST", `/media/${fx.plainId}/comments`, { ...t, body: { text: "hola" } })).status).toBeGreaterThanOrEqual(400);
    expect((await api("PUT", `/me/featured/${fx.plainId}`, t)).status).toBeGreaterThanOrEqual(400);
  });
});

// ---------- momentPosted push ----------

const sentTo = (expo: ReturnType<typeof mockExpo>) => expo.sent.map((m) => `${m.to}: ${m.title} / ${m.body} → ${m.data.url}`).sort();

async function pushFixture() {
  const expo = mockExpo();
  const fx = await newTrip({ momentMode: "photo_selfie", startsAt: Date.now() - 5 * DAY });
  const fede = await joinAs(fx.code, "Fede");
  const cami = await joinAs(fx.code, "Cami");
  const tokens = {
    admin: await registerToken(fx.adminToken),
    fede: await registerToken(fede.token),
    cami: await registerToken(cami.token),
  };
  const notifyAt = Date.now() - 2 * MINUTE;
  const day = localDate(notifyAt, TZ);
  await env.DB.prepare("INSERT INTO trip_moments (trip_id, user_id, day, notify_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(fx.tripId, fx.adminUserId, day, notifyAt, Date.now())
    .run();
  await flushPendingPushes();
  expo.sent.length = 0;
  const mainBody = photoBody({ momentDay: day, takenAt: notifyAt + MINUTE });
  const register = async () => {
    const reg = await api("POST", `/trips/${fx.tripId}/media`, { body: mainBody, token: fx.adminToken });
    await putFiles(fx.tripId, mainBody.id as string);
    return reg;
  };
  const complete = async () => {
    const res = await api("POST", `/media/${mainBody.id}/complete`, { token: fx.adminToken });
    await flushPendingPushes();
    return res;
  };
  return { expo, fx, fede, cami, tokens, day, notifyAt, mainId: mainBody.id as string, register, complete };
}

describe("momentPosted push", () => {
  it("is not sent on register, only on complete, to the other active members", async () => {
    const p = await pushFixture();
    expect((await p.register()).status).toBe(201);
    await flushPendingPushes();
    expect(p.expo.sent).toEqual([]);
    expect((await p.complete()).status).toBe(200);
    expect(sentTo(p.expo)).toEqual(
      [
        `${p.tokens.fede}: Juani subió su momento / Viaje al sur → /photo/${p.mainId}?tripId=${p.fx.tripId}`,
        `${p.tokens.cami}: Juani subió su momento / Viaje al sur → /photo/${p.mainId}?tripId=${p.fx.tripId}`,
      ].sort(),
    );
  });

  it("is sent once per moment: completing twice or retrying the registration does not send again", async () => {
    const p = await pushFixture();
    await p.register();
    await p.complete();
    expect(p.expo.sent).toHaveLength(2);
    await p.complete();
    await p.register();
    await p.complete();
    expect(p.expo.sent).toHaveLength(2);
  });

  it("concurrent completes send once", async () => {
    const p = await pushFixture();
    await p.register();
    await Promise.all([1, 2, 3].map(() => api("POST", `/media/${p.mainId}/complete`, { token: p.fx.adminToken })));
    await flushPendingPushes();
    expect(p.expo.sent).toHaveLength(2);
  });

  it("does not notify for the linked image, for a normal photo or in a rollo with the moment off", async () => {
    const p = await pushFixture();
    await p.register();
    await p.complete();
    p.expo.sent.length = 0;
    await uploadMedia(p.fx.tripId, p.fx.adminToken, { pairedMediaId: p.mainId });
    await uploadMedia(p.fx.tripId, p.fx.adminToken);
    await flushPendingPushes();
    expect(p.expo.sent).toEqual([]);
  });

  it("never goes to blocked users (either direction), to ex-members or to who turned momentPosted off", async () => {
    const p = await pushFixture();
    const lu = await joinAs(p.fx.code, "Lu");
    const tomi = await joinAs(p.fx.code, "Tomi");
    const gone = await joinAs(p.fx.code, "Gone");
    const tokens = { lu: await registerToken(lu.token), tomi: await registerToken(tomi.token), gone: await registerToken(gone.token) };
    await api("PUT", `/blocks/${lu.userId}`, { token: p.fx.adminToken }); // author blocked lu
    await api("PUT", `/blocks/${p.fx.adminUserId}`, { token: tomi.token }); // tomi blocked the author
    await api("DELETE", `/trips/${p.fx.tripId}/members/me`, { token: gone.token });
    const off = await api("PATCH", "/me/settings", { token: p.cami.token, body: { notifications: { momentPosted: false } } });
    expect(off.body.notifications.momentPosted).toBe(false);
    await p.register();
    await p.complete();
    expect(p.expo.sent.map((m) => m.to)).toEqual([p.tokens.fede]);
    expect(Object.values(tokens)).not.toContain(p.expo.sent[0]!.to);
  });

  it("uses the author's username when they have no name", async () => {
    const p = await pushFixture();
    await env.DB.prepare("UPDATE users SET name = NULL, username = 'juani' WHERE id = ?").bind(p.fx.adminUserId).run();
    await p.register();
    await p.complete();
    expect(p.expo.sent[0]!.title).toBe("@juani subió su momento");
  });
});
