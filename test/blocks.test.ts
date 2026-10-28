import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { devSentBlocks } from "../src/lib/email";
import { hiddenMediaSql } from "../src/modules/reports/reports.repository";
import { photoWithMetadata } from "./jpeg-fixture";
import { api, befriend, joinAs, newTrip, signUp, uploadMedia } from "./helpers";

const friendsOf = async (token: string) => (await api("GET", "/friends", { token })).body.friends as any[];
const blockedOf = async (token: string) => (await api("GET", "/blocks", { token })).body.blocked as any[];

describe("blocks", () => {
  it("PUT /blocks/{id} blocks, removes the friendship and lists the user", async () => {
    const a = await signUp(undefined, "Ana");
    const b = await signUp(undefined, "Beto");
    await befriend(a.token, b.token);

    const res = await api("PUT", `/blocks/${b.userId}`, { token: a.token });
    expect(res.status).toBe(204);

    expect((await friendsOf(a.token)).map((f) => f.id)).not.toContain(b.userId);
    expect((await friendsOf(b.token)).map((f) => f.id)).not.toContain(a.userId);
    const blocked = await blockedOf(a.token);
    expect(blocked[0].id).toBe(b.userId);
    expect(blocked[0].name).toBe("Beto");
  });

  it("blocking is idempotent and one-directional", async () => {
    const a = await signUp();
    const b = await signUp();
    expect((await api("PUT", `/blocks/${b.userId}`, { token: a.token })).status).toBe(204);
    expect((await api("PUT", `/blocks/${b.userId}`, { token: a.token })).status).toBe(204);
    expect(await blockedOf(a.token)).toHaveLength(1);
    expect(await blockedOf(b.token)).toEqual([]);
  });

  it("unblocking one direction keeps the other", async () => {
    const a = await signUp();
    const b = await signUp();
    await api("PUT", `/blocks/${b.userId}`, { token: a.token });
    await api("PUT", `/blocks/${a.userId}`, { token: b.token });

    expect((await api("DELETE", `/blocks/${b.userId}`, { token: a.token })).status).toBe(204);
    expect(await blockedOf(a.token)).toEqual([]);
    expect((await blockedOf(b.token)).map((u) => u.id)).toEqual([a.userId]);
    // Unblocking someone you never blocked is still 204.
    expect((await api("DELETE", `/blocks/${b.userId}`, { token: a.token })).status).toBe(204);
  });

  it("lists blocked users by name", async () => {
    const a = await signUp();
    const z = await signUp(undefined, "Zoe");
    const m = await signUp(undefined, "Mati");
    await api("PUT", `/blocks/${z.userId}`, { token: a.token });
    await api("PUT", `/blocks/${m.userId}`, { token: a.token });
    expect((await blockedOf(a.token)).map((u) => u.name)).toEqual(["Mati", "Zoe"]);
  });

  it("cannot block yourself", async () => {
    const a = await signUp();
    const res = await api("PUT", `/blocks/${a.userId}`, { token: a.token });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("No podés bloquearte");
  });

  it("blocking an unknown user is a 404", async () => {
    const a = await signUp();
    expect((await api("PUT", `/blocks/${crypto.randomUUID()}`, { token: a.token })).status).toBe(404);
  });

  it("requires a session", async () => {
    expect((await api("GET", "/blocks")).status).toBe(401);
    expect((await api("PUT", `/blocks/${crypto.randomUUID()}`)).status).toBe(401);
    expect((await api("DELETE", `/blocks/${crypto.randomUUID()}`)).status).toBe(401);
  });
});

describe("hiddenMediaSql", () => {
  it("excludes media the viewer reported and media by authors the viewer blocked", async () => {
    const trip = await newTrip();
    const viewer = await joinAs(trip.code, "Viewer");
    const reported = await joinAs(trip.code, "Reported");
    const blockedAuthor = await joinAs(trip.code, "Blocked");
    const other = await joinAs(trip.code, "Other");
    const reportedId = await uploadMedia(trip.tripId, reported.token);
    const blockedId = await uploadMedia(trip.tripId, blockedAuthor.token);
    const otherId = await uploadMedia(trip.tripId, other.token);

    await env.DB.prepare(
      "INSERT INTO reports (id, reporter_id, media_id, target_user_id, trip_id, reason, created_at) VALUES (?, ?, ?, ?, ?, 'offensive', ?)",
    )
      .bind(crypto.randomUUID(), viewer.userId, reportedId, reported.userId, trip.tripId, Date.now())
      .run();
    await api("PUT", `/blocks/${blockedAuthor.userId}`, { token: viewer.token });

    const visibleTo = async (userId: string) => {
      const { results } = await env.DB.prepare(
        `SELECT m.id FROM media m JOIN members mem ON mem.id = m.member_id WHERE m.trip_id = ? AND ${hiddenMediaSql("m", "mem")}`,
      )
        .bind(trip.tripId, userId, userId)
        .all<{ id: string }>();
      return results.map((r) => r.id);
    };

    const forViewer = await visibleTo(viewer.userId);
    expect(forViewer).toContain(otherId);
    expect(forViewer).not.toContain(reportedId);
    expect(forViewer).not.toContain(blockedId);
    // Another user is unaffected.
    expect((await visibleTo(other.userId)).sort()).toEqual([reportedId, blockedId, otherId].sort());
  });
});

describe("blocks hide content", () => {
  const feedIds = async (token: string, tripId: string) =>
    ((await api("GET", `/trips/${tripId}/feed`, { token })).body.items as any[]).map((i) => i.id);

  it("the feed hides photos of people you blocked, only for you", async () => {
    const trip = await newTrip();
    const a = { token: trip.adminToken, userId: trip.adminUserId };
    const b = await joinAs(trip.code, "Beto");
    const c = await joinAs(trip.code, "Cami");
    const photo = await uploadMedia(trip.tripId, b.token);
    await api("PUT", `/blocks/${b.userId}`, { token: a.token });

    expect(await feedIds(a.token, trip.tripId)).not.toContain(photo);
    expect(await feedIds(c.token, trip.tripId)).toContain(photo);
  });

  it("the feed hides photos you reported", async () => {
    const trip = await newTrip();
    const b = await joinAs(trip.code, "Beto");
    const photo = await uploadMedia(trip.tripId, b.token);
    await env.DB.prepare(
      "INSERT INTO reports (id, reporter_id, media_id, target_user_id, trip_id, reason, created_at) VALUES (?, ?, ?, ?, ?, 'offensive', ?)",
    )
      .bind(crypto.randomUUID(), trip.adminUserId, photo, b.userId, trip.tripId, Date.now())
      .run();
    expect(await feedIds(trip.adminToken, trip.tripId)).not.toContain(photo);
    expect(await feedIds(b.token, trip.tripId)).toContain(photo);
  });

  it("members show blockedByMe for the viewer", async () => {
    const trip = await newTrip();
    const b = await joinAs(trip.code, "Beto");
    const c = await joinAs(trip.code, "Cami");
    await api("PUT", `/blocks/${b.userId}`, { token: trip.adminToken });

    const members = async (token: string) => (await api("GET", `/trips/${trip.tripId}`, { token })).body.members as any[];
    const forA = await members(trip.adminToken);
    expect(forA.find((m) => m.userId === b.userId).blockedByMe).toBe(true);
    expect(forA.find((m) => m.userId === c.userId).blockedByMe).toBe(false);
    expect((await members(c.token)).find((m) => m.userId === b.userId).blockedByMe).toBe(false);
  });

  it("a blocker's profile is private to the blocked user", async () => {
    const a = await signUp(undefined, "Ana");
    const b = await signUp(undefined, "Beto");
    await env.DB.prepare("UPDATE users SET profile_visibility = 'public' WHERE id = ?").bind(a.userId).run();
    await befriend(a.token, b.token);
    await api("PUT", `/blocks/${b.userId}`, { token: a.token });

    const res = await api("GET", `/users/${a.userId}`, { token: b.token });
    expect(res.body.canSee).toBe(false);
    expect(res.body.isFriend).toBe(false);
    expect((await api("GET", `/users/${a.userId}/featured`, { token: b.token })).status).toBe(403);
    // The blocker cannot see the blocked user's featured photos either.
    expect((await api("GET", `/users/${b.userId}/featured`, { token: a.token })).status).toBe(403);
  });

  it("profile shows blockedByMe and reportedByMe", async () => {
    const a = await signUp();
    const b = await signUp();
    const before = await api("GET", `/users/${b.userId}`, { token: a.token });
    expect(before.body.blockedByMe).toBe(false);
    expect(before.body.reportedByMe).toBe(false);

    await api("PUT", `/blocks/${b.userId}`, { token: a.token });
    await env.DB.prepare(
      "INSERT INTO reports (id, reporter_id, media_id, target_user_id, trip_id, reason, created_at) VALUES (?, ?, NULL, ?, NULL, 'abuse', ?)",
    )
      .bind(crypto.randomUUID(), a.userId, b.userId, Date.now())
      .run();
    const after = await api("GET", `/users/${b.userId}`, { token: a.token });
    expect(after.body.blockedByMe).toBe(true);
    expect(after.body.reportedByMe).toBe(true);
    // Neither flag leaks to the other side.
    const other = await api("GET", `/users/${a.userId}`, { token: b.token });
    expect(other.body.blockedByMe).toBe(false);
    expect(other.body.reportedByMe).toBe(false);
  });

  it("featured lists hide photos by authors you blocked", async () => {
    const trip = await newTrip({ dailyPhotoLimit: 10 });
    const a = { token: trip.adminToken, userId: trip.adminUserId };
    const b = await joinAs(trip.code, "Beto");
    const c = await joinAs(trip.code, "Cami");
    const d = await joinAs(trip.code, "Dani");
    const photo = await uploadMedia(trip.tripId, b.token);
    const own = await uploadMedia(trip.tripId, a.token);
    await env.MEDIA.put(`trips/${trip.tripId}/${photo}/thumb.jpg`, photoWithMetadata("x", "Beto"));
    await api("POST", `/trips/${trip.tripId}/reveal`, { token: a.token });
    await befriend(a.token, b.token);
    await api("PUT", `/me/featured/${photo}`, { token: a.token });
    await api("PUT", `/me/featured/${own}`, { token: a.token });
    for (const u of [c, d]) await befriend(a.token, u.token);
    await api("PUT", `/blocks/${b.userId}`, { token: c.token });

    const listFor = async (token: string) =>
      ((await api("GET", `/users/${a.userId}/featured`, { token })).body.photos as any[]).map((p) => p.mediaId);
    expect(await listFor(c.token)).toEqual([own]);
    expect((await listFor(d.token)).sort()).toEqual([photo, own].sort());

    const file = (token: string) => api("GET", `/featured/${a.userId}/${photo}/thumb`, { token });
    expect((await file(c.token)).status).toBe(404);
    expect((await file(d.token)).status).toBe(200);
  });
});

describe("blocks and friend links", () => {
  it("a blocked user cannot redeem the blocker's friend link", async () => {
    const a = await signUp();
    const b = await signUp();
    const invalid = await api("POST", "/friends/redeem", { token: b.token, body: { code: "ZZZZZZZZ" } });
    const { body: link } = await api("POST", "/friends/link", { token: a.token });
    const claim = await api("POST", "/friend-links/claim", { body: { code: link.code } });
    await api("PUT", `/blocks/${b.userId}`, { token: a.token });

    const byCode = await api("POST", "/friends/redeem", { token: b.token, body: { code: link.code } });
    expect(byCode.status).toBe(400);
    expect(byCode.body).toEqual(invalid.body);
    const byToken = await api("POST", "/friends/redeem", { token: b.token, body: { claimToken: claim.body.claimToken } });
    expect(byToken.status).toBe(400);
    expect(byToken.body).toEqual(invalid.body);
    expect(await friendsOf(a.token)).toEqual([]);
    expect(await friendsOf(b.token)).toEqual([]);
  });

  it("the blocker cannot redeem the blocked user's friend link either", async () => {
    const a = await signUp();
    const b = await signUp();
    await api("PUT", `/blocks/${b.userId}`, { token: a.token });
    const { body: link } = await api("POST", "/friends/link", { token: b.token });
    const res = await api("POST", "/friends/redeem", { token: a.token, body: { code: link.code } });
    expect(res.status).toBe(400);
  });
});

describe("blocked pair sees a header-only profile", () => {
  it("returns no friends and no mutual count, in both directions", async () => {
    const a = await signUp(undefined, "Ana");
    const b = await signUp(undefined, "Beto");
    const common = await signUp(undefined, "Comun");
    await befriend(a.token, common.token);
    await befriend(b.token, common.token);
    const before = await api("GET", `/users/${b.userId}`, { token: a.token });
    expect(before.body.mutualCount).toBe(1);
    await api("PUT", `/blocks/${a.userId}`, { token: b.token });

    for (const [viewer, owner] of [[a, b], [b, a]] as const) {
      const friends = await api("GET", `/users/${owner.userId}/friends`, { token: viewer.token });
      expect(friends.status).toBe(200);
      expect(friends.body).toEqual({ scope: "mutual", friends: [] });
      const profile = await api("GET", `/users/${owner.userId}`, { token: viewer.token });
      expect(profile.body.mutualCount).toBe(0);
      expect(profile.body.friendCount).toBe(1);
      expect(profile.body.canSee).toBe(false);
    }
  });
});

describe("blocking and featured photos / emails", () => {
  it("blocking removes the blocked author's photos from the blocker's featured list", async () => {
    const trip = await newTrip({ dailyPhotoLimit: 10 });
    const a = { token: trip.adminToken, userId: trip.adminUserId };
    const b = await joinAs(trip.code, "Beto");
    const d = await joinAs(trip.code, "Dani");
    const photo = await uploadMedia(trip.tripId, b.token);
    const own = await uploadMedia(trip.tripId, a.token);
    await env.MEDIA.put(`trips/${trip.tripId}/${photo}/thumb.jpg`, photoWithMetadata("x", "Beto"));
    await env.MEDIA.put(`trips/${trip.tripId}/${own}/thumb.jpg`, photoWithMetadata("x", "Ana"));
    await api("POST", `/trips/${trip.tripId}/reveal`, { token: a.token });
    await befriend(a.token, b.token);
    await api("PUT", `/me/featured/${photo}`, { token: a.token });
    await api("PUT", `/me/featured/${own}`, { token: a.token });
    await befriend(a.token, d.token);

    await api("PUT", `/blocks/${b.userId}`, { token: a.token });
    const list = ((await api("GET", `/users/${a.userId}/featured`, { token: d.token })).body.photos as any[]).map((p) => p.mediaId);
    expect(list).toEqual([own]);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM featured WHERE user_id = ?").bind(a.userId).first<{ n: number }>();
    expect(row!.n).toBe(1);
  });

  it("a new block emails support once; repeating it does not", async () => {
    devSentBlocks.length = 0;
    const a = await signUp(undefined, "Ana", "ana_b");
    const b = await signUp(undefined, "Beto", null);
    await api("PUT", `/blocks/${b.userId}`, { token: a.token });
    await api("PUT", `/blocks/${b.userId}`, { token: a.token });
    expect(devSentBlocks).toHaveLength(1);
    expect(devSentBlocks[0]!.blocker.id).toBe(a.userId);
    expect(devSentBlocks[0]!.blocked.id).toBe(b.userId);
    expect(devSentBlocks[0]!.adminBase).toBe("https://rollo.test");
  });

  it("the block email has the exact subject, the delete command and survives a Resend failure", async () => {
    const realFetch = globalThis.fetch;
    const a = await signUp(undefined, "Ana", "ana_c");
    const b = await signUp(undefined, "Beto", null);
    let sent: any;
    let fail = false;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : (input.url ?? String(input));
      if (url.startsWith("https://api.resend.com")) {
        sent = JSON.parse(init.body);
        return new Response("boom", { status: fail ? 500 : 200 });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const res = await api("PUT", `/blocks/${b.userId}`, { token: a.token, env: { RESEND_API_KEY: "x" } });
      expect(res.status).toBe(204);
      expect(sent.subject).toBe("Bloqueo en Rollo: @ana_c bloqueó a Beto");
      expect(sent.text).toContain(`/admin/users/${b.userId}`);
      expect(sent.text).toContain("$ROLLO_ADMIN_TOKEN");

      fail = true;
      const c = await signUp();
      const res2 = await api("PUT", `/blocks/${c.userId}`, { token: a.token, env: { RESEND_API_KEY: "x" } });
      expect(res2.status).toBe(204);
      expect((await blockedOf(a.token)).map((u) => u.id)).toContain(c.userId);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("GET /me/trips cover ignores photos by authors you blocked", async () => {
    const trip = await newTrip({ dailyPhotoLimit: 10 });
    const b = await joinAs(trip.code, "Beto");
    await uploadMedia(trip.tripId, trip.adminToken, { takenAt: Date.now() - 3 * 3600_000, thumbhash: "b2xkZXN0" });
    await uploadMedia(trip.tripId, b.token, { takenAt: Date.now() - 3600_000, thumbhash: "bmV3ZXN0" });
    expect((await api("GET", "/me/trips", { token: trip.adminToken })).body.trips[0].coverThumbhash).toBe("bmV3ZXN0");
    await api("PUT", `/blocks/${b.userId}`, { token: trip.adminToken });
    expect((await api("GET", "/me/trips", { token: trip.adminToken })).body.trips[0].coverThumbhash).toBe("b2xkZXN0");
  });
});
