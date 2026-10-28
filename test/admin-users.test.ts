import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { tripState } from "../src/modules/admin/admin.service";
import { api, join, makeSuperadmin, newTrip, signUp, uploadMedia } from "./helpers";

const DAY = 86_400_000;

describe("GET /admin/users", () => {
  it("pages, sorts by createdAt desc by default and aggregates counts", async () => {
    const su = await makeSuperadmin("su@rollo.test");
    const { tripId, adminToken } = await newTrip();
    await uploadMedia(tripId, adminToken);
    const r = await api("GET", "/admin/users?pageSize=1", { token: su.token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ page: 1, pageSize: 1, total: 2 });
    expect(r.body.items).toHaveLength(1);
    const creator = (await api("GET", "/admin/users?pageSize=10&sort=createdAt&order=asc", { token: su.token })).body.items.at(-1);
    expect(creator).toMatchObject({ tripCount: 1, mediaCount: 1, appRole: "user" });
    expect(typeof creator.lastSeenAt).toBe("number");
  });

  it("q searches email, name and username without wildcards", async () => {
    const su = await makeSuperadmin();
    await signUp("ana_perez@rollo.test", "Ana", "anita");
    await signUp("beto@rollo.test", "Beto", "beto");
    const by = async (q: string) => (await api("GET", `/admin/users?q=${encodeURIComponent(q)}`, { token: su.token })).body.items.map((u: any) => u.email);
    expect(await by("ANA")).toEqual(["ana_perez@rollo.test"]);
    expect(await by("anita")).toEqual(["ana_perez@rollo.test"]);
    expect(await by("%")).toEqual([]);
    expect(await by("a_a")).toEqual([]);
    await signUp("back\\slash@rollo.test", "Slash", "slashy");
    expect(await by("\\")).toEqual(["back\\slash@rollo.test"]);
    expect(await by("\\x")).toEqual([]);
  });

  it("rejects an unknown sort, invalid params and a plain user", async () => {
    const su = await makeSuperadmin();
    expect((await api("GET", "/admin/users?sort=badge", { token: su.token })).status).toBe(400);
    const bad = await api("GET", "/admin/users?page=0", { token: su.token });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: "Parámetros inválidos" });
    const { token } = await signUp();
    expect((await api("GET", "/admin/users", { token })).status).toBe(404);
  });
});

describe("GET /admin/users/:id", () => {
  it("returns the user with their active rollos and states", async () => {
    const su = await makeSuperadmin();
    const now = Date.now();
    const { tripId, adminToken } = await newTrip({ startsAt: now + DAY, endsAt: now + 2 * DAY, revealAt: now + 3 * DAY });
    const me = (await api("GET", "/me", { token: adminToken })).body;
    const r = await api("GET", `/admin/users/${me.id}`, { token: su.token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: me.id, tripCount: 1 });
    expect(r.body.trips).toEqual([{ id: tripId, name: "Viaje al sur", role: "admin", state: "upcoming" }]);
    expect((await api("GET", "/admin/users/nope", { token: su.token })).status).toBe(404);
  });
});

describe("tripState", () => {
  const now = 1_000_000;
  const base = { startsAt: now - 100, endsAt: now + 100, revealAt: now + 200, revealedAt: null as number | null };
  it.each([
    ["revealed via revealedAt", { revealedAt: now - 5 }, "revealed"],
    ["revealed when revealAt < now", { revealAt: now - 1 }, "revealed"],
    ["revealed when revealAt == now", { revealAt: now }, "revealed"],
    ["upcoming when startsAt > now", { startsAt: now + 1, endsAt: now + 100 }, "upcoming"],
    ["ended when endsAt < now", { endsAt: now - 1 }, "ended"],
    ["open", {}, "open"],
    ["open when startsAt == now", { startsAt: now }, "open"],
    ["open when endsAt == now", { endsAt: now }, "open"],
  ] as const)("%s", (_n, over, expected) => {
    expect(tripState({ ...base, ...over }, now)).toBe(expected);
  });
});

describe("GET /admin/users aggregates and sorting", () => {
  const find = async (token: string, id: string) =>
    (await api("GET", "/admin/users?pageSize=100", { token })).body.items.find((u: any) => u.id === id);

  it("tripCount only counts active memberships", async () => {
    const su = await makeSuperadmin();
    const a = await newTrip();
    const b = await newTrip();
    const c = await newTrip();
    const u = await signUp();
    const ma = await join(a.code, u.token);
    const mb = await join(b.code, u.token);
    await join(c.code, u.token);
    await env.DB.prepare("UPDATE members SET left_at = ? WHERE id = ?").bind(Date.now(), ma.memberId).run();
    await env.DB.prepare("UPDATE members SET removed_at = ? WHERE id = ?").bind(Date.now(), mb.memberId).run();
    expect(await find(su.token, u.userId)).toMatchObject({ tripCount: 1 });
    const d = await api("GET", `/admin/users/${u.userId}`, { token: su.token });
    expect(d.body.trips).toHaveLength(1);
  });

  it("mediaCount only counts uploaded, non-deleted media", async () => {
    const su = await makeSuperadmin();
    const { tripId, adminToken, adminUserId } = await newTrip({ dailyPhotoLimit: 5 });
    await uploadMedia(tripId, adminToken);
    const pending = await uploadMedia(tripId, adminToken);
    const deleted = await uploadMedia(tripId, adminToken);
    await env.DB.prepare("UPDATE media SET status = 'pending' WHERE id = ?").bind(pending).run();
    await env.DB.prepare("UPDATE media SET deleted_at = ? WHERE id = ?").bind(Date.now(), deleted).run();
    expect(await find(su.token, adminUserId)).toMatchObject({ mediaCount: 1 });
  });

  it("sorts by lastSeenAt, name and email", async () => {
    const su = await makeSuperadmin("zz-su@rollo.test");
    const a = await signUp("aaa@rollo.test", "Zed");
    const b = await signUp("bbb@rollo.test", "Amy");
    await env.DB.prepare("UPDATE sessions SET last_used_at = ? WHERE user_id = ?").bind(1, a.userId).run();
    await env.DB.prepare("UPDATE sessions SET last_used_at = ? WHERE user_id = ?").bind(2, b.userId).run();
    const first = async (qs: string) => (await api("GET", `/admin/users?${qs}`, { token: su.token }));
    let r = await first("sort=lastSeenAt&order=asc&pageSize=1");
    expect(r.status).toBe(200);
    expect(r.body.items[0].id).toBe(a.userId);
    r = await first("sort=name&order=asc&pageSize=1&q=rollo.test");
    expect(r.status).toBe(200);
    expect(r.body.items[0].id).toBe(b.userId);
    r = await first("sort=email&order=desc&pageSize=1");
    expect(r.status).toBe(200);
    expect(r.body.items[0].email).toBe("zz-su@rollo.test");
  });

  it("total under q counts matches, not the table", async () => {
    const su = await makeSuperadmin();
    await signUp("uno@rollo.test", "Uno");
    await signUp("dos@rollo.test", "Dos");
    const r = await api("GET", "/admin/users?q=uno&pageSize=1", { token: su.token });
    expect(r.body.total).toBe(1);
    expect(r.body.items).toHaveLength(1);
  });
});
