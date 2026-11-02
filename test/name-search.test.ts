import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, makeSuperadmin, signUp } from "./helpers";

const nameSearch = async (userId: string) =>
  (await env.DB.prepare("SELECT name_search FROM users WHERE id = ?").bind(userId).first<{ name_search: string | null }>())?.name_search;

describe("users.name_search", () => {
  it("updates name_search on PATCH /me", async () => {
    const u = await signUp(undefined, "Martín Pérez");
    expect(await nameSearch(u.userId)).toBe(" martin perez");
    const res = await api("PATCH", "/me", { token: u.token, body: { name: "Tomi" } });
    expect(res.status).toBe(200);
    expect(await nameSearch(u.userId)).toBe(" tomi");
  });

  it("updates name_search on admin edit", async () => {
    const su = await makeSuperadmin();
    const u = await signUp(undefined, "Lucía");
    const res = await api("PATCH", `/admin/users/${u.userId}`, { token: su.token, body: { name: "Ñandú Gómez" } });
    expect(res.status).toBe(200);
    expect(await nameSearch(u.userId)).toBe(" nandu gomez");
  });
});
