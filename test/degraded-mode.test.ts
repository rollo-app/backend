import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { isDegraded, resetDegradedCache } from "../src/lib/degraded";
import { api, makeSuperadmin, signUp } from "./helpers";

beforeEach(() => resetDegradedCache());

describe("degraded mode switch", () => {
  it("is off by default and the superadmin can turn it on and off", async () => {
    const su = await makeSuperadmin();
    expect((await api("GET", "/admin/degraded-mode", { token: su.token })).body).toEqual({ on: false, updatedAt: null, updatedBy: null });
    const on = await api("PUT", "/admin/degraded-mode", { token: su.token, body: { on: true } });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ on: true, updatedBy: { id: su.userId, email: su.email } });
    expect(typeof on.body.updatedAt).toBe("number");
    expect(await isDegraded(env)).toBe(true);
    expect((await api("PUT", "/admin/degraded-mode", { token: su.token, body: { on: false } })).body.on).toBe(false);
    expect(await isDegraded(env)).toBe(false);
  });

  it("a plain user cannot read or change it", async () => {
    const { token } = await signUp();
    expect((await api("GET", "/admin/degraded-mode", { token })).status).toBe(404);
    expect((await api("PUT", "/admin/degraded-mode", { token, body: { on: true } })).status).toBe(404);
  });

  it("caches the flag for 60 s and refreshes after", async () => {
    expect(await isDegraded(env, 1_000_000)).toBe(false);
    await env.DB.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('degraded_mode', '1', 0)").run();
    expect(await isDegraded(env, 1_000_000 + 59_000)).toBe(false);
    expect(await isDegraded(env, 1_000_000 + 60_000)).toBe(true);
  });
});
