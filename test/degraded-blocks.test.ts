import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEGRADED_MESSAGE, resetDegradedCache } from "../src/lib/degraded";
import { api, newTrip, photoBody, signUp, TZ, uploadMedia } from "./helpers";

// Earlier calls in the same test (newTrip, signUp) cache "off", so drop the cache after flipping the flag.
const turnOn = async () => {
  await env.DB.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('degraded_mode', '1', 0)").run();
  resetDegradedCache();
};
beforeEach(() => resetDegradedCache());

describe("degraded mode blocks", () => {
  it("registering a photo and requesting an avatar answer 503", async () => {
    const { tripId, adminToken } = await newTrip();
    await turnOn();
    const reg = await api("POST", `/trips/${tripId}/media`, { token: adminToken, body: photoBody() });
    expect(reg.status).toBe(503);
    expect(reg.body.error).toBe(DEGRADED_MESSAGE);
    const avatar = await api("POST", "/me/avatar", { token: adminToken, body: { sizeBytes: 1000 } });
    expect(avatar.status).toBe(503);
  });

  it("creating a rollo answers 503; viewing a feed still works", async () => {
    const { tripId, adminToken } = await newTrip();
    await uploadMedia(tripId, adminToken);
    await turnOn();
    const now = Date.now();
    const create = await api("POST", "/trips", {
      token: adminToken,
      body: { name: "Otro", timezone: TZ, startsAt: now + 3_600_000, endsAt: now + 7_200_000, revealAt: now + 10_800_000, dailyPhotoLimit: 2, dailyVideoLimit: 1 },
    });
    expect(create.status).toBe(503);
    expect((await api("GET", `/trips/${tripId}/feed`, { token: adminToken })).status).toBe(200);
  });

  it("login start: existing accounts get their code, new emails get 503", async () => {
    const existing = await signUp("ana@rollo.test");
    await turnOn();
    // signUp just asked for a code; move it back so the one-minute rate limit does not apply.
    await env.DB.prepare("UPDATE auth_codes SET created_at = created_at - 120000, expires_at = expires_at - 120000 WHERE email = ?").bind(existing.email).run();
    expect((await api("POST", "/auth/email/start", { body: { email: existing.email } })).status).toBe(204);
    const fresh = await api("POST", "/auth/email/start", { body: { email: "nueva@rollo.test" } });
    expect(fresh.status).toBe(503);
    expect(fresh.body.error).toBe(DEGRADED_MESSAGE);
  });

  it("login start: every 503 for a new email spends one of the IP's daily new-user slots; after 20 the answer is 204", async () => {
    await turnOn();
    const headers = { "cf-connecting-ip": "203.0.113.50" };
    const start = (email: string, h = headers) => api("POST", "/auth/email/start", { body: { email }, headers: h });
    for (let i = 0; i < 20; i++) expect((await start(`sonda${i}@rollo.test`)).status).toBe(503);
    expect((await start("sonda20@rollo.test")).status).toBe(204);
    // Another IP still gets the 503.
    expect((await start("sonda21@rollo.test", { "cf-connecting-ip": "203.0.113.51" })).status).toBe(503);
  });
});
