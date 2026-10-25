import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getNotificationSettings } from "../src/lib/settings";
import { DAY, api, join, logIn, newTrip, signUp, uploadMedia } from "./helpers";

const TOKEN = "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]";
const path = (token: string) => `/me/push-tokens/${encodeURIComponent(token)}`;

async function tokensOf(userId: string) {
  const { results } = await env.DB.prepare("SELECT token FROM push_tokens WHERE user_id = ? ORDER BY token")
    .bind(userId)
    .all<{ token: string }>();
  return results.map((r) => r.token);
}

describe("PUT /me/push-tokens/{token}", () => {
  it("registers the token for the user", async () => {
    const u = await signUp();
    const res = await api("PUT", path(TOKEN), { token: u.token });
    expect(res.status).toBe(204);
    expect(await tokensOf(u.userId)).toEqual([TOKEN]);
  });

  it("accepts the ExpoPushToken prefix too", async () => {
    const u = await signUp();
    const token = "ExpoPushToken[abc123]";
    expect((await api("PUT", path(token), { token: u.token })).status).toBe(204);
    expect(await tokensOf(u.userId)).toEqual([token]);
  });

  it("is idempotent and refreshes last_seen_at", async () => {
    const u = await signUp();
    await api("PUT", path(TOKEN), { token: u.token });
    await env.DB.prepare("UPDATE push_tokens SET last_seen_at = 1 WHERE token = ?").bind(TOKEN).run();
    expect((await api("PUT", path(TOKEN), { token: u.token })).status).toBe(204);
    const row = await env.DB.prepare("SELECT COUNT(*) n, MAX(last_seen_at) seen FROM push_tokens").first<{ n: number; seen: number }>();
    expect(row!.n).toBe(1);
    expect(row!.seen).toBeGreaterThan(Date.now() - 60_000);
  });

  it("a user can have several devices", async () => {
    const u = await signUp();
    const other = "ExponentPushToken[second]";
    await api("PUT", path(TOKEN), { token: u.token });
    await api("PUT", path(other), { token: u.token });
    expect(await tokensOf(u.userId)).toEqual([TOKEN, other].sort());
  });

  it("moves the token to the account that registers it last (same phone, another account)", async () => {
    const a = await signUp();
    const b = await signUp();
    await api("PUT", path(TOKEN), { token: a.token });
    expect((await api("PUT", path(TOKEN), { token: b.token })).status).toBe(204);
    expect(await tokensOf(a.userId)).toEqual([]);
    expect(await tokensOf(b.userId)).toEqual([TOKEN]);
  });

  it("binds the token to the session that registered it, and re-registering from another session moves it", async () => {
    const u = await signUp();
    const second = await logIn(u.email);
    await api("PUT", path(TOKEN), { token: u.token });
    await api("PUT", path(TOKEN), { token: second });
    // The first session logs out: the token now belongs to the second one and survives.
    expect((await api("POST", "/auth/logout", { token: u.token })).status).toBe(204);
    expect(await tokensOf(u.userId)).toEqual([TOKEN]);
  });

  it("rejects anything that is not an Expo push token", async () => {
    const u = await signUp();
    for (const bad of ["abc", "ExponentPushToken[]", "ExponentPushToken[abc", "FooPushToken[abc]", `${TOKEN}x`, "ExponentPushToken[a b]"]) {
      expect((await api("PUT", path(bad), { token: u.token })).status, bad).toBe(400);
    }
    expect(await tokensOf(u.userId)).toEqual([]);
  });

  it("rejects a token longer than 200 characters", async () => {
    const u = await signUp();
    const long = `ExponentPushToken[${"a".repeat(200 - 19)}]`;
    expect(long.length).toBe(200);
    expect((await api("PUT", path(long), { token: u.token })).status).toBe(204);
    const tooLong = `ExponentPushToken[${"a".repeat(201 - 19)}]`;
    expect((await api("PUT", path(tooLong), { token: u.token })).status).toBe(400);
    expect(await tokensOf(u.userId)).toEqual([long]);
  });

  it("requires a session", async () => {
    expect((await api("PUT", path(TOKEN))).status).toBe(401);
  });
});

describe("POST /auth/logout and push tokens", () => {
  it("deletes the tokens of that session, even if the app never called DELETE (offline logout)", async () => {
    const u = await signUp();
    const otherPhone = await logIn(u.email);
    const other = "ExponentPushToken[otherphone]";
    await api("PUT", path(TOKEN), { token: u.token });
    await api("PUT", path(other), { token: otherPhone });

    expect((await api("POST", "/auth/logout", { token: u.token })).status).toBe(204);

    expect(await tokensOf(u.userId)).toEqual([other]);
  });
});

describe("DELETE /me/push-tokens/{token}", () => {
  it("removes the token", async () => {
    const u = await signUp();
    await api("PUT", path(TOKEN), { token: u.token });
    expect((await api("DELETE", path(TOKEN), { token: u.token })).status).toBe(204);
    expect(await tokensOf(u.userId)).toEqual([]);
  });

  it("is idempotent", async () => {
    const u = await signUp();
    expect((await api("DELETE", path(TOKEN), { token: u.token })).status).toBe(204);
  });

  it("does not remove someone else's token", async () => {
    const a = await signUp();
    const b = await signUp();
    await api("PUT", path(TOKEN), { token: a.token });
    expect((await api("DELETE", path(TOKEN), { token: b.token })).status).toBe(204);
    expect(await tokensOf(a.userId)).toEqual([TOKEN]);
  });

  it("rejects a malformed token", async () => {
    const u = await signUp();
    expect((await api("DELETE", path("nope"), { token: u.token })).status).toBe(400);
  });

  it("requires a session", async () => {
    expect((await api("DELETE", path(TOKEN))).status).toBe(401);
  });
});

const ALL_ON = {
  addedToTrip: true,
  newFriend: true,
  tripStarted: true,
  tripRevealed: true,
  photoFeatured: true,
  photoLiked: true,
  photoCommented: true,
};

describe("GET /me/settings", () => {
  it("returns every notification on by default (no row)", async () => {
    const u = await signUp();
    const res = await api("GET", "/me/settings", { token: u.token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ notifications: ALL_ON });
  });

  it("requires a session", async () => {
    expect((await api("GET", "/me/settings")).status).toBe(401);
  });
});

describe("PATCH /me/settings", () => {
  it("changes only the keys sent and returns the full settings", async () => {
    const u = await signUp();
    const res = await api("PATCH", "/me/settings", { token: u.token, body: { notifications: { photoLiked: false } } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ notifications: { ...ALL_ON, photoLiked: false } });

    const again = await api("PATCH", "/me/settings", { token: u.token, body: { notifications: { tripStarted: false, photoLiked: true } } });
    expect(again.body).toEqual({ notifications: { ...ALL_ON, tripStarted: false } });
    expect((await api("GET", "/me/settings", { token: u.token })).body).toEqual({ notifications: { ...ALL_ON, tripStarted: false } });
  });

  it("an empty patch changes nothing", async () => {
    const u = await signUp();
    expect((await api("PATCH", "/me/settings", { token: u.token, body: {} })).body).toEqual({ notifications: ALL_ON });
    expect((await api("PATCH", "/me/settings", { token: u.token, body: { notifications: {} } })).body).toEqual({ notifications: ALL_ON });
  });

  it("only changes your own settings", async () => {
    const a = await signUp();
    const b = await signUp();
    await api("PATCH", "/me/settings", { token: a.token, body: { notifications: { newFriend: false } } });
    expect((await api("GET", "/me/settings", { token: b.token })).body).toEqual({ notifications: ALL_ON });
  });

  it("rejects unknown keys and wrong types", async () => {
    const u = await signUp();
    for (const body of [
      { notifications: { nope: true } },
      { notifications: { photoLiked: "no" } },
      { notifications: { photoLiked: 0 } },
      { notifications: { photoLiked: null } },
      { notifications: true },
      { other: 1 },
    ]) {
      expect((await api("PATCH", "/me/settings", { token: u.token, body })).status, JSON.stringify(body)).toBe(400);
    }
    expect((await api("GET", "/me/settings", { token: u.token })).body).toEqual({ notifications: ALL_ON });
  });

  it("requires a session", async () => {
    expect((await api("PATCH", "/me/settings", { body: {} })).status).toBe(401);
  });
});

describe("getNotificationSettings", () => {
  it("returns defaults for users without a row and the stored values otherwise", async () => {
    const a = await signUp();
    const b = await signUp();
    await api("PATCH", "/me/settings", { token: b.token, body: { notifications: { addedToTrip: false, photoFeatured: false } } });
    const map = await getNotificationSettings(env.DB, [a.userId, b.userId]);
    expect(map.get(a.userId)).toEqual(ALL_ON);
    expect(map.get(b.userId)).toEqual({ ...ALL_ON, addedToTrip: false, photoFeatured: false });
  });

  it("handles an empty list and unknown ids (defaults)", async () => {
    expect((await getNotificationSettings(env.DB, [])).size).toBe(0);
    expect((await getNotificationSettings(env.DB, ["missing"])).get("missing")).toEqual(ALL_ON);
  });
});

describe("DELETE /me cleans notification data", () => {
  it("removes push tokens, settings and likes of the account", async () => {
    const t = await newTrip();
    const u = await signUp();
    await api("PUT", path(TOKEN), { token: u.token });
    await api("PATCH", "/me/settings", { token: u.token, body: { notifications: { photoLiked: false } } });
    const mediaId = await uploadMedia(t.tripId, t.adminToken);
    await env.DB.prepare("INSERT INTO likes (user_id, media_id, created_at) VALUES (?, ?, ?)").bind(u.userId, mediaId, Date.now()).run();

    expect((await api("DELETE", "/me", { token: u.token })).status).toBe(204);
    const count = async (sql: string) => (await env.DB.prepare(sql).bind(u.userId).first<{ n: number }>())!.n;
    expect(await count("SELECT COUNT(*) n FROM push_tokens WHERE user_id = ?")).toBe(0);
    expect(await count("SELECT COUNT(*) n FROM user_settings WHERE user_id = ?")).toBe(0);
    expect(await count("SELECT COUNT(*) n FROM likes WHERE user_id = ?")).toBe(0);
  });
});

describe("DELETE /me removes likes on the account's photos", () => {
  it("other users' likes on its photos go away with the photos", async () => {
    const t = await newTrip();
    const u = await signUp();
    const author = await signUp();
    await join(t.code, author.token);
    const mediaId = await uploadMedia(t.tripId, author.token);
    await env.DB.prepare("INSERT INTO likes (user_id, media_id, created_at) VALUES (?, ?, ?)").bind(u.userId, mediaId, Date.now()).run();
    expect((await api("DELETE", "/me", { token: author.token })).status).toBe(204);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM likes WHERE media_id = ?").bind(mediaId).first<{ n: number }>())!.n).toBe(0);
  });
});

describe("migration 0012", () => {
  it("adds the anti-spam columns to media with empty defaults", async () => {
    const t = await newTrip();
    const mediaId = await uploadMedia(t.tripId, t.adminToken);
    const row = await env.DB.prepare("SELECT like_notified_at, likes_since_notified FROM media WHERE id = ?").bind(mediaId).first();
    expect(row).toEqual({ like_notified_at: null, likes_since_notified: 0 });
  });

  it("marks trips that already started or revealed as notified, and leaves the rest alone", async () => {
    const now = Date.now();
    const started = await newTrip({ startsAt: now - DAY, endsAt: now + DAY, revealAt: now + 2 * DAY });
    const revealed = await newTrip({ startsAt: now - 3 * DAY, endsAt: now - 2 * DAY, revealAt: now - DAY });
    const manual = await newTrip({ startsAt: now - DAY, endsAt: now + DAY, revealAt: now + 2 * DAY });
    await env.DB.prepare("UPDATE trips SET revealed_at = ? WHERE id = ?").bind(now, manual.tripId).run();
    const future = await newTrip({ startsAt: now + DAY, endsAt: now + 2 * DAY, revealAt: now + 3 * DAY });

    // Re-run the backfill statements of the migration against existing data.
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0012"))!;
    const updates = migration.queries.filter((q) => /\bUPDATE\s+trips\b/i.test(q));
    expect(updates.length).toBeGreaterThan(0);
    for (const q of updates) await env.DB.prepare(q).run();

    const get = async (id: string) =>
      (await env.DB.prepare("SELECT started_notified_at s, revealed_notified_at r FROM trips WHERE id = ?").bind(id).first<{ s: number | null; r: number | null }>())!;
    expect(await get(started.tripId)).toEqual({ s: expect.any(Number), r: null });
    expect(await get(revealed.tripId)).toEqual({ s: expect.any(Number), r: expect.any(Number) });
    expect(await get(manual.tripId)).toEqual({ s: expect.any(Number), r: expect.any(Number) });
    expect(await get(future.tripId)).toEqual({ s: null, r: null });
  });
});
