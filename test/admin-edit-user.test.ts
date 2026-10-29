import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { api, createTrip, makeSuperadmin, signUp } from "./helpers";

const patch = (id: string, token: string, body: unknown) => api("PATCH", `/admin/users/${id}`, { token, body });

describe("PATCH /admin/users/{id}", () => {
  it("edits name, username and bio, and the detail reflects it", async () => {
    const su = await makeSuperadmin();
    const u = await signUp("edit@rollo.test", "Viejo", "viejo");
    const r = await patch(u.userId, su.token, { name: "Nuevo", username: "@Nuevo.User", bio: "  hola  " });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: u.userId, name: "Nuevo", username: "nuevo.user", trips: [] });
    const g = await api("GET", `/admin/users/${u.userId}`, { token: su.token });
    expect(g.body).toMatchObject({ name: "Nuevo", username: "nuevo.user" });
    const row = await env.DB.prepare("SELECT bio FROM users WHERE id = ?").bind(u.userId).first<{ bio: string }>();
    expect(row!.bio).toBe("hola");
  });

  it("the detail returns bio and unlimitedRollos (defaults null/false) and PATCH reflects edits", async () => {
    const su = await makeSuperadmin();
    const u = await signUp();
    expect((await api("GET", `/admin/users/${u.userId}`, { token: su.token })).body).toMatchObject({ bio: null, unlimitedRollos: false });
    const r = await patch(u.userId, su.token, { bio: "mi bio", unlimitedRollos: true });
    expect(r.body).toMatchObject({ bio: "mi bio", unlimitedRollos: true });
    expect((await api("GET", `/admin/users/${u.userId}`, { token: su.token })).body).toMatchObject({ bio: "mi bio", unlimitedRollos: true });
    expect((await api("GET", "/admin/users", { token: su.token })).body.items[0]).not.toHaveProperty("bio");
  });

  it("sets and clears the badge", async () => {
    const su = await makeSuperadmin();
    const u = await signUp();
    expect((await patch(u.userId, su.token, { badge: "founder" })).body.badge).toBe("founder");
    expect((await api("GET", `/admin/users/${u.userId}`, { token: su.token })).body.badge).toBe("founder");
    expect((await patch(u.userId, su.token, { badge: null })).body.badge).toBeNull();
    expect((await patch(u.userId, su.token, { badge: "nope" })).status).toBe(400);
  });

  it("unlimitedRollos writes the column and lifts the rollo limits", async () => {
    const su = await makeSuperadmin();
    const u = await signUp();
    const col = async () => (await env.DB.prepare("SELECT unlimited_rollos AS n FROM users WHERE id = ?").bind(u.userId).first<{ n: number }>())!.n;
    await createTrip(u.token);
    await createTrip(u.token);
    await expect(createTrip(u.token)).rejects.toThrow("409");
    await patch(u.userId, su.token, { unlimitedRollos: true });
    expect(await col()).toBe(1);
    for (let i = 0; i < 3; i++) {
      await createTrip(u.token); // throws unless 201; the limit is 2 unrevealed at once
    }
    await patch(u.userId, su.token, { unlimitedRollos: false });
    expect(await col()).toBe(0);
  });

  it("the edited user sees the changes in GET /me", async () => {
    const su = await makeSuperadmin();
    const u = await signUp();
    await patch(u.userId, su.token, { name: "Otro", username: "otro_user", bio: "bio nueva", badge: "first_edition" });
    const me = await api("GET", "/me", { token: u.token });
    expect(me.body).toMatchObject({ name: "Otro", username: "otro_user", bio: "bio nueva", badge: "first_edition" });
  });

  it("username taken by another user is 409 and nothing is written", async () => {
    const su = await makeSuperadmin();
    await signUp("a@rollo.test", "A", "tomado");
    const u = await signUp("b@rollo.test", "B", "libre");
    const r = await patch(u.userId, su.token, { username: "Tomado", badge: "founder" });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("Ese nombre de usuario ya está en uso.");
    const g = await api("GET", `/admin/users/${u.userId}`, { token: su.token });
    expect(g.body).toMatchObject({ username: "libre", badge: null });
  });

  it("validates like PATCH /me", async () => {
    const su = await makeSuperadmin();
    const u = await signUp();
    expect((await patch(u.userId, su.token, { username: "a!" })).status).toBe(400);
    expect((await patch(u.userId, su.token, { name: "   " })).status).toBe(400);
    expect((await patch(u.userId, su.token, { bio: "x".repeat(151) })).status).toBe(400);
    expect((await patch(u.userId, su.token, { bio: "1\n2\n3\n4" })).status).toBe(400);
    expect((await patch(u.userId, su.token, { bio: "" })).status).toBe(200);
  });

  it("rejects other keys and empty bodies with 400", async () => {
    const su = await makeSuperadmin();
    const u = await signUp();
    const r = await patch(u.userId, su.token, { email: "x@rollo.test" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("Campo no editable: email");
    expect((await patch(u.userId, su.token, { name: "Ok", appRole: "superadmin" })).body.error).toBe("Campo no editable: appRole");
    expect((await patch(u.userId, su.token, {})).status).toBe(400);
  });

  it("an unknown key wins over an invalid allowed field", async () => {
    const su = await makeSuperadmin();
    const u = await signUp();
    const r = await patch(u.userId, su.token, { name: "   ", email: "x" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("Campo no editable: email");
  });

  it("setting the own current username with another case or @ is 200", async () => {
    const su = await makeSuperadmin();
    const u = await signUp("own@rollo.test", "Own", "miuser");
    expect((await patch(u.userId, su.token, { username: "@MiUser" })).body).toMatchObject({ username: "miuser" });
    expect((await patch(u.userId, su.token, { username: "MIUSER" })).status).toBe(200);
  });

  it("name + badge + unlimitedRollos in one request write all three", async () => {
    const su = await makeSuperadmin();
    const u = await signUp();
    expect((await patch(u.userId, su.token, { name: "Todo", badge: "founder", unlimitedRollos: true })).status).toBe(200);
    const row = await env.DB.prepare("SELECT name, badge, unlimited_rollos AS n FROM users WHERE id = ?").bind(u.userId).first();
    expect(row).toEqual({ name: "Todo", badge: "founder", n: 1 });
  });

  it("missing user is 404", async () => {
    const su = await makeSuperadmin();
    const r = await patch("00000000-0000-4000-8000-000000000000", su.token, { name: "X" });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("No encontrado");
  });

  it("is superadmin-session only: plain user and ADMIN_TOKEN get 404", async () => {
    const u = await signUp();
    const other = await signUp();
    const plain = await patch(u.userId, other.token, { name: "X" });
    expect(plain).toMatchObject({ status: 404, body: { error: "No encontrado" } });
    const viaToken = await api("PATCH", `/admin/users/${u.userId}`, { token: "secret", env: { ADMIN_TOKEN: "secret" }, body: { name: "X" } });
    expect(viaToken).toMatchObject({ status: 404, body: { error: "No encontrado" } });
    const anon = await api("PATCH", `/admin/users/${u.userId}`, { body: { name: "X" } });
    expect(anon.status).toBe(404);
  });
});
