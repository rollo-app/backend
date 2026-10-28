import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, makeSuperadmin, newTrip, signUp, uploadMedia } from "./helpers";

const ENV = { ADMIN_TOKEN: "secret" };

describe("/admin with a session", () => {
  it("GET /admin/me answers the superadmin and 404s everyone else", async () => {
    const su = await makeSuperadmin();
    const me = await api("GET", "/admin/me", { token: su.token });
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ id: su.userId, email: su.email, name: "Test", appRole: "superadmin" });

    const plain = await signUp();
    expect((await api("GET", "/admin/me", { token: plain.token })).status).toBe(404);
    expect((await api("GET", "/admin/me")).status).toBe(404);
    expect((await api("GET", "/admin/me", { token: "not-a-session" })).status).toBe(404);
  });

  it("GET /admin/me with ADMIN_TOKEN answers appRole 'token'", async () => {
    const r = await api("GET", "/admin/me", { env: ENV, headers: { authorization: "Bearer secret" } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: null, email: null, name: null, appRole: "token" });
  });

  it("an expired superadmin session is a 404", async () => {
    const su = await makeSuperadmin();
    await env.DB.prepare("UPDATE sessions SET expires_at = 1").run();
    expect((await api("GET", "/admin/me", { token: su.token })).status).toBe(404);
  });

  it("destructive routes still need ADMIN_TOKEN: a superadmin session gets 404", async () => {
    const su = await makeSuperadmin();
    const { tripId, adminToken } = await newTrip();
    const mediaId = await uploadMedia(tripId, adminToken);
    expect((await api("DELETE", `/admin/media/${mediaId}`, { token: su.token, env: ENV })).status).toBe(404);
    expect((await api("DELETE", `/admin/users/${su.userId}`, { token: su.token, env: ENV })).status).toBe(404);
    expect((await api("DELETE", `/admin/media/${mediaId}`, { env: ENV, headers: { authorization: "Bearer secret" } })).status).toBe(204);
  });

  it("GET /admin/reports accepts both credentials", async () => {
    const su = await makeSuperadmin();
    expect((await api("GET", "/admin/reports", { token: su.token })).status).toBe(200);
    expect((await api("GET", "/admin/reports", { env: ENV, headers: { authorization: "Bearer secret" } })).status).toBe(200);
  });

  it("with ADMIN_TOKEN configured, a superadmin session still reads /admin/me and /admin/reports; a plain user gets 404", async () => {
    const su = await makeSuperadmin();
    const plain = await signUp();
    for (const path of ["/admin/me", "/admin/reports"]) {
      expect((await api("GET", path, { token: su.token, env: ENV })).status).toBe(200);
      expect((await api("GET", path, { token: plain.token, env: ENV })).status).toBe(404);
    }
  });
});
