import { describe, expect, it } from "vitest";
import { api, makeSuperadmin, newTrip, signUp, uploadMedia } from "./helpers";

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
