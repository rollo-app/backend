import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, signUp } from "./helpers";

describe("users.app_role", () => {
  it("defaults to 'user' and is never exposed by the public contract", async () => {
    const { token, userId } = await signUp();
    const row = await env.DB.prepare("SELECT app_role FROM users WHERE id = ?").bind(userId).first<{ app_role: string }>();
    expect(row!.app_role).toBe("user");
    expect((await api("GET", "/me", { token })).body).not.toHaveProperty("appRole");
    expect((await api("GET", `/users/${userId}`, { token })).body).not.toHaveProperty("appRole");
  });

  it("rejects values other than user/superadmin", async () => {
    const { userId } = await signUp();
    await expect(env.DB.prepare("UPDATE users SET app_role = 'admin' WHERE id = ?").bind(userId).run()).rejects.toThrow(/CHECK/);
  });

  it("PATCH /me ignores appRole", async () => {
    const { token, userId } = await signUp();
    await api("PATCH", "/me", { token, body: { appRole: "superadmin" } });
    const row = await env.DB.prepare("SELECT app_role FROM users WHERE id = ?").bind(userId).first<{ app_role: string }>();
    expect(row!.app_role).toBe("user");
  });
});
