import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { devSentBlocks, devSentReports } from "../src/lib/email";
import { photoWithMetadata } from "./jpeg-fixture";
import { api, befriend, joinAs, newTrip, signUp, uploadMedia } from "./helpers";

async function setup() {
  const trip = await newTrip();
  const a = await joinAs(trip.code, "Ana");
  const b = await joinAs(trip.code, "Beto");
  const mediaId = await uploadMedia(trip.tripId, b.token);
  return { trip, a, b, mediaId };
}

const feedIds = async (tripId: string, token: string) =>
  (await api("GET", `/trips/${tripId}/feed`, { token })).body.items.map((i: any) => i.id);

describe("POST /reports", () => {
  beforeEach(() => {
    devSentReports.length = 0;
  });

  it("reporting a photo hides it from the reporter's feed and emails support", async () => {
    const { trip, a, b, mediaId } = await setup();
    const res = await api("POST", "/reports", { token: a.token, body: { mediaId, reason: "offensive" } });
    expect(res.status).toBe(204);
    expect(await feedIds(trip.tripId, a.token)).not.toContain(mediaId);
    expect(await feedIds(trip.tripId, b.token)).toContain(mediaId);
    expect(devSentReports).toHaveLength(1);
    expect(devSentReports[0]!.media?.id).toBe(mediaId);
    expect(devSentReports[0]!.reporter.id).toBe(a.userId);
    expect(devSentReports[0]!.target.id).toBe(b.userId);
    expect(devSentReports[0]!.adminBase).toBe("https://rollo.test");
  });

  it("reporting twice sends one email", async () => {
    const { a, mediaId } = await setup();
    const body = { mediaId, reason: "offensive" };
    expect((await api("POST", "/reports", { token: a.token, body })).status).toBe(204);
    expect((await api("POST", "/reports", { token: a.token, body })).status).toBe(204);
    expect(devSentReports).toHaveLength(1);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE media_id = ?").bind(mediaId).first<{ n: number }>();
    expect(rows!.n).toBe(1);
  });

  it("reporting a person sets reportedByMe and does not hide them", async () => {
    const { trip, a, b, mediaId } = await setup();
    const res = await api("POST", "/reports", { token: a.token, body: { userId: b.userId, reason: "abuse" } });
    expect(res.status).toBe(204);
    expect((await api("GET", `/users/${b.userId}`, { token: a.token })).body.reportedByMe).toBe(true);
    expect(await feedIds(trip.tripId, a.token)).toContain(mediaId);
    expect(devSentReports).toHaveLength(1);
    expect(devSentReports[0]!.media).toBeUndefined();
    expect(devSentReports[0]!.trip).toBeUndefined();
  });

  it("cannot report your own photo or yourself", async () => {
    const { b, mediaId } = await setup();
    expect((await api("POST", "/reports", { token: b.token, body: { mediaId, reason: "other" } })).status).toBe(400);
    expect((await api("POST", "/reports", { token: b.token, body: { userId: b.userId, reason: "other" } })).status).toBe(400);
    expect(devSentReports).toHaveLength(0);
  });

  it("cannot report a photo from another roll", async () => {
    const { mediaId } = await setup();
    const stranger = await signUp();
    expect((await api("POST", "/reports", { token: stranger.token, body: { mediaId, reason: "other" } })).status).toBe(404);
    expect(devSentReports).toHaveLength(0);
  });

  it("404 for a missing photo or user", async () => {
    const { a } = await setup();
    expect((await api("POST", "/reports", { token: a.token, body: { mediaId: crypto.randomUUID(), reason: "other" } })).status).toBe(404);
    expect((await api("POST", "/reports", { token: a.token, body: { userId: crypto.randomUUID(), reason: "other" } })).status).toBe(404);
  });

  it("rejects mediaId and userId together, neither, and unknown reasons", async () => {
    const { a, b, mediaId } = await setup();
    expect((await api("POST", "/reports", { token: a.token, body: { mediaId, userId: b.userId, reason: "abuse" } })).status).toBe(400);
    expect((await api("POST", "/reports", { token: a.token, body: { reason: "abuse" } })).status).toBe(400);
    expect((await api("POST", "/reports", { token: a.token, body: { mediaId, reason: "spam" } })).status).toBe(400);
  });

  it("requires a session", async () => {
    expect((await api("POST", "/reports", { body: { userId: crypto.randomUUID(), reason: "abuse" } })).status).toBe(401);
  });
});

describe("report emails", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("a failing email still records the report", async () => {
    const { a, mediaId } = await setup();
    let calls = 0;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : (input.url ?? String(input));
      if (url.startsWith("https://api.resend.com")) {
        calls++;
        return new Response("boom", { status: 500 });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    const res = await api("POST", "/reports", { token: a.token, body: { mediaId, reason: "offensive" }, env: { RESEND_API_KEY: "x" } });
    expect(res.status).toBe(204);
    expect(calls).toBe(1);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE media_id = ?").bind(mediaId).first<{ n: number }>();
    expect(row!.n).toBe(1);
  });
});

describe("report email cap", () => {
  it("emails at most 3 moderation emails per reporter per 24 hours but still stores the rest", async () => {
    devSentReports.length = 0;
    const trip = await newTrip({ dailyPhotoLimit: 20 });
    const a = await joinAs(trip.code, "Ana");
    const b = await joinAs(trip.code, "Beto");
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) ids.push(await uploadMedia(trip.tripId, b.token));
    for (const mediaId of ids) {
      expect((await api("POST", "/reports", { token: a.token, body: { mediaId, reason: "other" } })).status).toBe(204);
    }
    expect(devSentReports).toHaveLength(3);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ?").bind(a.userId).first<{ n: number }>();
    expect(row!.n).toBe(11);
  });

  it("counts blocks toward the same cap and ignores rows older than 24 hours", async () => {
    devSentReports.length = 0;
    devSentBlocks.length = 0;
    const a = await signUp();
    const old = Date.now() - 25 * 60 * 60 * 1000;
    for (let i = 0; i < 10; i++) {
      await env.DB.prepare("INSERT INTO reports (id, reporter_id, media_id, target_user_id, trip_id, reason, created_at) VALUES (?, ?, NULL, ?, NULL, 'other', ?)")
        .bind(crypto.randomUUID(), a.userId, (await signUp()).userId, old)
        .run();
    }
    const b = await signUp();
    expect((await api("PUT", `/blocks/${b.userId}`, { token: a.token })).status).toBe(204);
    expect(devSentBlocks).toHaveLength(1);
    for (let i = 0; i < 2; i++) {
      const u = await signUp();
      await api("PUT", `/blocks/${u.userId}`, { token: a.token });
    }
    expect(devSentBlocks).toHaveLength(3);
    const extra = await signUp();
    expect((await api("PUT", `/blocks/${extra.userId}`, { token: a.token })).status).toBe(204);
    expect(devSentBlocks).toHaveLength(3);
    expect((await api("GET", "/blocks", { token: a.token })).body.blocked).toHaveLength(4);
  });
});

describe("featured photos and reports", () => {
  it("a reported photo leaves the reporter's featured list", async () => {
    const trip = await newTrip({ dailyPhotoLimit: 10 });
    const a = { token: trip.adminToken, userId: trip.adminUserId };
    const b = await joinAs(trip.code, "Beto");
    const c = await joinAs(trip.code, "Cami");
    const photo = await uploadMedia(trip.tripId, b.token);
    await env.MEDIA.put(`trips/${trip.tripId}/${photo}/thumb.jpg`, photoWithMetadata("x", "Beto"));
    await api("POST", `/trips/${trip.tripId}/reveal`, { token: a.token });
    await api("PUT", `/me/featured/${photo}`, { token: a.token });
    await befriend(a.token, c.token);
    const list = async () => ((await api("GET", `/users/${a.userId}/featured`, { token: c.token })).body.photos as any[]).map((p) => p.mediaId);
    expect(await list()).toEqual([photo]);

    await api("POST", "/reports", { token: a.token, body: { mediaId: photo, reason: "offensive" } });
    expect(await list()).toEqual([]);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM featured WHERE user_id = ?").bind(a.userId).first<{ n: number }>();
    expect(row!.n).toBe(0);
  });
});

describe("report email contents", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("puts the admin commands first with a literal $ROLLO_ADMIN_TOKEN and never leaks ADMIN_TOKEN", async () => {
    const { a, b, mediaId } = await setup();
    await api("PATCH", `/me`, { token: b.token, body: { username: "beto_x" } });
    let sent: any;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : (input.url ?? String(input));
      if (url.startsWith("https://api.resend.com")) {
        sent = JSON.parse(init.body);
        return new Response("{}", { status: 200 });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    await api("POST", "/reports", {
      token: a.token,
      body: { mediaId, reason: "offensive" },
      env: { RESEND_API_KEY: "x", ADMIN_TOKEN: "super-secret-admin-value" },
    });
    expect(sent.subject).toBe("Denuncia en Rollo: foto de @beto_x");
    expect(sent.text).toContain(`curl -X DELETE -H "Authorization: Bearer $ROLLO_ADMIN_TOKEN" https://rollo.test/admin/media/${mediaId}`);
    expect(sent.text).toContain(`https://rollo.test/admin/users/${b.userId}`);
    expect(JSON.stringify(sent)).not.toContain("super-secret-admin-value");
    // Commands come before any user-provided text, and the caption is quoted.
    expect(sent.text.indexOf("curl")).toBeLessThan(sent.text.indexOf("Epígrafe"));
    expect(sent.text).toContain('Epígrafe: "no puedo creer este viento"');
  });
});
