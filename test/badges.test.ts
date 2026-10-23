import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, signUp } from "./helpers";

async function setBadge(userId: string, badge: string | null) {
  await env.DB.prepare("UPDATE users SET badge = ? WHERE id = ?").bind(badge, userId).run();
}

describe("user badges", () => {
  it("GET /me returns badge null by default", async () => {
    const a = await signUp();
    expect((await api("GET", "/me", { token: a.token })).body.badge).toBeNull();
  });

  it("GET /me returns the badge once set by hand", async () => {
    const a = await signUp();
    await setBadge(a.userId, "founder");
    expect((await api("GET", "/me", { token: a.token })).body.badge).toBe("founder");
  });

  it("GET /users/{id} returns the badge to anyone, even for a private profile", async () => {
    const a = await signUp();
    const b = await signUp();
    expect((await api("GET", `/users/${a.userId}`, { token: b.token })).body.user.badge).toBeNull();
    await setBadge(a.userId, "first_edition");
    const res = await api("GET", `/users/${a.userId}`, { token: b.token });
    expect(res.body.canSee).toBe(false);
    expect(res.body.user.badge).toBe("first_edition");
  });

  it("returns null (not a 500) for an unknown stored value", async () => {
    const a = await signUp();
    const b = await signUp();
    // Store a value the CHECK would reject, via SQLite's ignore_check_constraints pragma.
    await env.DB.exec("PRAGMA ignore_check_constraints = ON");
    await env.DB.prepare("UPDATE users SET badge = 'legacy' WHERE id = ?").bind(a.userId).run();
    const me = await api("GET", "/me", { token: a.token });
    const other = await api("GET", `/users/${a.userId}`, { token: b.token });
    expect(me.status).toBe(200);
    expect(me.body.badge).toBeNull();
    expect(other.status).toBe(200);
    expect(other.body.user.badge).toBeNull();
  });

  it("the column rejects unknown values", async () => {
    const a = await signUp();
    await expect(env.DB.prepare("UPDATE users SET badge = 'vip' WHERE id = ?").bind(a.userId).run()).rejects.toThrow();
  });

  it("PATCH /me cannot set it", async () => {
    const a = await signUp();
    const res = await api("PATCH", "/me", { token: a.token, body: { name: "Ana", badge: "founder" } });
    expect(res.status).toBe(200);
    expect(res.body.badge).toBeNull();
    expect((await api("GET", "/me", { token: a.token })).body.badge).toBeNull();
  });
});
