import { env } from "cloudflare:workers";
import app from "../src/index";
import { describe, expect, it } from "vitest";
import {
  api,
  createTrip,
  DAY,
  HOUR,
  join,
  MINUTE,
  photoBody,
  putFiles,
  uploadMedia,
  videoBody,
} from "./helpers";

describe("POST /trips/:id/media (register)", () => {
  it("returns signed URLs for original and thumbnail", async () => {
    const { tripId, adminToken } = await createTrip();
    const body = photoBody();
    const res = await api("POST", `/trips/${tripId}/media`, { token: adminToken, body });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: body.id, status: "pending", expiresIn: 900 });
    expect(res.body.upload.original).toContain(`/trips/${tripId}/${body.id}/original.jpg`);
    expect(res.body.upload.thumb).toContain(`/trips/${tripId}/${body.id}/thumb.jpg`);
    expect(res.body.upload.original).toContain("X-Amz-Signature=");
  });

  it("is idempotent: retrying with the same id doesn't duplicate or use quota", async () => {
    const { tripId, adminToken } = await createTrip({ dailyPhotoLimit: 1 });
    const body = photoBody();

    expect((await api("POST", `/trips/${tripId}/media`, { token: adminToken, body })).status).toBe(201);
    const retry = await api("POST", `/trips/${tripId}/media`, { token: adminToken, body });
    expect(retry.status).toBe(200);
    expect(retry.body.upload.original).toEqual(expect.any(String));

    const { results } = await env.DB.prepare("SELECT id FROM media").all();
    expect(results).toHaveLength(1);
  });

  it("if already uploaded, the retry only confirms", async () => {
    const { tripId, adminToken } = await createTrip();
    const body = photoBody();
    await api("POST", `/trips/${tripId}/media`, { token: adminToken, body });
    await putFiles(tripId, body.id);
    await api("POST", `/media/${body.id}/complete`, { token: adminToken });

    const retry = await api("POST", `/trips/${tripId}/media`, { token: adminToken, body });
    expect(retry.body).toEqual({ id: body.id, status: "uploaded" });
  });

  it("doesn't allow using another person's id", async () => {
    const { tripId, code, adminToken } = await createTrip();
    const fede = await join(code, "Fede");
    const body = photoBody();
    await api("POST", `/trips/${tripId}/media`, { token: adminToken, body });
    expect((await api("POST", `/trips/${tripId}/media`, { token: fede.token, body })).status).toBe(409);
  });

  it("rejects videos longer than 15 seconds", async () => {
    const { tripId, adminToken } = await createTrip();
    const res = await api("POST", `/trips/${tripId}/media`, {
      token: adminToken,
      body: videoBody({ durationS: 22 }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/15 segundos/);
  });

  it("accepts a video of exactly 15 seconds", async () => {
    const { tripId, adminToken } = await createTrip();
    const res = await api("POST", `/trips/${tripId}/media`, {
      token: adminToken,
      body: videoBody({ durationS: 15 }),
    });
    expect(res.status).toBe(201);
    expect(res.body.upload.original).toContain("original.mp4");
  });

  it("rejects files that are too large", async () => {
    const { tripId, adminToken } = await createTrip();
    const res = await api("POST", `/trips/${tripId}/media`, {
      token: adminToken,
      body: photoBody({ sizeBytes: 30 * 1024 * 1024 }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects photos with a time in the future", async () => {
    const { tripId, adminToken } = await createTrip();
    const res = await api("POST", `/trips/${tripId}/media`, {
      token: adminToken,
      body: photoBody({ takenAt: Date.now() + HOUR }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects photos from before the trip", async () => {
    const { tripId, adminToken } = await createTrip();
    const res = await api("POST", `/trips/${tripId}/media`, {
      token: adminToken,
      body: photoBody({ takenAt: Date.now() - 5 * DAY }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts photos without GPS", async () => {
    const { tripId, adminToken } = await createTrip();
    const res = await api("POST", `/trips/${tripId}/media`, {
      token: adminToken,
      body: photoBody({ lat: null, lng: null, accuracyM: null }),
    });
    expect(res.status).toBe(201);
  });

  it("accepts nothing after the reveal", async () => {
    const { tripId, adminToken } = await createTrip();
    await api("POST", `/trips/${tripId}/reveal`, { token: adminToken });
    const res = await api("POST", `/trips/${tripId}/media`, { token: adminToken, body: photoBody() });
    expect(res.status).toBe(409);
  });
});

describe("daily limit", () => {
  it("cuts off at the day's photo limit", async () => {
    const { tripId, adminToken } = await createTrip({ dailyPhotoLimit: 2 });
    await uploadMedia(tripId, adminToken);
    await uploadMedia(tripId, adminToken);

    const res = await api("POST", `/trips/${tripId}/media`, { token: adminToken, body: photoBody() });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("Ya usaste tus 2 fotos de hoy");
  });

  it("pending ones count too", async () => {
    const { tripId, adminToken } = await createTrip({ dailyPhotoLimit: 1 });
    await api("POST", `/trips/${tripId}/media`, { token: adminToken, body: photoBody() });
    const res = await api("POST", `/trips/${tripId}/media`, { token: adminToken, body: photoBody() });
    expect(res.status).toBe(429);
  });

  it("photos and videos have separate quotas", async () => {
    const { tripId, adminToken } = await createTrip({ dailyPhotoLimit: 1, dailyVideoLimit: 1 });
    await uploadMedia(tripId, adminToken);
    const res = await api("POST", `/trips/${tripId}/media`, { token: adminToken, body: videoBody() });
    expect(res.status).toBe(201);
  });

  it("the quota is per person", async () => {
    const { tripId, code, adminToken } = await createTrip({ dailyPhotoLimit: 1 });
    const fede = await join(code, "Fede");
    await uploadMedia(tripId, adminToken);
    const res = await api("POST", `/trips/${tripId}/media`, { token: fede.token, body: photoBody() });
    expect(res.status).toBe(201);
  });

  it("a photo taken yesterday (uploaded today) counts toward yesterday's quota", async () => {
    const { tripId, adminToken } = await createTrip({ dailyPhotoLimit: 1, startsAt: Date.now() - 3 * DAY });
    await uploadMedia(tripId, adminToken);
    const res = await api("POST", `/trips/${tripId}/media`, {
      token: adminToken,
      body: photoBody({ takenAt: Date.now() - DAY - HOUR }),
    });
    expect(res.status).toBe(201);
  });
});

describe("POST /media/:id/complete", () => {
  it("fails if the files are not in R2", async () => {
    const { tripId, adminToken } = await createTrip();
    const body = photoBody();
    await api("POST", `/trips/${tripId}/media`, { token: adminToken, body });
    const res = await api("POST", `/media/${body.id}/complete`, { token: adminToken });
    expect(res.status).toBe(400);
  });

  it("fails if only the thumbnail is missing", async () => {
    const { tripId, adminToken } = await createTrip();
    const body = photoBody();
    await api("POST", `/trips/${tripId}/media`, { token: adminToken, body });
    await env.MEDIA.put(`trips/${tripId}/${body.id}/original.jpg`, "x");
    expect((await api("POST", `/media/${body.id}/complete`, { token: adminToken })).status).toBe(400);
  });

  it("marks as uploaded and stores the real size", async () => {
    const { tripId, adminToken } = await createTrip();
    const body = photoBody();
    await api("POST", `/trips/${tripId}/media`, { token: adminToken, body });
    await putFiles(tripId, body.id);

    const res = await api("POST", `/media/${body.id}/complete`, { token: adminToken });
    expect(res.body).toEqual({ id: body.id, status: "uploaded" });

    const row = await env.DB.prepare("SELECT status, size_bytes FROM media WHERE id = ?").bind(body.id).first();
    expect(row).toEqual({ status: "uploaded", size_bytes: `original-${body.id}`.length });
  });

  it("nobody can confirm someone else's photo", async () => {
    const { tripId, code, adminToken } = await createTrip();
    const fede = await join(code, "Fede");
    const body = photoBody();
    await api("POST", `/trips/${tripId}/media`, { token: adminToken, body });
    await putFiles(tripId, body.id);
    expect((await api("POST", `/media/${body.id}/complete`, { token: fede.token })).status).toBe(404);
  });
});

describe("GET /trips/:id/feed", () => {
  it("before the reveal: metadata only, no files (not even your own)", async () => {
    const { tripId, code } = await createTrip();
    const fede = await join(code, "Fede");
    await uploadMedia(tripId, fede.token, { caption: "el viento" });

    const res = await api("GET", `/trips/${tripId}/feed`, { token: fede.token });
    expect(res.status).toBe(200);
    expect(res.body.revealed).toBe(false);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      type: "photo",
      caption: "el viento",
      lat: -49.33,
      lng: -72.88,
      author: { name: "Fede" },
    });
    expect(res.body.items[0]).not.toHaveProperty("files");
  });

  it("doesn't show the ones that haven't finished uploading", async () => {
    const { tripId, adminToken } = await createTrip();
    await api("POST", `/trips/${tripId}/media`, { token: adminToken, body: photoBody() });
    const res = await api("GET", `/trips/${tripId}/feed`, { token: adminToken });
    expect(res.body.items).toHaveLength(0);
  });

  it("orders by time taken, not by upload time", async () => {
    const { tripId, adminToken } = await createTrip({ dailyPhotoLimit: 5 });
    const later = await uploadMedia(tripId, adminToken, { takenAt: Date.now() - MINUTE });
    const earlier = await uploadMedia(tripId, adminToken, { takenAt: Date.now() - 2 * HOUR });

    const res = await api("GET", `/trips/${tripId}/feed`, { token: adminToken });
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([earlier, later]);
  });

  it("after the reveal it includes the files", async () => {
    const { tripId, adminToken } = await createTrip();
    const id = await uploadMedia(tripId, adminToken);
    await api("POST", `/trips/${tripId}/reveal`, { token: adminToken });

    const res = await api("GET", `/trips/${tripId}/feed`, { token: adminToken });
    expect(res.body.revealed).toBe(true);
    expect(res.body.items[0].files).toEqual({
      thumb: `/trips/${tripId}/media/${id}/thumb`,
      original: `/trips/${tripId}/media/${id}/original`,
    });
  });
});

describe("downloads", () => {
  it("blocked before the reveal", async () => {
    const { tripId, adminToken } = await createTrip();
    const id = await uploadMedia(tripId, adminToken);
    expect((await api("GET", `/trips/${tripId}/media/${id}/thumb`, { token: adminToken })).status).toBe(403);
  });

  it("after the reveal it returns thumb and original", async () => {
    const { tripId, code, adminToken } = await createTrip();
    const fede = await join(code, "Fede");
    const id = await uploadMedia(tripId, adminToken);
    await api("POST", `/trips/${tripId}/reveal`, { token: adminToken });

    const thumb = await api("GET", `/trips/${tripId}/media/${id}/thumb`, { token: fede.token });
    expect(thumb.status).toBe(200);
    expect(thumb.body).toBe(`thumb-${id}`);
    expect(thumb.headers.get("content-type")).toBe("image/jpeg");

    const original = await api("GET", `/trips/${tripId}/media/${id}/original`, { token: fede.token });
    expect(original.body).toBe(`original-${id}`);
  });

  it("videos are served as mp4", async () => {
    const { tripId, adminToken } = await createTrip();
    const id = await uploadMedia(tripId, adminToken, { type: "video" });
    await api("POST", `/trips/${tripId}/reveal`, { token: adminToken });
    const res = await api("GET", `/trips/${tripId}/media/${id}/original`, { token: adminToken });
    expect(res.headers.get("content-type")).toBe("video/mp4");
  });

  it("files from another trip can't be requested", async () => {
    const a = await createTrip();
    const b = await createTrip();
    const id = await uploadMedia(a.tripId, a.adminToken);
    await api("POST", `/trips/${b.tripId}/reveal`, { token: b.adminToken });
    expect((await api("GET", `/trips/${b.tripId}/media/${id}/thumb`, { token: b.adminToken })).status).toBe(404);
  });
});

describe("DELETE /media/:id (admin only)", () => {
  it("the admin deletes anyone's photo and its files before the reveal", async () => {
    const { tripId, code, adminToken } = await createTrip();
    const fede = await join(code, "Fede");
    const id = await uploadMedia(tripId, fede.token);

    expect((await api("DELETE", `/media/${id}`, { token: adminToken })).status).toBe(204);
    expect(await env.MEDIA.head(`trips/${tripId}/${id}/original.jpg`)).toBeNull();
    expect(await env.MEDIA.head(`trips/${tripId}/${id}/thumb.jpg`)).toBeNull();
    expect((await api("GET", `/trips/${tripId}/feed`, { token: adminToken })).body.items).toHaveLength(0);
    const detail = await api("GET", `/trips/${tripId}`, { token: fede.token });
    expect(detail.body.totalUploaded).toBe(0);
  });

  it("a member can't delete, not even their own", async () => {
    const { tripId, code } = await createTrip();
    const fede = await join(code, "Fede");
    const id = await uploadMedia(tripId, fede.token);
    expect((await api("DELETE", `/media/${id}`, { token: fede.token })).status).toBe(403);
  });

  it("doesn't give the quota back: deleting is not retaking", async () => {
    const { tripId, code, adminToken } = await createTrip({ dailyPhotoLimit: 1 });
    const fede = await join(code, "Fede");
    const id = await uploadMedia(tripId, fede.token);
    await api("DELETE", `/media/${id}`, { token: adminToken });

    expect((await api("POST", `/trips/${tripId}/media`, { token: fede.token, body: photoBody() })).status).toBe(429);
    expect((await api("GET", `/trips/${tripId}`, { token: fede.token })).body.today.photosLeft).toBe(0);
  });

  it("retrying to register a deleted photo gives 409 and doesn't revive it", async () => {
    const { tripId, code, adminToken } = await createTrip();
    const fede = await join(code, "Fede");
    const body = photoBody();
    await api("POST", `/trips/${tripId}/media`, { token: fede.token, body });
    await api("DELETE", `/media/${body.id}`, { token: adminToken });

    const retry = await api("POST", `/trips/${tripId}/media`, { token: fede.token, body });
    expect(retry.status).toBe(409);
    expect((await api("POST", `/media/${body.id}/complete`, { token: fede.token })).status).toBe(404);
  });

  it("deleting twice gives 404", async () => {
    const { tripId, adminToken } = await createTrip();
    const id = await uploadMedia(tripId, adminToken);
    expect((await api("DELETE", `/media/${id}`, { token: adminToken })).status).toBe(204);
    expect((await api("DELETE", `/media/${id}`, { token: adminToken })).status).toBe(404);
  });

  it("the admin of another trip can't delete", async () => {
    const a = await createTrip();
    const b = await createTrip();
    const id = await uploadMedia(a.tripId, a.adminToken);
    expect((await api("DELETE", `/media/${id}`, { token: b.adminToken })).status).toBe(404);
  });

  it("can't delete after the reveal", async () => {
    const { tripId, adminToken } = await createTrip();
    const id = await uploadMedia(tripId, adminToken);
    await api("POST", `/trips/${tripId}/reveal`, { token: adminToken });
    expect((await api("DELETE", `/media/${id}`, { token: adminToken })).status).toBe(409);
  });
});

describe("thumbhash", () => {
  // Real ~25-byte ThumbHash in standard base64
  const HASH = "3OcRJYB4d3h/iIeHeEh3eIhw+j3A";

  it("is stored on register and shows up in the feed before the reveal", async () => {
    const { tripId, adminToken } = await createTrip();
    const id = await uploadMedia(tripId, adminToken, { thumbhash: HASH });
    const feed = await api("GET", `/trips/${tripId}/feed`, { token: adminToken });
    expect(feed.body.revealed).toBe(false);
    const item = feed.body.items.find((i: any) => i.id === id);
    expect(item.thumbhash).toBe(HASH);
    expect(item.files).toBeUndefined();
  });

  it("is still there after the reveal", async () => {
    const { tripId, adminToken } = await createTrip();
    await uploadMedia(tripId, adminToken, { type: "video", thumbhash: HASH });
    await api("POST", `/trips/${tripId}/reveal`, { token: adminToken });
    const feed = await api("GET", `/trips/${tripId}/feed`, { token: adminToken });
    expect(feed.body.items[0].thumbhash).toBe(HASH);
  });

  it("is optional: without thumbhash the feed returns null", async () => {
    const { tripId, adminToken } = await createTrip();
    await uploadMedia(tripId, adminToken);
    const feed = await api("GET", `/trips/${tripId}/feed`, { token: adminToken });
    expect(feed.body.items[0].thumbhash).toBeNull();
  });

  it("rejects something that isn't base64", async () => {
    const { tripId, adminToken } = await createTrip();
    const res = await api("POST", `/trips/${tripId}/media`, {
      token: adminToken,
      body: photoBody({ thumbhash: "no es base64!" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a thumbhash longer than 64 characters", async () => {
    const { tripId, adminToken } = await createTrip();
    const res = await api("POST", `/trips/${tripId}/media`, {
      token: adminToken,
      body: photoBody({ thumbhash: "A".repeat(68) }),
    });
    expect(res.status).toBe(400);
  });

  it("a retry with a different thumbhash doesn't fail and keeps the first one", async () => {
    const { tripId, adminToken } = await createTrip();
    const body = photoBody({ thumbhash: HASH });
    expect((await api("POST", `/trips/${tripId}/media`, { token: adminToken, body })).status).toBe(201);
    const retry = await api("POST", `/trips/${tripId}/media`, {
      token: adminToken,
      body: { ...body, thumbhash: "AAAAAAAAAAAA" },
    });
    expect(retry.status).toBe(200);
    await putFiles(tripId, body.id);
    await api("POST", `/media/${body.id}/complete`, { token: adminToken });
    const feed = await api("GET", `/trips/${tripId}/feed`, { token: adminToken });
    expect(feed.body.items[0].thumbhash).toBe(HASH);
  });
});

describe("local uploads (DEV_LOCAL_UPLOADS)", () => {
  const workerEnv = env;
  const DEV = { DEV_LOCAL_UPLOADS: "1" };
  const ORIGIN = "http://192.168.1.5:8787";

  async function register(tripId: string, token: string, body = photoBody()) {
    const res = await api("POST", `/trips/${tripId}/media`, { token, body, env: DEV, origin: ORIGIN });
    expect(res.status).toBe(201);
    return { body, upload: res.body.upload as { original: string; thumb: string } };
  }

  async function put(url: string, content: string, env: Record<string, unknown> = DEV) {
    const req = new Request(url, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: content });
    return app.request(req, undefined, { ...workerEnv, ...env });
  }

  it("the URLs point to the worker itself, with the request's host", async () => {
    const { tripId, adminToken } = await createTrip();
    const { body, upload } = await register(tripId, adminToken);
    expect(upload.original.startsWith(`${ORIGIN}/dev/upload/trips/${tripId}/${body.id}/original.jpg?`)).toBe(true);
    expect(upload.thumb.startsWith(`${ORIGIN}/dev/upload/trips/${tripId}/${body.id}/thumb.jpg?`)).toBe(true);
  });

  it("the PUT stores in local R2 and then complete works", async () => {
    const { tripId, adminToken } = await createTrip();
    const { body, upload } = await register(tripId, adminToken);
    expect((await put(upload.original, "foto")).status).toBe(200);
    expect((await put(upload.thumb, "mini")).status).toBe(200);

    const stored = await workerEnv.MEDIA.get(`trips/${tripId}/${body.id}/original.jpg`);
    expect(await stored!.text()).toBe("foto");
    expect(stored!.httpMetadata?.contentType).toBe("image/jpeg");

    const done = await api("POST", `/media/${body.id}/complete`, { token: adminToken });
    expect(done.status).toBe(200);
  });

  it("rejects a tampered signature or one used for another key", async () => {
    const { tripId, adminToken } = await createTrip();
    const { upload } = await register(tripId, adminToken);
    const otherKey = upload.original.replace("original.jpg", "otra.jpg");
    expect((await put(otherKey, "x")).status).toBe(403);
    const tampered = upload.original.replace(/exp=\d+/, "exp=99999999999999");
    expect((await put(tampered, "x")).status).toBe(403);
  });

  it("without the variable the route doesn't exist and the URLs are R2's", async () => {
    const { tripId, adminToken } = await createTrip();
    const { upload } = await register(tripId, adminToken);
    expect((await put(upload.original, "x", { DEV_LOCAL_UPLOADS: undefined })).status).toBe(404);

    const res = await api("POST", `/trips/${tripId}/media`, { token: adminToken, body: photoBody() });
    expect(res.body.upload.original).toContain("r2.cloudflarestorage.com");
  });
});
