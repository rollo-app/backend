import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import migrationSql from "../migrations/0037_original_retention.sql?raw";
import { flushPendingPushes } from "../src/lib/push";
import { storageUsage } from "../src/lib/storage";
import { purgeDeletedFiles } from "../src/lib/r2-purge";
import { runOriginalsNotices, runOriginalsPurge } from "../src/modules/trips/originals.service";
import { BASELINE_JPEG } from "./jpeg-fixture";
import {
  DAY,
  HOUR,
  MINUTE,
  TZ,
  addMediaDirect,
  api,
  displayContent,
  joinAs,
  makeSuperadmin,
  mockExpo,
  newTrip,
  originalContent,
  photoBody,
  putFiles,
  registerToken,
  thumbContent,
  uploadMedia,
  videoBody,
} from "./helpers";
import { localDate } from "../src/lib/util";

const MB = 1024 * 1024;
const register = (tripId: string, token: string, body: unknown) => api("POST", `/trips/${tripId}/media`, { token, body });
const complete = (id: string, token: string) => api("POST", `/media/${id}/complete`, { token });
const feed = (tripId: string, token: string) => api("GET", `/trips/${tripId}/feed`, { token });
const download = (tripId: string, id: string, variant: string, token: string) => api("GET", `/trips/${tripId}/media/${id}/${variant}`, { token });
const mediaRow = (id: string) => env.DB.prepare("SELECT * FROM media WHERE id = ?").bind(id).first<Record<string, any>>();
const tripRow = (id: string) => env.DB.prepare("SELECT * FROM trips WHERE id = ?").bind(id).first<Record<string, any>>();
const purgeQueue = async () => (await env.DB.prepare("SELECT key FROM r2_purge").all<{ key: string }>()).results.map((r) => r.key).sort();

/** Moves the reveal of the rollo to `daysAgo` days ago (starts and ends before it), like waiting that long. */
async function revealedDaysAgo(tripId: string, daysAgo: number) {
  const at = Date.now() - daysAgo * DAY;
  await env.DB.prepare("UPDATE trips SET starts_at = ?, ends_at = ?, reveal_at = ?, revealed_at = NULL WHERE id = ?")
    .bind(at - 3 * DAY, at - DAY, at, tripId)
    .run();
}

// ---------- Register ----------

describe("POST /trips/{id}/media with a display file", () => {
  it("without displaySizeBytes (old builds) the upload has only original and thumb", async () => {
    const t = await newTrip();
    const res = await register(t.tripId, t.adminToken, photoBody());
    expect(res.status).toBe(201);
    expect(Object.keys(res.body.upload).sort()).toEqual(["original", "thumb"]);
  });

  it("with displaySizeBytes the upload also has a signed display URL", async () => {
    const t = await newTrip();
    const body = photoBody({}, { display: true });
    const res = await register(t.tripId, t.adminToken, body);
    expect(res.status).toBe(201);
    expect(res.body.upload.display).toContain(`trips/${t.tripId}/${body.id}/display.jpg`);
    expect(res.body.upload.display).toMatch(/^https:/);
    const row = await mediaRow(body.id);
    expect(row).toMatchObject({ display_key: `trips/${t.tripId}/${body.id}/display.jpg`, display_size_bytes: body.displaySizeBytes });
  });

  it("an idempotent retry returns the display URL too when it was declared", async () => {
    const t = await newTrip();
    const body = photoBody({}, { display: true });
    await register(t.tripId, t.adminToken, body);
    const again = await register(t.tripId, t.adminToken, body);
    expect(again.status).toBe(200);
    expect(again.body.upload.display).toContain("display.jpg");
  });

  it("a retry of a registration without display has no display URL", async () => {
    const t = await newTrip();
    const body = photoBody();
    await register(t.tripId, t.adminToken, body);
    const again = await register(t.tripId, t.adminToken, body);
    expect(again.body.upload).not.toHaveProperty("display");
  });

  it("rejects a display over 4 MB and a display on a video", async () => {
    const t = await newTrip({ dailyVideoLimit: 1 });
    const big = await register(t.tripId, t.adminToken, photoBody({ displaySizeBytes: 4 * MB + 1 }));
    expect(big.status).toBe(400);
    const ok = await register(t.tripId, t.adminToken, photoBody({ displaySizeBytes: 4 * MB }));
    expect(ok.status).toBe(201);
    const video = await register(t.tripId, t.adminToken, videoBody({ displaySizeBytes: 1000 }));
    expect(video.status).toBe(400);
  });
});

// ---------- Complete ----------

describe("POST /media/{id}/complete with a display file", () => {
  it("confirms when the display has the declared size", async () => {
    const t = await newTrip();
    const id = await uploadMedia(t.tripId, t.adminToken, {}, { display: true });
    expect(await mediaRow(id)).toMatchObject({ status: "uploaded", display_key: `trips/${t.tripId}/${id}/display.jpg`, display_size_bytes: displayContent(id).length });
  });

  it("a declared display that was never uploaded is a 400 and stays pending", async () => {
    const t = await newTrip();
    const body = photoBody({}, { display: true });
    await register(t.tripId, t.adminToken, body);
    await env.MEDIA.put(`trips/${t.tripId}/${body.id}/original.jpg`, originalContent(body.id));
    await env.MEDIA.put(`trips/${t.tripId}/${body.id}/thumb.jpg`, thumbContent(body.id));
    const res = await complete(body.id, t.adminToken);
    expect(res.status).toBe(400);
    expect((await mediaRow(body.id))!.status).toBe("pending");
  });

  it("a display with another size deletes all the files, 400, stays pending", async () => {
    const t = await newTrip();
    const body = photoBody({}, { display: true });
    await register(t.tripId, t.adminToken, body);
    await putFiles(t.tripId, body.id, "photo");
    await env.MEDIA.put(`trips/${t.tripId}/${body.id}/display.jpg`, "demasiado largo para lo declarado");
    const res = await complete(body.id, t.adminToken);
    expect(res.status).toBe(400);
    expect((await mediaRow(body.id))!.status).toBe("pending");
    for (const f of ["original.jpg", "thumb.jpg", "display.jpg"]) expect(await env.MEDIA.head(`trips/${t.tripId}/${body.id}/${f}`)).toBeNull();
  });

  it("without a declared display it completes as before (no display_key)", async () => {
    const t = await newTrip();
    const id = await uploadMedia(t.tripId, t.adminToken);
    expect(await mediaRow(id)).toMatchObject({ status: "uploaded", display_key: null, display_size_bytes: null });
  });
});

// ---------- Feed ----------

describe("feed files", () => {
  it("a photo with display has files.display and originalAvailable; one without has neither the display path", async () => {
    const t = await newTrip();
    const withDisplay = await uploadMedia(t.tripId, t.adminToken, {}, { display: true });
    const old = await uploadMedia(t.tripId, t.adminToken);
    await revealedDaysAgo(t.tripId, 1);
    const items = (await feed(t.tripId, t.adminToken)).body.items;
    const a = items.find((i: any) => i.id === withDisplay);
    const b = items.find((i: any) => i.id === old);
    expect(a.files).toEqual({
      thumb: `/trips/${t.tripId}/media/${withDisplay}/thumb`,
      original: `/trips/${t.tripId}/media/${withDisplay}/original`,
      display: `/trips/${t.tripId}/media/${withDisplay}/display`,
    });
    expect(a.originalAvailable).toBe(true);
    expect(b.files).not.toHaveProperty("display");
    expect(b.originalAvailable).toBe(true);
  });

  it("once purged, files.original stays (old builds) and originalAvailable is false", async () => {
    const t = await newTrip();
    const id = await uploadMedia(t.tripId, t.adminToken, {}, { display: true });
    await revealedDaysAgo(t.tripId, 1);
    await env.DB.prepare("UPDATE media SET original_purged_at = ? WHERE id = ?").bind(Date.now(), id).run();
    const item = (await feed(t.tripId, t.adminToken)).body.items[0];
    expect(item.files.original).toBe(`/trips/${t.tripId}/media/${id}/original`);
    expect(item.originalAvailable).toBe(false);
  });

  it("the daily moment photo and its linked image carry display before the reveal", async () => {
    const t = await newTrip({ momentMode: "photo_selfie", startsAt: Date.now() - 5 * DAY });
    const fede = await joinAs(t.code, "Fede");
    const notifyAt = Date.now() - 2 * MINUTE;
    const day = localDate(notifyAt, TZ);
    await env.DB.prepare("INSERT INTO trip_moments (trip_id, user_id, day, notify_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(t.tripId, t.adminUserId, day, notifyAt, Date.now())
      .run();
    const main = await uploadMedia(t.tripId, t.adminToken, { momentDay: day, takenAt: notifyAt + MINUTE }, { display: true });
    const selfie = await uploadMedia(t.tripId, t.adminToken, { pairedMediaId: main }, { display: true });
    const item = (await feed(t.tripId, fede.token)).body.items.find((i: any) => i.id === main);
    expect(item.files.display).toBe(`/trips/${t.tripId}/media/${main}/display`);
    expect(item.originalAvailable).toBe(true);
    expect(item.selfie.files.display).toBe(`/trips/${t.tripId}/media/${selfie}/display`);
    expect((await download(t.tripId, main, "display", fede.token)).body).toBe(displayContent(main));
  });
});

// ---------- Downloads ----------

describe("GET /trips/{id}/media/{id}/{variant}", () => {
  it("display serves the display file; original serves the original", async () => {
    const t = await newTrip();
    const id = await uploadMedia(t.tripId, t.adminToken, {}, { display: true });
    await revealedDaysAgo(t.tripId, 1);
    expect((await download(t.tripId, id, "display", t.adminToken)).body).toBe(displayContent(id));
    expect((await download(t.tripId, id, "original", t.adminToken)).body).toBe(originalContent(id));
  });

  it("original falls back to display once purged (even if the object is still in R2)", async () => {
    const t = await newTrip();
    const id = await uploadMedia(t.tripId, t.adminToken, {}, { display: true });
    await revealedDaysAgo(t.tripId, 1);
    await env.DB.prepare("UPDATE media SET original_purged_at = ? WHERE id = ?").bind(Date.now(), id).run();
    const res = await download(t.tripId, id, "original", t.adminToken);
    expect(res.status).toBe(200);
    expect(res.body).toBe(displayContent(id));
  });

  it("original falls back to display when its object is gone from R2", async () => {
    const t = await newTrip();
    const id = await uploadMedia(t.tripId, t.adminToken, {}, { display: true });
    await revealedDaysAgo(t.tripId, 1);
    await env.MEDIA.delete(`trips/${t.tripId}/${id}/original.jpg`);
    expect((await download(t.tripId, id, "original", t.adminToken)).body).toBe(displayContent(id));
  });

  it("display falls back to the original for uploads without a display (old builds)", async () => {
    const t = await newTrip();
    const id = await uploadMedia(t.tripId, t.adminToken);
    await revealedDaysAgo(t.tripId, 1);
    const res = await download(t.tripId, id, "display", t.adminToken);
    expect(res.status).toBe(200);
    expect(res.body).toBe(originalContent(id));
  });

  it("404 when neither the original nor a display exist", async () => {
    const t = await newTrip();
    const id = await uploadMedia(t.tripId, t.adminToken);
    await revealedDaysAgo(t.tripId, 1);
    await env.MEDIA.delete(`trips/${t.tripId}/${id}/original.jpg`);
    expect((await download(t.tripId, id, "original", t.adminToken)).status).toBe(404);
  });

  it("display is also 403 before the reveal for a normal photo", async () => {
    const t = await newTrip();
    const id = await uploadMedia(t.tripId, t.adminToken, {}, { display: true });
    expect((await download(t.tripId, id, "display", t.adminToken)).status).toBe(403);
  });
});

describe("GET /featured/{userId}/{mediaId}/{variant}", () => {
  async function featuredPhoto() {
    const t = await newTrip();
    const id = await uploadMedia(t.tripId, t.adminToken, {}, { display: true });
    await revealedDaysAgo(t.tripId, 1);
    const put = await api("PUT", `/me/featured/${id}`, { token: t.adminToken });
    expect(put.status).toBe(204);
    return { ...t, id };
  }
  const file = (userId: string, id: string, variant: string, token: string) => api("GET", `/featured/${userId}/${id}/${variant}`, { token });

  it("original falls back to display once purged; display falls back to original without one", async () => {
    const f = await featuredPhoto();
    await env.MEDIA.put(`trips/${f.tripId}/${f.id}/original.jpg`, BASELINE_JPEG, { httpMetadata: { contentType: "image/jpeg" } });
    await env.MEDIA.put(`trips/${f.tripId}/${f.id}/display.jpg`, BASELINE_JPEG, { httpMetadata: { contentType: "image/jpeg" } });
    expect((await file(f.adminUserId, f.id, "display", f.adminToken)).status).toBe(200);
    await env.DB.prepare("UPDATE media SET original_purged_at = ? WHERE id = ?").bind(Date.now(), f.id).run();
    await env.MEDIA.delete(`trips/${f.tripId}/${f.id}/original.jpg`);
    expect((await file(f.adminUserId, f.id, "original", f.adminToken)).status).toBe(200);
    // Old upload: no display key, so display serves the original.
    await env.DB.prepare("UPDATE media SET original_purged_at = NULL, display_key = NULL, display_size_bytes = NULL WHERE id = ?").bind(f.id).run();
    await env.MEDIA.put(`trips/${f.tripId}/${f.id}/original.jpg`, BASELINE_JPEG, { httpMetadata: { contentType: "image/jpeg" } });
    expect((await file(f.adminUserId, f.id, "display", f.adminToken)).status).toBe(200);
  });
});

// ---------- Trip.originals ----------

describe("Trip.originals", () => {
  it("a new rollo expires its originals 30 days after the reveal", async () => {
    const t = await newTrip();
    const trip = (await api("GET", `/trips/${t.tripId}`, { token: t.adminToken })).body.trip;
    expect(trip.originals).toEqual({ keep: false, expiresAt: trip.revealAt + 30 * DAY, purged: false });
  });

  it("after a manual reveal the expiry counts from revealedAt", async () => {
    const t = await newTrip();
    const at = Date.now() - HOUR;
    await env.DB.prepare("UPDATE trips SET revealed_at = ? WHERE id = ?").bind(at, t.tripId).run();
    const trip = (await api("GET", `/trips/${t.tripId}`, { token: t.adminToken })).body.trip;
    expect(trip.originals.expiresAt).toBe(at + 30 * DAY);
  });

  it("a rollo that keeps its originals has no expiry; purged shows once the cron finished", async () => {
    const t = await newTrip();
    await env.DB.prepare("UPDATE trips SET keep_originals = 1 WHERE id = ?").bind(t.tripId).run();
    expect((await api("GET", `/trips/${t.tripId}`, { token: t.adminToken })).body.trip.originals).toEqual({ keep: true, expiresAt: null, purged: false });
    await env.DB.prepare("UPDATE trips SET keep_originals = 0, originals_purged_at = 5 WHERE id = ?").bind(t.tripId).run();
    expect((await api("GET", `/trips/${t.tripId}`, { token: t.adminToken })).body.trip.originals.purged).toBe(true);
  });

  it("is also in the create response", async () => {
    const t = await newTrip();
    const res = await api("POST", "/trips", {
      token: t.adminToken,
      body: { name: "Otro", timezone: TZ, startsAt: Date.now() + HOUR, endsAt: Date.now() + 2 * HOUR, revealAt: Date.now() + 3 * HOUR },
    });
    expect(res.body.trip.originals).toMatchObject({ keep: false, purged: false });
  });
});

describe("migration 0037", () => {
  it("keeps the originals of every rollo that exists when it runs", async () => {
    const a = await newTrip();
    const b = await newTrip();
    expect((await tripRow(a.tripId))!.keep_originals).toBe(0);
    // The ALTERs cannot run twice, so the test runs the migration's UPDATE (the logic that matters).
    await env.DB.prepare(migrationSql.slice(migrationSql.indexOf("UPDATE trips"), migrationSql.indexOf(";", migrationSql.indexOf("UPDATE trips")) + 1)).run();
    expect((await tripRow(a.tripId))!.keep_originals).toBe(1);
    expect((await tripRow(b.tripId))!.keep_originals).toBe(1);
  });
});

// ---------- Storage ----------

describe("storageUsage with display and purged originals", () => {
  it("counts display bytes and stops counting purged originals", async () => {
    const t = await newTrip({ dailyPhotoLimit: 10 });
    const a = await uploadMedia(t.tripId, t.adminToken, {}, { display: true });
    const b = await uploadMedia(t.tripId, t.adminToken);
    const full = (id: string) => originalContent(id).length + thumbContent(id).length;
    expect(await storageUsage(env)).toBe(full(a) + displayContent(a).length + full(b));
    await env.DB.prepare("UPDATE media SET original_purged_at = 1 WHERE id = ?").bind(a).run();
    expect(await storageUsage(env)).toBe(thumbContent(a).length + displayContent(a).length + full(b));
  });

  it("registering counts the display toward the limit", async () => {
    const t = await newTrip();
    const body = photoBody({}, { display: true });
    const used = body.sizeBytes + body.thumbSizeBytes;
    // 95% of the limit sits between "without display" and "with display".
    const limit = Math.ceil((used + 5) / 0.95);
    const res = await api("POST", `/trips/${t.tripId}/media`, { token: t.adminToken, body, env: { STORAGE_LIMIT_BYTES: String(limit) } });
    expect(res.status).toBe(503);
    const without = await api("POST", `/trips/${t.tripId}/media`, { token: t.adminToken, body: photoBody(), env: { STORAGE_LIMIT_BYTES: String(limit + 100) } });
    expect(without.status).toBe(201);
  });
});

// ---------- Cron: notice ----------

describe("runOriginalsNotices", () => {
  /** A rollo revealed `days` ago with one photo that has a display and Fede as a second member with a push token. */
  async function fixture(days: number) {
    const t = await newTrip();
    const fede = await joinAs(t.code, "Fede");
    const gone = await joinAs(t.code, "Se fue");
    const gonePush = await registerToken(gone.token);
    await api("DELETE", `/trips/${t.tripId}/members/me`, { token: gone.token });
    await uploadMedia(t.tripId, t.adminToken, {}, { display: true });
    await revealedDaysAgo(t.tripId, days);
    const adminPush = await registerToken(t.adminToken);
    const fedePush = await registerToken(fede.token);
    return { ...t, fede, adminPush, fedePush, gonePush };
  }

  it("does nothing before day 25", async () => {
    const f = await fixture(24);
    const expo = mockExpo();
    await runOriginalsNotices(env, Date.now());
    await flushPendingPushes();
    expect(expo.sent).toEqual([]);
    expect((await tripRow(f.tripId))!.originals_notice_at).toBeNull();
  });

  it("at day 25 sends once to every active member, opening the rollo, and claims the rollo", async () => {
    const f = await fixture(25);
    const expo = mockExpo();
    const now = Date.now();
    await runOriginalsNotices(env, now);
    expect(expo.sent.map((m) => m.to).sort()).toEqual([f.adminPush, f.fedePush].sort());
    expect(expo.sent.map((m) => m.to)).not.toContain(f.gonePush);
    expect(expo.sent[0]).toMatchObject({
      title: "Las fotos en máxima calidad de Viaje al sur se borran en 5 días",
      data: { url: `/roll?trip=${f.tripId}` },
    });
    expect(expo.sent[0]!.body).toContain("Guardalas en tu celular");
    expect((await tripRow(f.tripId))!.originals_notice_at).toBe(now);
    await runOriginalsNotices(env, now + 5 * MINUTE);
    await flushPendingPushes();
    expect(expo.sent).toHaveLength(2);
  });

  it("two simultaneous runs send once", async () => {
    await fixture(26);
    const expo = mockExpo();
    await Promise.all([runOriginalsNotices(env, Date.now()), runOriginalsNotices(env, Date.now())]);
    expect(expo.sent).toHaveLength(2);
  });

  it("respects the originalsExpiring preference", async () => {
    const f = await fixture(25);
    await api("PATCH", "/me/settings", { token: f.fede.token, body: { notifications: { originalsExpiring: false } } });
    const expo = mockExpo();
    await runOriginalsNotices(env, Date.now());
    expect(expo.sent.map((m) => m.to)).toEqual([f.adminPush]);
  });

  it("skips rollos that keep their originals, are already purged, or past the expiry", async () => {
    const keep = await fixture(26);
    await env.DB.prepare("UPDATE trips SET keep_originals = 1 WHERE id = ?").bind(keep.tripId).run();
    const purged = await fixture(26);
    await env.DB.prepare("UPDATE trips SET originals_purged_at = 1 WHERE id = ?").bind(purged.tripId).run();
    const late = await fixture(31);
    const expo = mockExpo();
    await runOriginalsNotices(env, Date.now());
    expect(expo.sent).toEqual([]);
    expect((await tripRow(late.tripId))!.originals_notice_at).toBeNull();
  });

  it("skips a rollo with no photo whose original could still be purged", async () => {
    const t = await newTrip();
    await uploadMedia(t.tripId, t.adminToken); // old build: no display, never purged
    await revealedDaysAgo(t.tripId, 26);
    await registerToken(t.adminToken);
    const expo = mockExpo();
    await runOriginalsNotices(env, Date.now());
    expect(expo.sent).toEqual([]);
  });

  it("counts from revealedAt when the admin revealed manually", async () => {
    const f = await fixture(0);
    await env.DB.prepare("UPDATE trips SET reveal_at = ?, revealed_at = ? WHERE id = ?")
      .bind(Date.now() + 5 * DAY, Date.now() - 26 * DAY, f.tripId)
      .run();
    const expo = mockExpo();
    await runOriginalsNotices(env, Date.now());
    expect(expo.sent).toHaveLength(2);
  });
});

// ---------- Cron: purge ----------

describe("runOriginalsPurge", () => {
  const key = (tripId: string, id: string, f = "original.jpg") => `trips/${tripId}/${id}/${f}`;

  it("before 30 days nothing is purged", async () => {
    const t = await newTrip();
    const id = await uploadMedia(t.tripId, t.adminToken, {}, { display: true });
    await revealedDaysAgo(t.tripId, 29);
    await runOriginalsPurge(env, Date.now());
    expect(await purgeQueue()).toEqual([]);
    expect((await mediaRow(id))!.original_purged_at).toBeNull();
  });

  it("after 30 days enqueues only the originals of photos with display and marks them", async () => {
    const t = await newTrip({ dailyPhotoLimit: 10, dailyVideoLimit: 2 });
    const withDisplay = await uploadMedia(t.tripId, t.adminToken, {}, { display: true });
    const old = await uploadMedia(t.tripId, t.adminToken);
    const video = await uploadMedia(t.tripId, t.adminToken, { type: "video" });
    await revealedDaysAgo(t.tripId, 31);
    const now = Date.now();
    await runOriginalsPurge(env, now);
    expect(await purgeQueue()).toEqual([key(t.tripId, withDisplay)]);
    expect((await mediaRow(withDisplay))!.original_purged_at).toBe(now);
    expect((await mediaRow(old))!.original_purged_at).toBeNull();
    expect((await mediaRow(video))!.original_purged_at).toBeNull();
    // Only the original is queued: thumb and display stay for good.
    expect(await purgeQueue()).not.toContain(key(t.tripId, withDisplay, "display.jpg"));
    expect((await tripRow(t.tripId))!.originals_purged_at).toBe(now);
  });

  it("the R2 purge then deletes the original after the grace period, and the display keeps being served", async () => {
    const t = await newTrip();
    const id = await uploadMedia(t.tripId, t.adminToken, {}, { display: true });
    await revealedDaysAgo(t.tripId, 31);
    const now = Date.now();
    await runOriginalsPurge(env, now);
    await purgeDeletedFiles(env, now + 2 * HOUR);
    expect(await env.MEDIA.head(key(t.tripId, id))).toBeNull();
    expect(await env.MEDIA.head(key(t.tripId, id, "display.jpg"))).not.toBeNull();
    expect(await env.MEDIA.head(key(t.tripId, id, "thumb.jpg"))).not.toBeNull();
    expect((await download(t.tripId, id, "original", t.adminToken)).body).toBe(displayContent(id));
  });

  it("never touches a rollo that keeps its originals", async () => {
    const t = await newTrip();
    await uploadMedia(t.tripId, t.adminToken, {}, { display: true });
    await revealedDaysAgo(t.tripId, 90);
    await env.DB.prepare("UPDATE trips SET keep_originals = 1 WHERE id = ?").bind(t.tripId).run();
    await runOriginalsPurge(env, Date.now());
    expect(await purgeQueue()).toEqual([]);
    expect((await tripRow(t.tripId))!.originals_purged_at).toBeNull();
  });

  it("skips deleted and pending media and is idempotent across runs", async () => {
    const t = await newTrip({ dailyPhotoLimit: 10 });
    const a = await uploadMedia(t.tripId, t.adminToken, {}, { display: true });
    const b = await uploadMedia(t.tripId, t.adminToken, {}, { display: true });
    await env.DB.prepare("UPDATE media SET deleted_at = 1 WHERE id = ?").bind(b).run();
    await revealedDaysAgo(t.tripId, 31);
    const now = Date.now();
    await runOriginalsPurge(env, now);
    await runOriginalsPurge(env, now + 5 * MINUTE);
    expect(await purgeQueue()).toEqual([key(t.tripId, a)]);
    expect((await mediaRow(a))!.original_purged_at).toBe(now);
    expect((await tripRow(t.tripId))!.originals_purged_at).toBe(now);
  });

  it("works in bounded batches and marks the rollo only when none are left", async () => {
    const t = await newTrip();
    await revealedDaysAgo(t.tripId, 31);
    const trip = (await tripRow(t.tripId))!;
    expect(trip.keep_originals).toBe(0);
    const ids = await addMediaDirect(t.tripId, [{ userId: t.adminUserId, memberId: t.adminId }], 1050, { display: true, from: Date.now() - 40 * DAY, to: Date.now() - 35 * DAY });
    expect(ids).toHaveLength(1050);
    const now = Date.now();
    await runOriginalsPurge(env, now);
    expect((await purgeQueue()).length).toBe(1000);
    expect((await tripRow(t.tripId))!.originals_purged_at).toBeNull();
    await runOriginalsPurge(env, now + 5 * MINUTE);
    expect((await purgeQueue()).length).toBe(1050);
    expect((await tripRow(t.tripId))!.originals_purged_at).toBe(now + 5 * MINUTE);
  }, 30_000);
});

// ---------- Admin ----------

describe("PATCH /admin/trips/{tripId} keepOriginals", () => {
  const patch = (tripId: string, token: string, body: unknown) => api("PATCH", `/admin/trips/${tripId}`, { token, body });

  it("a superadmin turns keep on and the rollo detail shows it", async () => {
    const su = await makeSuperadmin();
    const t = await newTrip();
    const before = (await api("GET", `/admin/trips/${t.tripId}`, { token: su.token })).body;
    expect(before).toMatchObject({ keepOriginals: false, originalsExpireAt: before.revealAt + 30 * DAY, originalsPurgedAt: null });
    const res = await patch(t.tripId, su.token, { keepOriginals: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ keepOriginals: true, originalsExpireAt: null });
    expect((await tripRow(t.tripId))!.keep_originals).toBe(1);
    expect((await api("GET", `/trips/${t.tripId}`, { token: t.adminToken })).body.trip.originals.keep).toBe(true);
  });

  it("the list has the same fields", async () => {
    const su = await makeSuperadmin();
    const t = await newTrip();
    await patch(t.tripId, su.token, { keepOriginals: true });
    const list = (await api("GET", "/admin/trips", { token: su.token })).body.items;
    expect(list.find((x: any) => x.id === t.tripId)).toMatchObject({ keepOriginals: true, originalsExpireAt: null, originalsPurgedAt: null });
  });

  it("accepts either field or both; nothing or an unknown field is a 400", async () => {
    const su = await makeSuperadmin();
    const t = await newTrip();
    expect((await patch(t.tripId, su.token, { maxMembers: 20 })).body).toMatchObject({ maxMembers: 20, keepOriginals: false });
    expect((await patch(t.tripId, su.token, { maxMembers: 25, keepOriginals: true })).body).toMatchObject({ maxMembers: 25, keepOriginals: true });
    expect((await patch(t.tripId, su.token, { keepOriginals: false })).body).toMatchObject({ maxMembers: 25, keepOriginals: false });
    expect((await patch(t.tripId, su.token, {})).status).toBe(400);
    const unknown = await patch(t.tripId, su.token, { keepOriginals: true, nombre: "x" });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toEqual({ error: "Campo no editable: nombre" });
    expect((await patch(t.tripId, su.token, { keepOriginals: "si" })).status).toBe(400);
    expect((await tripRow(t.tripId))!.keep_originals).toBe(0);
  });

  it("an invalid maxMembers does not apply keepOriginals", async () => {
    const su = await makeSuperadmin();
    const t = await newTrip();
    expect((await patch(t.tripId, su.token, { maxMembers: 0, keepOriginals: true })).status).toBe(400);
    expect((await tripRow(t.tripId))!.keep_originals).toBe(0);
  });

  it("a regular user gets 404 and 404 for a missing rollo", async () => {
    const su = await makeSuperadmin();
    const t = await newTrip();
    expect((await patch(t.tripId, t.adminToken, { keepOriginals: true })).status).toBe(404);
    expect((await patch(crypto.randomUUID(), su.token, { keepOriginals: true })).status).toBe(404);
  });

  it("turning keep on after a partial purge restores nothing and stops further purges", async () => {
    const su = await makeSuperadmin();
    const t = await newTrip();
    const id = await uploadMedia(t.tripId, t.adminToken, {}, { display: true });
    await revealedDaysAgo(t.tripId, 31);
    await runOriginalsPurge(env, Date.now());
    await patch(t.tripId, su.token, { keepOriginals: true });
    expect((await mediaRow(id))!.original_purged_at).not.toBeNull();
    expect((await feed(t.tripId, t.adminToken)).body.items[0].originalAvailable).toBe(false);
  });
});

// ---------- The display file goes with the rest ----------

describe("deleting things removes the display file too", () => {
  it("the author deleting a photo after the reveal deletes its three files", async () => {
    const t = await newTrip();
    const id = await uploadMedia(t.tripId, t.adminToken, {}, { display: true });
    await revealedDaysAgo(t.tripId, 1);
    expect((await api("DELETE", `/media/${id}`, { token: t.adminToken })).status).toBe(204);
    for (const f of ["original.jpg", "thumb.jpg", "display.jpg"]) expect(await env.MEDIA.head(`trips/${t.tripId}/${id}/${f}`)).toBeNull();
  });

  it("deleting the rollo queues the display key", async () => {
    const t = await newTrip();
    const id = await uploadMedia(t.tripId, t.adminToken, {}, { display: true });
    expect((await api("DELETE", `/trips/${t.tripId}`, { token: t.adminToken })).status).toBe(204);
    expect(await purgeQueue()).toContain(`trips/${t.tripId}/${id}/display.jpg`);
  });

  it("deleting the account removes the display file", async () => {
    const t = await newTrip();
    const fede = await joinAs(t.code, "Fede");
    const id = await uploadMedia(t.tripId, fede.token, {}, { display: true });
    expect((await api("DELETE", "/me", { token: fede.token })).status).toBe(204);
    expect(await env.MEDIA.head(`trips/${t.tripId}/${id}/display.jpg`)).toBeNull();
  });

  it("the stale pending cleanup removes the display file", async () => {
    const { cleanupStalePending } = await import("../src/lib/pending-cleanup");
    const t = await newTrip();
    const body = photoBody({}, { display: true });
    await register(t.tripId, t.adminToken, body);
    await putFiles(t.tripId, body.id, "photo", { display: true });
    await cleanupStalePending(env, Date.now() + 8 * DAY);
    expect(await env.MEDIA.head(`trips/${t.tripId}/${body.id}/display.jpg`)).toBeNull();
    expect(await mediaRow(body.id)).toBeNull();
  });
});
