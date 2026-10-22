import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import { api, befriend, createTrip, join, joinAs, newTrip, signUp, uploadMedia } from "./helpers";

const DEV = { DEV_LOCAL_UPLOADS: "1" };
const ORIGIN = "http://192.168.1.5:8787";

const JPEG_HEADER = [0xff, 0xd8, 0xff];

/** Bytes starting with the JPEG magic number followed by the given text. */
function jpeg(content = "avatar") {
  return new Uint8Array([...JPEG_HEADER, ...new TextEncoder().encode(content)]);
}

async function setAvatar(token: string, userId: string, content = "avatar") {
  const res = await api("POST", "/me/avatar", { token });
  const pending = (await env.DB.prepare("SELECT pending_avatar_key k FROM users WHERE id = ?").bind(userId).first<{ k: string }>())!.k;
  await env.MEDIA.put(pending, jpeg(content));
  const done = await api("POST", "/me/avatar/complete", { token });
  expect(done.status).toBe(200);
  expect(res.status).toBe(200);
  const key = (await env.DB.prepare("SELECT avatar_key k FROM users WHERE id = ?").bind(userId).first<{ k: string }>())!.k;
  return { key, pending, user: done.body };
}

describe("avatar", () => {
  it("full flow with local uploads: request, PUT, complete", async () => {
    const { token, userId } = await signUp();
    const res = await api("POST", "/me/avatar", { token, env: DEV, origin: ORIGIN });
    expect(res.status).toBe(200);
    expect(res.body.expiresIn).toBe(900);
    expect(res.body.upload.startsWith(`${ORIGIN}/dev/upload/avatars/${userId}/`)).toBe(true);

    const put = await app.request(
      new Request(res.body.upload, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: jpeg("bytes") }),
      undefined,
      { ...env, ...DEV },
    );
    expect(put.status).toBe(200);

    const done = await api("POST", "/me/avatar/complete", { token });
    expect(done.status).toBe(200);
    expect(done.body.avatarUrl).toMatch(new RegExp(`^/avatars/${userId}/[0-9a-f-]+\\.jpg$`));
    expect((await api("GET", "/me", { token })).body.avatarUrl).toBe(done.body.avatarUrl);
  });

  it("shows up on the trip members and the feed author", async () => {
    const { tripId, code } = await newTrip();
    const u = await joinAs(code, "Cami");
    await uploadMedia(tripId, u.token);
    const { user } = await setAvatar(u.token, u.userId);

    const detail = await api("GET", `/trips/${tripId}`, { token: u.token });
    expect(detail.body.me.avatarUrl).toBe(user.avatarUrl);
    expect(detail.body.members.find((m: any) => m.userId === u.userId).avatarUrl).toBe(user.avatarUrl);
    const feed = await api("GET", `/trips/${tripId}/feed`, { token: u.token });
    expect(feed.body.items[0].author.avatarUrl).toBe(user.avatarUrl);
  });

  it("is served publicly with cache headers", async () => {
    const { token, userId } = await signUp();
    const { user } = await setAvatar(token, userId, "the-bytes");
    const res = await api("GET", user.avatarUrl);
    expect(res.status).toBe(200);
    expect(res.body.endsWith("the-bytes")).toBe(true);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("etag")).toBeTruthy();
  });

  it("is served with headers that neutralize active content", async () => {
    const { token, userId } = await signUp();
    const { user } = await setAvatar(token, userId);
    const res = await api("GET", user.avatarUrl);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("content-disposition")).toBe("inline");
  });

  describe("complete validation", () => {
    const MESSAGE = "La foto tiene que ser un JPEG de hasta 2 MB";

    async function request(token: string, userId: string, body: string | Uint8Array, contentType = "image/jpeg") {
      await api("POST", "/me/avatar", { token });
      const pending = (await env.DB.prepare("SELECT pending_avatar_key k FROM users WHERE id = ?").bind(userId).first<{ k: string }>())!.k;
      await env.MEDIA.put(pending, body, { httpMetadata: { contentType } });
      return pending;
    }

    async function expectRejected(token: string, userId: string, pending: string) {
      const res = await api("POST", "/me/avatar/complete", { token });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(MESSAGE);
      expect(await env.MEDIA.head(pending)).toBeNull();
      const row = await env.DB.prepare("SELECT avatar_key a, pending_avatar_key p FROM users WHERE id = ?")
        .bind(userId)
        .first<{ a: string | null; p: string | null }>();
      expect(row!.p).toBeNull();
      return row!.a;
    }

    it("rejects a non-JPEG object even if it claims to be image/jpeg", async () => {
      const { token, userId } = await signUp();
      const pending = await request(token, userId, "<html><script>alert(1)</script></html>");
      expect(await expectRejected(token, userId, pending)).toBeNull();
    });

    it("rejects an object shorter than the magic bytes", async () => {
      const { token, userId } = await signUp();
      const pending = await request(token, userId, new Uint8Array([0xff, 0xd8]));
      await expectRejected(token, userId, pending);
    });

    it("rejects a JPEG larger than 2 MB", async () => {
      const { token, userId } = await signUp();
      const big = new Uint8Array(2.1 * 1024 * 1024);
      big.set(JPEG_HEADER);
      const pending = await request(token, userId, big);
      await expectRejected(token, userId, pending);
    });

    it("keeps the current avatar when a replacement is rejected", async () => {
      const { token, userId } = await signUp();
      const { key, user } = await setAvatar(token, userId);
      const pending = await request(token, userId, "<svg onload=alert(1)/>");
      expect(await expectRejected(token, userId, pending)).toBe(key);
      expect(await env.MEDIA.head(key)).not.toBeNull();
      expect((await api("GET", "/me", { token })).body.avatarUrl).toBe(user.avatarUrl);
    });

    it("accepts a small valid JPEG", async () => {
      const { token, userId } = await signUp();
      await request(token, userId, jpeg("small"));
      expect((await api("POST", "/me/avatar/complete", { token })).status).toBe(200);
    });
  });

  it("promotes the avatar to a new server-chosen key so a late PUT to the presigned key cannot change it", async () => {
    const { token, userId } = await signUp();
    const { key, pending, user } = await setAvatar(token, userId, "trusted");
    expect(key).not.toBe(pending);
    expect(user.avatarUrl).toBe(`/${key}`);
    expect(user.avatarUrl.endsWith(pending.split("/").pop()!)).toBe(false);
    expect(await env.MEDIA.head(pending)).toBeNull();

    // The presigned URL is still valid for 15 minutes: simulate a late PUT on the old key.
    await env.MEDIA.put(pending, "<html>evil</html>");
    const res = await api("GET", user.avatarUrl);
    expect(res.status).toBe(200);
    expect(res.body.endsWith("trusted")).toBe(true);
    expect(res.body).not.toContain("<html>");
    expect(res.headers.get("content-type")).toBe("image/jpeg");
  });

  it("replacing the avatar deletes the old object and its URL 404s", async () => {
    const { token, userId } = await signUp();
    const first = await setAvatar(token, userId, "one");
    const second = await setAvatar(token, userId, "two");
    expect(second.key).not.toBe(first.key);
    expect(await env.MEDIA.head(first.key)).toBeNull();
    expect((await api("GET", first.user.avatarUrl)).status).toBe(404);
    expect((await api("GET", second.user.avatarUrl)).body.endsWith("two")).toBe(true);
  });

  it("complete without requesting an upload is a 400", async () => {
    const { token } = await signUp();
    const res = await api("POST", "/me/avatar/complete", { token });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Primero pedí dónde subir la foto");
  });

  it("complete without the uploaded file is a 400", async () => {
    const { token } = await signUp();
    await api("POST", "/me/avatar", { token });
    const res = await api("POST", "/me/avatar/complete", { token });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Falta la foto; volvé a subirla");
  });

  it("complete can't be repeated once consumed", async () => {
    const { token, userId } = await signUp();
    await setAvatar(token, userId);
    expect((await api("POST", "/me/avatar/complete", { token })).status).toBe(400);
  });

  it("requires a session", async () => {
    expect((await api("POST", "/me/avatar")).status).toBe(401);
    expect((await api("POST", "/me/avatar/complete")).status).toBe(401);
  });

  it("another user's path or a guessed file is a 404", async () => {
    const a = await signUp();
    const b = await signUp();
    const { user } = await setAvatar(a.token, a.userId);
    const file = user.avatarUrl.split("/").pop();
    expect((await api("GET", `/avatars/${b.userId}/${file}`)).status).toBe(404);
    expect((await api("GET", `/avatars/${a.userId}/guess.jpg`)).status).toBe(404);
    expect((await api("GET", `/avatars/nobody/${file}`)).status).toBe(404);
  });

  it("an upload that was never completed is not served", async () => {
    const { token, userId } = await signUp();
    await api("POST", "/me/avatar", { token });
    const pending = (await env.DB.prepare("SELECT pending_avatar_key k FROM users WHERE id = ?").bind(userId).first<{ k: string }>())!.k;
    await env.MEDIA.put(pending, "x");
    expect((await api("GET", `/avatars/${userId}/${pending.split("/").pop()}`)).status).toBe(404);
  });
});

describe("DELETE /me", () => {
  const exists = async (key: string) => (await env.MEDIA.head(key)) !== null;
  const keysOf = async (mediaId: string) =>
    (await env.DB.prepare("SELECT original_key o, thumb_key t FROM media WHERE id = ?").bind(mediaId).first<{ o: string; t: string }>())!;

  it("returns 204 and the session stops working", async () => {
    const { token } = await signUp();
    expect((await api("DELETE", "/me", { token })).status).toBe(204);
    expect((await api("GET", "/me", { token })).status).toBe(401);
  });

  it("requires a session", async () => {
    expect((await api("DELETE", "/me")).status).toBe(401);
  });

  it("removes the user's media (files and rows) but keeps other members' media, before the reveal", async () => {
    const t = await newTrip();
    const u = await joinAs(t.code, "Cami");
    const mine = await uploadMedia(t.tripId, u.token);
    const theirs = await uploadMedia(t.tripId, t.adminToken);
    const myKeys = await keysOf(mine);
    const theirKeys = await keysOf(theirs);

    expect((await api("DELETE", "/me", { token: u.token })).status).toBe(204);

    expect(await exists(myKeys.o)).toBe(false);
    expect(await exists(myKeys.t)).toBe(false);
    expect(await env.DB.prepare("SELECT 1 FROM media WHERE id = ?").bind(mine).first()).toBeNull();
    expect(await exists(theirKeys.o)).toBe(true);
    const feed = await api("GET", `/trips/${t.tripId}/feed`, { token: t.adminToken });
    expect(feed.body.items.map((i: any) => i.id)).toEqual([theirs]);
    const detail = await api("GET", `/trips/${t.tripId}`, { token: t.adminToken });
    expect(detail.body.members.map((m: any) => m.userId)).toEqual([t.adminUserId]);
  });

  it("removes the user's media after the reveal too", async () => {
    const t = await newTrip();
    const u = await joinAs(t.code, "Cami");
    const mine = await uploadMedia(t.tripId, u.token);
    const theirs = await uploadMedia(t.tripId, t.adminToken);
    const myKeys = await keysOf(mine);
    await env.DB.prepare("UPDATE trips SET revealed_at = ? WHERE id = ?").bind(Date.now(), t.tripId).run();

    expect((await api("DELETE", "/me", { token: u.token })).status).toBe(204);

    expect(await exists(myKeys.o)).toBe(false);
    const feed = await api("GET", `/trips/${t.tripId}/feed`, { token: t.adminToken });
    expect(feed.body.items.map((i: any) => i.id)).toEqual([theirs]);
  });

  it("also cleans up rollos the user was removed from", async () => {
    const t = await newTrip();
    const u = await joinAs(t.code, "Cami");
    const mine = await uploadMedia(t.tripId, u.token);
    const myKeys = await keysOf(mine);
    expect((await api("DELETE", `/trips/${t.tripId}/members/${u.memberId}`, { token: t.adminToken })).status).toBe(204);

    expect((await api("DELETE", "/me", { token: u.token })).status).toBe(204);
    expect(await exists(myKeys.o)).toBe(false);
    expect(await env.DB.prepare("SELECT 1 FROM members WHERE user_id = ?").bind(u.userId).first()).toBeNull();
  });

  it("the oldest remaining active member becomes admin when the admin leaves", async () => {
    const t = await newTrip();
    const first = await joinAs(t.code, "Primero");
    const second = await joinAs(t.code, "Segundo");
    await env.DB.prepare("UPDATE members SET created_at = 1000 WHERE id = ?").bind(second.memberId).run();
    await env.DB.prepare("UPDATE members SET created_at = 2000 WHERE id = ?").bind(first.memberId).run();

    expect((await api("DELETE", "/me", { token: t.adminToken })).status).toBe(204);

    const detail = await api("GET", `/trips/${t.tripId}`, { token: second.token });
    expect(detail.body.me.role).toBe("admin");
    expect((await api("GET", `/trips/${t.tripId}`, { token: first.token })).body.me.role).toBe("member");
  });

  it("skips removed members when picking the next admin", async () => {
    const t = await newTrip();
    const removed = await joinAs(t.code, "Sacado");
    const stays = await joinAs(t.code, "Queda");
    await env.DB.prepare("UPDATE members SET created_at = 1000 WHERE id = ?").bind(removed.memberId).run();
    await api("DELETE", `/trips/${t.tripId}/members/${removed.memberId}`, { token: t.adminToken });

    await api("DELETE", "/me", { token: t.adminToken });
    expect((await api("GET", `/trips/${t.tripId}`, { token: stays.token })).body.me.role).toBe("admin");
  });

  it("deletes the whole rollo and its files when it was the only member", async () => {
    const t = await newTrip();
    const id = await uploadMedia(t.tripId, t.adminToken);
    const keys = await keysOf(id);

    expect((await api("DELETE", "/me", { token: t.adminToken })).status).toBe(204);

    expect(await exists(keys.o)).toBe(false);
    expect(await exists(keys.t)).toBe(false);
    expect(await env.DB.prepare("SELECT 1 FROM trips WHERE id = ?").bind(t.tripId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM media WHERE trip_id = ?").bind(t.tripId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM members WHERE trip_id = ?").bind(t.tripId).first()).toBeNull();
  });

  it("deletes the rollo when only removed members remain", async () => {
    const t = await newTrip();
    const gone = await joinAs(t.code, "Sacado");
    const id = await uploadMedia(t.tripId, gone.token);
    const keys = await keysOf(id);
    await api("DELETE", `/trips/${t.tripId}/members/${gone.memberId}`, { token: t.adminToken });

    await api("DELETE", "/me", { token: t.adminToken });
    expect(await env.DB.prepare("SELECT 1 FROM trips WHERE id = ?").bind(t.tripId).first()).toBeNull();
    expect(await exists(keys.o)).toBe(false);
  });

  it("deletes the avatar objects, sessions and login codes", async () => {
    const { token, userId, email } = await signUp();
    const { key } = await setAvatar(token, userId);
    await api("POST", "/me/avatar", { token });
    const pending = (await env.DB.prepare("SELECT pending_avatar_key k FROM users WHERE id = ?").bind(userId).first<{ k: string }>())!.k;
    await env.MEDIA.put(pending, "x");

    await api("DELETE", "/me", { token });

    expect(await exists(key)).toBe(false);
    expect(await exists(pending)).toBe(false);
    expect(await env.DB.prepare("SELECT 1 FROM sessions WHERE user_id = ?").bind(userId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM auth_codes WHERE email = ?").bind(email).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM users WHERE id = ?").bind(userId).first()).toBeNull();
  });

  it("the same email can sign up again as a brand-new user without rollos", async () => {
    const old = await signUp("again@rollo.test", "Otra vez");
    await createTrip(old.token);
    await api("DELETE", "/me", { token: old.token });

    // Bypass the per-email rate limit of the login flow.
    await env.DB.prepare("DELETE FROM auth_codes").run();
    const fresh = await signUp("again@rollo.test", null);
    expect(fresh.userId).not.toBe(old.userId);
    const me = await api("GET", "/me", { token: fresh.token });
    expect(me.body.name).toBeNull();
    expect((await api("GET", "/me/trips", { token: fresh.token })).body.trips).toEqual([]);
  });

  it("works for a member of several rollos", async () => {
    const a = await newTrip();
    const b = await newTrip();
    const u = await joinAs(a.code, "Cami");
    await join(b.code, u.token);
    await uploadMedia(a.tripId, u.token);
    await uploadMedia(b.tripId, u.token);

    expect((await api("DELETE", "/me", { token: u.token })).status).toBe(204);
    expect(await env.DB.prepare("SELECT 1 FROM media").first()).toBeNull();
    expect((await api("GET", `/trips/${a.tripId}`, { token: a.adminToken })).status).toBe(200);
  });
});

describe("DELETE /me with friends", () => {
  it("cleans friendships, links and claims; the friend keeps their rollos and loses only that friend", async () => {
    const t = await newTrip();
    const ana = await joinAs(t.code, "Ana");
    const beto = await joinAs(t.code, "Beto");
    const gone = await signUp(undefined, "Gone", "gone1");
    await befriend(gone.token, ana.token);
    await befriend(beto.token, gone.token);
    await befriend(ana.token, beto.token);
    const { body: link } = await api("POST", "/friends/link", { token: gone.token });
    await api("POST", "/friend-links/claim", { body: { code: link.code } });
    await api("POST", "/friends/redeem", { token: gone.token, body: { code: "ZZZZZZZZ" } }); // a failed attempt

    expect((await api("DELETE", "/me", { token: gone.token })).status).toBe(204);

    for (const [table, column] of [["friend_links", "user_id"], ["friend_claims", "link_user_id"]]) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).bind(gone.userId).first<{ n: number }>();
      expect(row!.n).toBe(0);
    }
    const mine = await env.DB.prepare("SELECT COUNT(*) AS n FROM friendships WHERE user_a = ? OR user_b = ?")
      .bind(gone.userId, gone.userId)
      .first<{ n: number }>();
    expect(mine!.n).toBe(0);
    const attempts = await env.DB.prepare("SELECT COUNT(*) AS n FROM friend_attempts WHERE key = ?").bind(`user:${gone.userId}`).first<{ n: number }>();
    expect(attempts!.n).toBe(0);

    // The friends are untouched: still friends between them, still in their rollo.
    expect((await api("GET", "/friends", { token: ana.token })).body.friends.map((f: any) => f.id)).toEqual([beto.userId]);
    expect((await api("GET", "/friends", { token: beto.token })).body.friends.map((f: any) => f.id)).toEqual([ana.userId]);
    expect((await api("GET", `/trips/${t.tripId}`, { token: ana.token })).status).toBe(200);
  });

  it("clears added_by on members this user added", async () => {
    const t = await newTrip();
    const adder = await joinAs(t.code, "Adder");
    const friend = await signUp(undefined, "Friend");
    await befriend(adder.token, friend.token);
    await api("POST", `/trips/${t.tripId}/members`, { token: adder.token, body: { friendIds: [friend.userId] } });
    await api("DELETE", "/me", { token: adder.token });
    const row = await env.DB.prepare("SELECT added_by_user_id a FROM members WHERE user_id = ?").bind(friend.userId).first<{ a: string | null }>();
    expect(row!.a).toBeNull();
    expect((await api("GET", `/trips/${t.tripId}`, { token: friend.token })).status).toBe(200);
  });

  it("someone who left doesn't count as active: the admin role goes to an active member", async () => {
    const t = await newTrip();
    const left = await joinAs(t.code, "Left");
    const stays = await joinAs(t.code, "Stays");
    await api("DELETE", `/trips/${t.tripId}/members/me`, { token: left.token });
    await api("DELETE", "/me", { token: t.adminToken });
    const detail = await api("GET", `/trips/${t.tripId}`, { token: stays.token });
    expect(detail.body.me.role).toBe("admin");
  });
});

describe("DELETE /me with moderation data", () => {
  it("deleting the account removes reports and blocks on both sides", async () => {
    const t = await newTrip();
    const a = await joinAs(t.code, "Ana");
    const b = await joinAs(t.code, "Beto");
    const mediaB = await uploadMedia(t.tripId, b.token);
    const mediaA = await uploadMedia(t.tripId, a.token);
    expect((await api("POST", "/reports", { token: a.token, body: { mediaId: mediaB, reason: "offensive" } })).status).toBe(204);
    expect((await api("PUT", `/blocks/${b.userId}`, { token: a.token })).status).toBe(204);
    expect((await api("POST", "/reports", { token: b.token, body: { mediaId: mediaA, reason: "abuse" } })).status).toBe(204);
    expect((await api("PUT", `/blocks/${a.userId}`, { token: b.token })).status).toBe(204);

    expect((await api("DELETE", "/me", { token: a.token })).status).toBe(204);
    const count = async (sql: string) => (await env.DB.prepare(sql).bind(a.userId, a.userId).first<{ n: number }>())!.n;
    expect(await count("SELECT COUNT(*) n FROM reports WHERE reporter_id = ? OR target_user_id = ?")).toBe(0);
    expect(await count("SELECT COUNT(*) n FROM blocks WHERE blocker_id = ? OR blocked_id = ?")).toBe(0);
  });
});
