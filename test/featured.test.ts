import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { FeaturedPhotosSchema, FeedResponseSchema } from "../src/schemas";
import { api, befriend, joinAs, newTrip, signUp, uploadMedia } from "./helpers";
import { BASELINE_JPEG, photoWithMetadata } from "./jpeg-fixture";

const BLOCKED = "Quien sacó esta foto no quiere que se destaque";
const PRIVATE = "Este perfil es privado";

/** Revealed trip: Juani (admin) and Fede, with one photo each (Fede's at a known spot) and one video by Fede. */
async function revealedTrip() {
  const trip = await newTrip({ dailyPhotoLimit: 10 });
  const fede = await joinAs(trip.code, "Fede");
  const juaniPhoto = await uploadMedia(trip.tripId, trip.adminToken, { caption: "mi foto" });
  const fedePhoto = await uploadMedia(trip.tripId, fede.token, { lat: -41.0806, lng: -71.495, caption: "secreto" });
  const fedeVideo = await uploadMedia(trip.tripId, fede.token, { type: "video" });
  // Real JPEGs, like the app uploads them: the original carries EXIF (GPS, caption, author) and XMP.
  const photos: [string, string, string][] = [[juaniPhoto, "mi foto", "Juani"], [fedePhoto, "secreto", "Fede"]];
  for (const [id, caption, author] of photos) {
    await env.MEDIA.put(`trips/${trip.tripId}/${id}/original.jpg`, photoWithMetadata(caption, author));
    await env.MEDIA.put(`trips/${trip.tripId}/${id}/thumb.jpg`, photoWithMetadata(caption, author));
  }
  await api("POST", `/trips/${trip.tripId}/reveal`, { token: trip.adminToken });
  const juani = { token: trip.adminToken, userId: trip.adminUserId };
  return { ...trip, juani, fede, juaniPhoto, fedePhoto, fedeVideo };
}

const feature = (token: string, mediaId: string) => api("PUT", `/me/featured/${mediaId}`, { token });
const unfeature = (token: string, mediaId: string) => api("DELETE", `/me/featured/${mediaId}`, { token });
const block = (token: string, mediaId: string) => api("PUT", `/media/${mediaId}/feature-block`, { token });
const unblock = (token: string, mediaId: string) => api("DELETE", `/media/${mediaId}/feature-block`, { token });
const list = (token: string, userId: string) => api("GET", `/users/${userId}/featured`, { token });
const ids = (res: { body: { photos: { mediaId: string }[] } }) => res.body.photos.map((p) => p.mediaId);

/** Inserts `n` uploaded photos of a member straight into D1 (faster than the API, which has a daily limit). */
async function insertPhotos(tripId: string, memberId: string, n: number): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO media (id, trip_id, member_id, type, taken_at, local_date, original_key, thumb_key, status, created_at, width, height)
       VALUES (?, ?, ?, 'photo', ?, '2027-01-12', ?, ?, 'uploaded', ?, 4032, 3024)`,
    )
      .bind(id, tripId, memberId, Date.now() - i, `trips/${tripId}/${id}/original.jpg`, `trips/${tripId}/${id}/thumb.jpg`, Date.now())
      .run();
    out.push(id);
  }
  return out;
}

describe("PUT /me/featured/{mediaId}", () => {
  it("features a photo of yours or of someone else, idempotently", async () => {
    const t = await revealedTrip();
    expect((await feature(t.juani.token, t.juaniPhoto)).status).toBe(204);
    expect((await feature(t.juani.token, t.fedePhoto)).status).toBe(204);
    expect((await feature(t.juani.token, t.fedePhoto)).status).toBe(204);
    const res = await list(t.juani.token, t.juani.userId);
    expect(res.status).toBe(200);
    expect(ids(res).sort()).toEqual([t.juaniPhoto, t.fedePhoto].sort());
  });

  it("404 if the media does not exist", async () => {
    const t = await revealedTrip();
    const res = await feature(t.juani.token, crypto.randomUUID());
    expect(res.status).toBe(404);
  });

  it("404 if you are not an active member of its rollo", async () => {
    const t = await revealedTrip();
    const stranger = await signUp();
    expect((await feature(stranger.token, t.fedePhoto)).status).toBe(404);
    // Left the rollo: no longer an active member.
    expect((await api("DELETE", `/trips/${t.tripId}/members/me`, { token: t.fede.token })).status).toBe(204);
    expect((await feature(t.fede.token, t.juaniPhoto)).status).toBe(404);
  });

  it("404 for a photo the admin deleted", async () => {
    const trip = await newTrip();
    const fede = await joinAs(trip.code, "Fede");
    const id = await uploadMedia(trip.tripId, fede.token);
    await api("DELETE", `/media/${id}`, { token: trip.adminToken });
    await api("POST", `/trips/${trip.tripId}/reveal`, { token: trip.adminToken });
    expect((await feature(trip.adminToken, id)).status).toBe(404);
  });

  it("409 before the reveal", async () => {
    const trip = await newTrip();
    const id = await uploadMedia(trip.tripId, trip.adminToken);
    const res = await feature(trip.adminToken, id);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Este rollo todavía no se reveló" });
  });

  it("400 for a video", async () => {
    const t = await revealedTrip();
    const res = await feature(t.juani.token, t.fedeVideo);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Solo se pueden destacar fotos" });
  });

  it("409 when the author blocked it, but the author can still feature it", async () => {
    const t = await revealedTrip();
    expect((await block(t.fede.token, t.fedePhoto)).status).toBe(204);
    const res = await feature(t.juani.token, t.fedePhoto);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: BLOCKED });
    expect((await feature(t.fede.token, t.fedePhoto)).status).toBe(204);
  });

  it("caps at 60 photos per person", async () => {
    const t = await revealedTrip();
    const photos = await insertPhotos(t.tripId, t.fede.memberId, 61);
    for (const id of photos.slice(0, 60)) expect((await feature(t.juani.token, id)).status).toBe(204);
    // Re-featuring one you already have is still fine at the cap.
    expect((await feature(t.juani.token, photos[0]!)).status).toBe(204);
    const res = await feature(t.juani.token, photos[60]!);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Podés destacar hasta 60 fotos" });
    // Removing one frees a spot.
    expect((await unfeature(t.juani.token, photos[0]!)).status).toBe(204);
    expect((await feature(t.juani.token, photos[60]!)).status).toBe(204);
  });

  it("requires a session", async () => {
    const t = await revealedTrip();
    expect((await api("PUT", `/me/featured/${t.fedePhoto}`)).status).toBe(401);
  });
});

describe("DELETE /me/featured/{mediaId}", () => {
  it("removes it, and is a 204 also if it was not featured", async () => {
    const t = await revealedTrip();
    await feature(t.juani.token, t.fedePhoto);
    expect((await unfeature(t.juani.token, t.fedePhoto)).status).toBe(204);
    expect(ids(await list(t.juani.token, t.juani.userId))).toEqual([]);
    expect((await unfeature(t.juani.token, t.fedePhoto)).status).toBe(204);
    expect((await unfeature(t.juani.token, crypto.randomUUID())).status).toBe(204);
  });
});

describe("feature block (author only)", () => {
  it("only the author can block or unblock; others get 403", async () => {
    const t = await revealedTrip();
    const res = await block(t.juani.token, t.fedePhoto);
    expect(res.status).toBe(403);
    expect((await unblock(t.juani.token, t.fedePhoto)).status).toBe(403);
  });

  it("the author can block and unblock after leaving the rollo or being removed from it", async () => {
    const t = await revealedTrip();
    await feature(t.juani.token, t.fedePhoto);
    expect((await api("DELETE", `/trips/${t.tripId}/members/me`, { token: t.fede.token })).status).toBe(204);
    expect((await block(t.fede.token, t.fedePhoto)).status).toBe(204);
    expect(ids(await list(t.juani.token, t.juani.userId))).toEqual([]);
    expect((await feature(t.juani.token, t.fedePhoto)).body).toEqual({ error: BLOCKED });
    expect((await unblock(t.fede.token, t.fedePhoto)).status).toBe(204);
    expect((await feature(t.juani.token, t.fedePhoto)).status).toBe(204);

    const r = await revealedTrip();
    await api("DELETE", `/trips/${r.tripId}/members/${r.fede.memberId}`, { token: r.juani.token });
    expect((await block(r.fede.token, r.fedePhoto)).status).toBe(204);
    expect((await unblock(r.fede.token, r.fedePhoto)).status).toBe(204);
  });

  it("someone who left the rollo still can't block a photo they didn't take", async () => {
    const t = await revealedTrip();
    await api("DELETE", `/trips/${t.tripId}/members/me`, { token: t.fede.token });
    expect((await block(t.fede.token, t.juaniPhoto)).status).toBe(404);
    expect((await block(t.juani.token, t.fedePhoto)).status).toBe(403);
  });

  it("404 for someone who is not a member of the rollo", async () => {
    const t = await revealedTrip();
    const stranger = await signUp();
    expect((await block(stranger.token, t.fedePhoto)).status).toBe(404);
  });

  it("blocking removes other people's featured rows of that photo, keeps the author's, and unblocking allows it again", async () => {
    const t = await revealedTrip();
    await feature(t.juani.token, t.fedePhoto);
    await feature(t.fede.token, t.fedePhoto);
    expect((await block(t.fede.token, t.fedePhoto)).status).toBe(204);
    expect((await block(t.fede.token, t.fedePhoto)).status).toBe(204);
    expect(ids(await list(t.juani.token, t.juani.userId))).toEqual([]);
    expect(ids(await list(t.fede.token, t.fede.userId))).toEqual([t.fedePhoto]);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM featured WHERE media_id = ?").bind(t.fedePhoto).first<{ n: number }>();
    expect(row!.n).toBe(1);

    expect((await unblock(t.fede.token, t.fedePhoto)).status).toBe(204);
    expect((await feature(t.juani.token, t.fedePhoto)).status).toBe(204);
  });
});

describe("GET /users/{userId}/featured", () => {
  it("returns exactly the contract's keys: no trip, caption or exact coordinates", async () => {
    const t = await revealedTrip();
    await feature(t.juani.token, t.fedePhoto);
    const res = await list(t.juani.token, t.juani.userId);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(["photos"]);
    const [photo] = res.body.photos;
    expect(Object.keys(photo).sort()).toEqual(
      ["author", "height", "mediaId", "originalPath", "takenAt", "thumbPath", "thumbhash", "width", "zone"].sort(),
    );
    expect(Object.keys(photo.author).sort()).toEqual(["avatarUrl", "id", "name", "username"]);
    expect(photo).toMatchObject({
      mediaId: t.fedePhoto,
      width: 4032,
      height: 3024,
      author: { id: t.fede.userId, name: "Fede", avatarUrl: null },
      zone: { lat: -41.075, lng: -71.475 },
      thumbPath: `/featured/${t.juani.userId}/${t.fedePhoto}/thumb`,
      originalPath: `/featured/${t.juani.userId}/${t.fedePhoto}/original`,
    });
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(t.tripId);
    expect(raw).not.toContain("secreto");
    expect(raw).not.toContain("Viaje al sur");
    expect(raw).not.toContain("-41.0806");
    expect(() => FeaturedPhotosSchema.parse(res.body)).not.toThrow();
  });

  it("author is null for the owner's own photos; zone is null without GPS", async () => {
    const trip = await newTrip();
    const id = await uploadMedia(trip.tripId, trip.adminToken, { lat: null, lng: null });
    await api("POST", `/trips/${trip.tripId}/reveal`, { token: trip.adminToken });
    await feature(trip.adminToken, id);
    const res = await list(trip.adminToken, trip.adminUserId);
    expect(res.body.photos[0]).toMatchObject({ mediaId: id, author: null, zone: null });
  });

  it("orders by when each photo was taken, newest first, not by when it was featured", async () => {
    const t = await revealedTrip();
    const [oldest, middle, newest] = (await insertPhotos(t.tripId, t.fede.memberId, 3)) as [string, string, string];
    await env.DB.prepare("UPDATE media SET taken_at = ? WHERE id = ?").bind(1000, oldest).run();
    await env.DB.prepare("UPDATE media SET taken_at = ? WHERE id = ?").bind(2000, middle).run();
    await env.DB.prepare("UPDATE media SET taken_at = ? WHERE id = ?").bind(3000, newest).run();
    for (const id of [newest, middle, oldest]) await feature(t.juani.token, id);
    expect(ids(await list(t.juani.token, t.juani.userId))).toEqual([newest, middle, oldest]);
  });

  it("is visible to the owner and to friends of a private profile", async () => {
    const t = await revealedTrip();
    await feature(t.juani.token, t.fedePhoto);
    const friend = await signUp();
    await befriend(t.juani.token, friend.token);
    expect(ids(await list(friend.token, t.juani.userId))).toEqual([t.fedePhoto]);
  });

  it("403 for a stranger when the profile is private, without leaking anything", async () => {
    const t = await revealedTrip();
    await feature(t.juani.token, t.fedePhoto);
    const stranger = await signUp();
    const res = await list(stranger.token, t.juani.userId);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: PRIVATE });
    // Sharing a rollo does not make you a friend either.
    expect((await list(t.fede.token, t.juani.userId)).status).toBe(403);
  });

  it("is visible to a stranger when the profile is public", async () => {
    const t = await revealedTrip();
    await feature(t.juani.token, t.fedePhoto);
    await api("PATCH", "/me", { token: t.juani.token, body: { profileVisibility: "public" } });
    const stranger = await signUp();
    expect(ids(await list(stranger.token, t.juani.userId))).toEqual([t.fedePhoto]);
  });

  it("404 for an unknown user", async () => {
    const v = await signUp();
    expect((await list(v.token, crypto.randomUUID())).status).toBe(404);
  });

  it("excludes deleted photos", async () => {
    const t = await revealedTrip();
    await feature(t.juani.token, t.fedePhoto);
    await env.DB.prepare("UPDATE media SET deleted_at = ? WHERE id = ?").bind(Date.now(), t.fedePhoto).run();
    expect(ids(await list(t.juani.token, t.juani.userId))).toEqual([]);
  });

  it("excludes photos blocked after being featured (even if a row survived), but not the author's own", async () => {
    const t = await revealedTrip();
    await feature(t.juani.token, t.fedePhoto);
    await feature(t.fede.token, t.fedePhoto);
    // Simulate a row that slipped in: blocked flag set without the cleanup.
    await env.DB.prepare("UPDATE media SET feature_blocked_at = ? WHERE id = ?").bind(Date.now(), t.fedePhoto).run();
    expect(ids(await list(t.juani.token, t.juani.userId))).toEqual([]);
    expect(ids(await list(t.fede.token, t.fede.userId))).toEqual([t.fedePhoto]);
  });

  it("excludes photos of rollos the owner left or was removed from", async () => {
    const t = await revealedTrip();
    await feature(t.fede.token, t.juaniPhoto);
    await api("DELETE", `/trips/${t.tripId}/members/me`, { token: t.fede.token });
    expect(ids(await list(t.fede.token, t.fede.userId))).toEqual([]);

    const other = await revealedTrip();
    await feature(other.fede.token, other.juaniPhoto);
    await api("DELETE", `/trips/${other.tripId}/members/${other.fede.memberId}`, { token: other.juani.token });
    expect(ids(await list(other.fede.token, other.fede.userId))).toEqual([]);
  });
});

describe("GET /featured/{userId}/{mediaId}/{variant}", () => {
  const file = (token: string | undefined, userId: string, mediaId: string, variant = "thumb") =>
    api("GET", `/featured/${userId}/${mediaId}/${variant}`, { token });

  it("serves thumb and original with the download's cache headers to someone who can see the profile", async () => {
    const t = await revealedTrip();
    await feature(t.juani.token, t.fedePhoto);
    const friend = await signUp();
    await befriend(t.juani.token, friend.token);

    const thumb = await file(friend.token, t.juani.userId, t.fedePhoto, "thumb");
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get("content-type")).toBe("image/jpeg");
    expect(thumb.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(thumb.headers.get("etag")).toBeTruthy();

    const original = await file(friend.token, t.juani.userId, t.fedePhoto, "original");
    expect(original.status).toBe(200);
    expect(original.headers.get("content-type")).toBe("image/jpeg");
  });

  it("serves both variants without metadata: no EXIF (GPS, caption, author), no XMP, no comment", async () => {
    const t = await revealedTrip();
    await feature(t.juani.token, t.fedePhoto);
    await api("PATCH", "/me", { token: t.juani.token, body: { profileVisibility: "public" } });
    const stranger = await signUp();
    const stored = await env.MEDIA.get(`trips/${t.tripId}/${t.fedePhoto}/original.jpg`);
    const storedEtag = stored!.httpEtag;
    expect(new TextDecoder().decode(await stored!.arrayBuffer())).toContain("secreto");

    for (const variant of ["original", "thumb"]) {
      const res = await api("GET", `/featured/${t.juani.userId}/${t.fedePhoto}/${variant}`, { token: stranger.token });
      expect(res.status).toBe(200);
      const body = res.body as string;
      expect(body).not.toContain("secreto");
      expect(body).not.toContain("Fede");
      expect(body).not.toContain("Exif\0\0");
      expect(body).not.toContain("http://ns.adobe.com/xap/1.0/");
      expect(body.startsWith("\uFFFD\uFFFD")).toBe(true); // FF D8 is not valid UTF-8
      expect(Number(res.headers.get("content-length"))).toBeLessThan(photoWithMetadata("secreto", "Fede").length);
      expect(Number(res.headers.get("content-length"))).toBeGreaterThanOrEqual(BASELINE_JPEG.length);
      // The bytes differ from the stored object, so the etag can't be the stored one.
      expect(res.headers.get("etag")).toBeTruthy();
      expect(res.headers.get("etag")).not.toBe(storedEtag);
    }
  });

  it("the trip download still serves the original with its metadata to co-members", async () => {
    const t = await revealedTrip();
    const res = await api("GET", `/trips/${t.tripId}/media/${t.fedePhoto}/original`, { token: t.juani.token });
    expect(res.status).toBe(200);
    expect(res.body).toContain("secreto");
    expect(res.body).toContain("Exif\0\0");
  });

  it("404 rather than serving a stored file that isn't a well-formed JPEG", async () => {
    const t = await revealedTrip();
    await feature(t.juani.token, t.fedePhoto);
    await env.MEDIA.put(`trips/${t.tripId}/${t.fedePhoto}/original.jpg`, "secreto: not a jpeg");
    const cut = photoWithMetadata("secreto").subarray(0, 60);
    await env.MEDIA.put(`trips/${t.tripId}/${t.fedePhoto}/thumb.jpg`, cut);
    for (const variant of ["original", "thumb"]) {
      const res = await file(t.juani.token, t.juani.userId, t.fedePhoto, variant);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain("secreto");
    }
  });

  it("404 for a stored object whose content type isn't JPEG", async () => {
    const t = await revealedTrip();
    await feature(t.juani.token, t.fedePhoto);
    await env.MEDIA.put(`trips/${t.tripId}/${t.fedePhoto}/original.jpg`, photoWithMetadata("secreto"), {
      httpMetadata: { contentType: "video/mp4" },
    });
    expect((await file(t.juani.token, t.juani.userId, t.fedePhoto, "original")).status).toBe(404);
  });

  it("403 for a stranger when the profile is private", async () => {
    const t = await revealedTrip();
    await feature(t.juani.token, t.fedePhoto);
    const stranger = await signUp();
    const res = await file(stranger.token, t.juani.userId, t.fedePhoto);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: PRIVATE });
  });

  it("serves it to a stranger when the profile is public", async () => {
    const t = await revealedTrip();
    await feature(t.juani.token, t.fedePhoto);
    await api("PATCH", "/me", { token: t.juani.token, body: { profileVisibility: "public" } });
    const stranger = await signUp();
    expect((await file(stranger.token, t.juani.userId, t.fedePhoto)).status).toBe(200);
  });

  it("404 for a photo that is not featured by that user (even if it is in one of their rollos)", async () => {
    const t = await revealedTrip();
    await feature(t.juani.token, t.fedePhoto);
    expect((await file(t.juani.token, t.juani.userId, t.juaniPhoto)).status).toBe(404);
    // Someone else's featured photo can't be fetched through your own profile path either.
    expect((await file(t.fede.token, t.fede.userId, t.fedePhoto)).status).toBe(404);
  });

  it("404 once the photo is blocked, deleted, or the owner left the rollo", async () => {
    const t = await revealedTrip();
    await feature(t.juani.token, t.fedePhoto);
    await block(t.fede.token, t.fedePhoto);
    expect((await file(t.juani.token, t.juani.userId, t.fedePhoto)).status).toBe(404);

    const d = await revealedTrip();
    await feature(d.juani.token, d.fedePhoto);
    await env.DB.prepare("UPDATE media SET deleted_at = ? WHERE id = ?").bind(Date.now(), d.fedePhoto).run();
    expect((await file(d.juani.token, d.juani.userId, d.fedePhoto)).status).toBe(404);

    const l = await revealedTrip();
    await feature(l.fede.token, l.juaniPhoto);
    await api("DELETE", `/trips/${l.tripId}/members/me`, { token: l.fede.token });
    expect((await file(l.fede.token, l.fede.userId, l.juaniPhoto)).status).toBe(404);
  });

  it("404 for an unknown user and 400 for an unknown variant", async () => {
    const t = await revealedTrip();
    expect((await file(t.juani.token, crypto.randomUUID(), t.fedePhoto)).status).toBe(404);
    await feature(t.juani.token, t.fedePhoto);
    expect((await file(t.juani.token, t.juani.userId, t.fedePhoto, "raw")).status).toBe(400);
  });

  it("requires a session", async () => {
    const t = await revealedTrip();
    await feature(t.juani.token, t.fedePhoto);
    expect((await file(undefined, t.juani.userId, t.fedePhoto)).status).toBe(401);
  });
});

describe("account deletion and featured photos", () => {
  it("deleting your account clears your featured rows", async () => {
    const t = await revealedTrip();
    await feature(t.fede.token, t.juaniPhoto);
    expect((await api("DELETE", "/me", { token: t.fede.token })).status).toBe(204);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM featured WHERE user_id = ?").bind(t.fede.userId).first<{ n: number }>();
    expect(row!.n).toBe(0);
  });

  it("photos of a deleted account disappear from other people's featured lists", async () => {
    const t = await revealedTrip();
    await feature(t.juani.token, t.fedePhoto);
    await feature(t.juani.token, t.juaniPhoto);
    expect((await api("DELETE", "/me", { token: t.fede.token })).status).toBe(204);
    expect(ids(await list(t.juani.token, t.juani.userId))).toEqual([t.juaniPhoto]);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM featured WHERE media_id = ?").bind(t.fedePhoto).first<{ n: number }>();
    expect(row!.n).toBe(0);
  });
});

describe("feed fields for featured photos", () => {
  it("every item carries the author's user id, before and after the reveal", async () => {
    const trip = await newTrip();
    const fede = await joinAs(trip.code, "Fede");
    await uploadMedia(trip.tripId, fede.token);
    await uploadMedia(trip.tripId, trip.adminToken);

    const before = await api("GET", `/trips/${trip.tripId}/feed`, { token: trip.adminToken });
    const byMember = (items: any[], memberId: string) => items.find((i) => i.author.id === memberId);
    expect(byMember(before.body.items, fede.memberId).author.userId).toBe(fede.userId);
    expect(byMember(before.body.items, trip.adminId).author.userId).toBe(trip.adminUserId);
    expect(before.body.items[0]).not.toHaveProperty("featuredByMe");
    expect(before.body.items[0]).not.toHaveProperty("featureBlocked");

    await api("POST", `/trips/${trip.tripId}/reveal`, { token: trip.adminToken });
    const after = await api("GET", `/trips/${trip.tripId}/feed`, { token: trip.adminToken });
    expect(byMember(after.body.items, fede.memberId).author.userId).toBe(fede.userId);
    expect(() => FeedResponseSchema.parse(after.body)).not.toThrow();
  });

  it("after the reveal each item says whether you featured it and whether the author blocked it", async () => {
    const t = await revealedTrip();
    await feature(t.juani.token, t.juaniPhoto);
    await block(t.fede.token, t.fedePhoto);

    const mine = await api("GET", `/trips/${t.tripId}/feed`, { token: t.juani.token });
    const item = (res: typeof mine, id: string) => res.body.items.find((i: any) => i.id === id);
    expect(item(mine, t.juaniPhoto)).toMatchObject({ featuredByMe: true, featureBlocked: false });
    expect(item(mine, t.fedePhoto)).toMatchObject({ featuredByMe: false, featureBlocked: true });

    // "featuredByMe" is per viewer.
    const fedes = await api("GET", `/trips/${t.tripId}/feed`, { token: t.fede.token });
    expect(item(fedes, t.juaniPhoto)).toMatchObject({ featuredByMe: false });
  });
});
