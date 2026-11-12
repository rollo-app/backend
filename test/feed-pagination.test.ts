import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { localDate } from "../src/lib/util";
import { DAY, MINUTE, TZ, addMediaDirect, api, joinAs, newTrip, uploadMedia } from "./helpers";

const feed = (tripId: string, token: string, qs = "") => api("GET", `/trips/${tripId}/feed${qs}`, { token });
const ids = (res: { body: { items: Array<{ id: string }> } }) => res.body.items.map((i) => i.id);

async function fixture(opts: { reveal?: boolean } = {}) {
  const fx = await newTrip({ momentMode: "photo_selfie", startsAt: Date.now() - 5 * DAY });
  const fede = await joinAs(fx.code, "Fede");
  const base = Date.now() - 3 * DAY;
  const authors = [{ userId: fx.adminUserId, memberId: fx.adminId }, { userId: fede.userId, memberId: fede.memberId }];
  const photos = await addMediaDirect(fx.tripId, authors, 5, { from: base, to: base + 4 * DAY });
  if (opts.reveal) expect((await api("POST", `/trips/${fx.tripId}/reveal`, { token: fx.adminToken })).status).toBeLessThan(300);
  return { ...fx, fede, photos, base };
}

/** Walks every page and returns them all. */
async function walk(tripId: string, token: string, limit: number, order = "") {
  const pages: Array<{ ids: string[]; nextCursor: string | null }> = [];
  let cursor: string | null = null;
  do {
    const qs: string = `?limit=${limit}${order ? `&order=${order}` : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const res = await feed(tripId, token, qs);
    expect(res.status).toBe(200);
    pages.push({ ids: ids(res), nextCursor: res.body.nextCursor });
    cursor = res.body.nextCursor;
  } while (cursor);
  return pages;
}

describe.each([false, true])("GET /trips/:id/feed pagination (revealed: %s)", (reveal) => {
  it("without cursor or limit returns the whole feed and nextCursor null (older app builds)", async () => {
    const fx = await fixture({ reveal });
    const res = await feed(fx.tripId, fx.adminToken);
    expect(res.status).toBe(200);
    expect(res.body.revealed).toBe(reveal);
    expect(ids(res)).toEqual(fx.photos);
    expect(res.body.nextCursor).toBeNull();
  });

  it("pages of 2 over 5 photos are 2, 2, 1, without duplicates or gaps and in the compat order", async () => {
    const fx = await fixture({ reveal });
    const compat = ids(await feed(fx.tripId, fx.adminToken));
    const pages = await walk(fx.tripId, fx.adminToken, 2);
    expect(pages.map((p) => p.ids.length)).toEqual([2, 2, 1]);
    expect(pages.map((p) => p.nextCursor === null)).toEqual([false, false, true]);
    expect(pages.flatMap((p) => p.ids)).toEqual(compat);
  });

  it("a page that ends exactly at the end has nextCursor null", async () => {
    const fx = await fixture({ reveal });
    const res = await feed(fx.tripId, fx.adminToken, "?limit=5");
    expect(ids(res)).toEqual(fx.photos);
    expect(res.body.nextCursor).toBeNull();
  });

  it("only cursor: default page size, everything after the cursor", async () => {
    const fx = await fixture({ reveal });
    const first = await feed(fx.tripId, fx.adminToken, "?limit=2");
    const rest = await feed(fx.tripId, fx.adminToken, `?cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(ids(rest)).toEqual(fx.photos.slice(2));
    expect(rest.body.nextCursor).toBeNull();
  });

  it("ties on the same takenAt are ordered by id and never skipped or repeated across pages", async () => {
    const fx = await newTrip({ startsAt: Date.now() - 5 * DAY });
    const at = Date.now() - 2 * DAY;
    const same = await addMediaDirect(fx.tripId, [{ userId: fx.adminUserId, memberId: fx.adminId }], 5, { from: at, to: at });
    if (reveal) await api("POST", `/trips/${fx.tripId}/reveal`, { token: fx.adminToken });
    const all = ids(await feed(fx.tripId, fx.adminToken));
    expect(all).toEqual([...same].sort());
    expect((await walk(fx.tripId, fx.adminToken, 2)).flatMap((p) => p.ids)).toEqual(all);
    expect((await walk(fx.tripId, fx.adminToken, 1)).flatMap((p) => p.ids)).toEqual(all);
  });

  it("filters apply across pages: a deleted photo and one archived by someone else never show up", async () => {
    const fx = await fixture({ reveal: true });
    expect((await api("DELETE", `/media/${fx.photos[1]}`, { token: fx.fede.token })).status).toBeLessThan(300);
    expect((await api("POST", `/media/${fx.photos[3]}/archive`, { token: fx.fede.token })).status).toBe(204);
    const pages = await walk(fx.tripId, fx.adminToken, 2);
    expect(pages.flatMap((p) => p.ids)).toEqual([fx.photos[0], fx.photos[2], fx.photos[4]]);
    expect(pages.map((p) => p.ids.length)).toEqual([2, 1]);
    // The author still sees their archived photo.
    expect((await walk(fx.tripId, fx.fede.token, 2)).flatMap((p) => p.ids)).toContain(fx.photos[3]);
  });

  it("a moment selfie is never an item of its own, in any page", async () => {
    const fx = await newTrip({ momentMode: "photo_selfie", startsAt: Date.now() - 5 * DAY });
    const notifyAt = Date.now() - 2 * MINUTE;
    const day = localDate(notifyAt, TZ);
    await env.DB.prepare("INSERT INTO trip_moments (trip_id, user_id, day, notify_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(fx.tripId, fx.adminUserId, day, notifyAt, Date.now())
      .run();
    const plain = await uploadMedia(fx.tripId, fx.adminToken, { takenAt: Date.now() - DAY });
    const mainId = await uploadMedia(fx.tripId, fx.adminToken, { momentDay: day, takenAt: notifyAt + MINUTE });
    const selfieId = await uploadMedia(fx.tripId, fx.adminToken, { pairedMediaId: mainId });
    if (reveal) await api("POST", `/trips/${fx.tripId}/reveal`, { token: fx.adminToken });
    const all = (await walk(fx.tripId, fx.adminToken, 1)).flatMap((p) => p.ids);
    expect(all).toEqual([plain, mainId]);
    expect(all).not.toContain(selfieId);
  });
});

describe("GET /trips/:id/feed validation", () => {
  it("400 for an invalid cursor", async () => {
    const fx = await fixture();
    const res = await feed(fx.tripId, fx.adminToken, "?cursor=nope");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Cursor inválido");
    expect((await feed(fx.tripId, fx.adminToken, "?cursor=nope&limit=2")).status).toBe(400);
  });

  it("400 for a limit that is 0, above 100 or not an integer", async () => {
    const fx = await fixture();
    for (const limit of ["0", "101", "abc", "1.5", "-1"]) {
      expect((await feed(fx.tripId, fx.adminToken, `?limit=${limit}`)).status, `limit=${limit}`).toBe(400);
    }
    expect((await feed(fx.tripId, fx.adminToken, "?limit=100")).status).toBe(200);
    expect((await feed(fx.tripId, fx.adminToken, "?limit=1")).status).toBe(200);
  });
});

describe.each([false, true])("GET /trips/:id/feed order=desc (revealed: %s)", (reveal) => {
  it("order omitted is asc; without cursor or limit order=desc returns the whole feed reversed, nextCursor null", async () => {
    const fx = await fixture({ reveal });
    const asc = ids(await feed(fx.tripId, fx.adminToken));
    expect(ids(await feed(fx.tripId, fx.adminToken, "?order=asc"))).toEqual(asc);
    const res = await feed(fx.tripId, fx.adminToken, "?order=desc");
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([...asc].reverse());
    expect(res.body.nextCursor).toBeNull();
  });

  it("pages of 2 over 5 photos are 2, 2, 1 in exact reverse order, without duplicates or gaps", async () => {
    const fx = await fixture({ reveal });
    const asc = ids(await feed(fx.tripId, fx.adminToken));
    const pages = await walk(fx.tripId, fx.adminToken, 2, "desc");
    expect(pages.map((p) => p.ids.length)).toEqual([2, 2, 1]);
    expect(pages.map((p) => p.nextCursor === null)).toEqual([false, false, true]);
    expect(pages.flatMap((p) => p.ids)).toEqual([...asc].reverse());
  });

  it("only cursor with order=desc: default page size, everything before the cursor", async () => {
    const fx = await fixture({ reveal });
    const asc = ids(await feed(fx.tripId, fx.adminToken));
    const first = await feed(fx.tripId, fx.adminToken, "?order=desc&limit=2");
    const rest = await feed(fx.tripId, fx.adminToken, `?order=desc&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(ids(rest)).toEqual([...asc].reverse().slice(2));
    expect(rest.body.nextCursor).toBeNull();
  });

  it("ties on the same takenAt walk in desc by id without skips or repeats", async () => {
    const fx = await newTrip({ startsAt: Date.now() - 5 * DAY });
    const at = Date.now() - 2 * DAY;
    const same = await addMediaDirect(fx.tripId, [{ userId: fx.adminUserId, memberId: fx.adminId }], 5, { from: at, to: at });
    if (reveal) await api("POST", `/trips/${fx.tripId}/reveal`, { token: fx.adminToken });
    const desc = [...same].sort().reverse();
    expect(ids(await feed(fx.tripId, fx.adminToken, "?order=desc"))).toEqual(desc);
    for (const limit of [1, 2]) {
      expect((await walk(fx.tripId, fx.adminToken, limit, "desc")).flatMap((p) => p.ids)).toEqual(desc);
    }
  });

  it("filters apply in desc: a deleted photo and one archived by someone else never show up", async () => {
    const fx = await fixture({ reveal: true });
    expect((await api("DELETE", `/media/${fx.photos[1]}`, { token: fx.fede.token })).status).toBeLessThan(300);
    expect((await api("POST", `/media/${fx.photos[3]}/archive`, { token: fx.fede.token })).status).toBe(204);
    const pages = await walk(fx.tripId, fx.adminToken, 2, "desc");
    expect(pages.flatMap((p) => p.ids)).toEqual([fx.photos[4], fx.photos[2], fx.photos[0]]);
    expect(pages.map((p) => p.ids.length)).toEqual([2, 1]);
    expect((await walk(fx.tripId, fx.fede.token, 2, "desc")).flatMap((p) => p.ids)).toContain(fx.photos[3]);
  });

  it("400 for an invalid order", async () => {
    const fx = await fixture({ reveal });
    for (const order of ["up", "DESC", ""]) {
      expect((await feed(fx.tripId, fx.adminToken, `?order=${order}`)).status, `order=${order}`).toBe(400);
    }
  });
});
