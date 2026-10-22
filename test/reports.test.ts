import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { devSentReports } from "../src/lib/email";
import { api, joinAs, newTrip, signUp, uploadMedia } from "./helpers";

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
