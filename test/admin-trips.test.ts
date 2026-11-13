import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { tripStage } from "../src/modules/admin/admin.service";
import { DAY, addMembersDirect, api, createTrip, join, joinAs, makeSuperadmin, newTrip, signUp, uploadMedia, grantEvents } from "./helpers";

const list = (token: string, qs = "") => api("GET", `/admin/trips${qs ? `?${qs}` : ""}`, { token });
const names = (r: { body: any }) => r.body.items.map((t: any) => t.name);
const rename = (tripId: string, name: string) => env.DB.prepare("UPDATE trips SET name = ? WHERE id = ?").bind(name, tripId).run();

describe("GET /admin/trips", () => {
  it("pages and sorts by createdAt desc by default, with the row shape", async () => {
    const su = await makeSuperadmin();
    const a = await newTrip();
    const b = await newTrip();
    await env.DB.prepare("UPDATE trips SET created_at = 1000 WHERE id = ?").bind(a.tripId).run();
    await env.DB.prepare("UPDATE trips SET created_at = 2000 WHERE id = ?").bind(b.tripId).run();
    const r = await list(su.token);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ page: 1, pageSize: 25, total: 2 });
    expect(r.body.items.map((t: any) => t.id)).toEqual([b.tripId, a.tripId]);
    const asc = await list(su.token, "sort=createdAt&order=asc&pageSize=1&page=2");
    expect(asc.body.items.map((t: any) => t.id)).toEqual([b.tripId]);
    const row = r.body.items[1];
    expect(Object.keys(row).sort()).toEqual(
      ["activeMembers", "createdAt", "creator", "endsAt", "id", "joinCode", "keepOriginals", "maxMembers", "mediaCount", "name", "originalsExpireAt", "originalsPurgedAt", "revealAt", "revealed", "stage", "startsAt", "type"].sort(),
    );
    expect(row).toMatchObject({ id: a.tripId, name: "Viaje al sur", joinCode: a.code, createdAt: 1000, revealed: false, stage: "active", activeMembers: 1, maxMembers: 15, mediaCount: 0 });
    expect(row.creator).toEqual({ id: a.adminUserId, name: "Juani", username: expect.any(String) });
  });

  it("q matches the name ignoring case and accents, and the exact join code", async () => {
    const su = await makeSuperadmin();
    const a = await newTrip();
    const b = await newTrip();
    const c = await newTrip();
    await rename(a.tripId, "Cumpleaños de Ángela");
    await rename(b.tripId, "Asado 100%");
    await rename(c.tripId, "Otro");
    const by = async (q: string) => names(await list(su.token, `q=${encodeURIComponent(q)}`));
    expect(await by("angela")).toEqual(["Cumpleaños de Ángela"]);
    expect(await by("CUMPLEANOS")).toEqual(["Cumpleaños de Ángela"]);
    expect(await by("ÁNGELA")).toEqual(["Cumpleaños de Ángela"]);
    expect(await by("100%")).toEqual(["Asado 100%"]);
    expect(await by("0_")).toEqual([]);
    expect(await by("%%")).toEqual([]);
    expect(await by(c.code.toLowerCase())).toEqual(["Otro"]);
    expect(await by(`  ${c.code}  `)).toEqual(["Otro"]);
    expect(await by(c.code.slice(0, 4))).toEqual([]); // codes match exactly, not by prefix
    expect((await list(su.token, "q=angela")).body.total).toBe(1);
  });

  it("q must be 2 to 60 characters after trimming", async () => {
    const su = await makeSuperadmin();
    expect((await list(su.token, "q=a")).status).toBe(400);
    expect((await list(su.token, "q=%20a%20")).status).toBe(400);
    expect((await list(su.token, `q=${"x".repeat(61)}`)).status).toBe(400);
    expect((await list(su.token, `q=${"x".repeat(60)}`)).status).toBe(200);
    expect((await list(su.token, "q=")).status).toBe(200);
  });

  it("rejects an unknown sort and invalid paging", async () => {
    const su = await makeSuperadmin();
    expect((await list(su.token, "sort=joinCode")).status).toBe(400);
    const bad = await list(su.token, "page=0");
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: "Parámetros inválidos" });
  });

  it("sorts by activeMembers, mediaCount and name", async () => {
    const su = await makeSuperadmin();
    const small = await newTrip();
    const big = await newTrip();
    await addMembersDirect(big.tripId, 3);
    await uploadMedia(small.tripId, small.adminToken);
    await rename(small.tripId, "Zeta");
    await rename(big.tripId, "Alfa");
    expect((await list(su.token, "sort=activeMembers&order=desc")).body.items[0].id).toBe(big.tripId);
    expect((await list(su.token, "sort=activeMembers&order=asc")).body.items[0].id).toBe(small.tripId);
    expect((await list(su.token, "sort=mediaCount&order=desc")).body.items[0].id).toBe(small.tripId);
    expect(names(await list(su.token, "sort=name&order=asc"))).toEqual(["Alfa", "Zeta"]);
  });

  it("counts: active members exclude left and removed; media excludes pending and deleted", async () => {
    const su = await makeSuperadmin();
    const t = await newTrip({ dailyPhotoLimit: 5 });
    const ana = await joinAs(t.code, "Ana");
    const beto = await joinAs(t.code, "Beto");
    await joinAs(t.code, "Caro");
    await env.DB.prepare("UPDATE members SET left_at = 1 WHERE id = ?").bind(ana.memberId).run();
    await env.DB.prepare("UPDATE members SET removed_at = 1 WHERE id = ?").bind(beto.memberId).run();
    await uploadMedia(t.tripId, t.adminToken);
    const pending = await uploadMedia(t.tripId, t.adminToken);
    const deleted = await uploadMedia(t.tripId, t.adminToken);
    await env.DB.prepare("UPDATE media SET status = 'pending' WHERE id = ?").bind(pending).run();
    await env.DB.prepare("UPDATE media SET deleted_at = 1 WHERE id = ?").bind(deleted).run();
    const row = (await list(su.token)).body.items[0];
    expect(row).toMatchObject({ activeMembers: 2, mediaCount: 1 });
  });

  it("stage is upcoming, active, ended or revealed", async () => {
    const su = await makeSuperadmin();
    const now = Date.now();
    const up = await newTrip({ startsAt: now + DAY, endsAt: now + 2 * DAY, revealAt: now + 3 * DAY });
    const act = await newTrip();
    const end = await newTrip({ startsAt: now - 3 * DAY, endsAt: now - DAY, revealAt: now + DAY });
    const rev = await newTrip({ startsAt: now - 3 * DAY, endsAt: now - 2 * DAY, revealAt: now - DAY });
    const manual = await newTrip();
    await env.DB.prepare("UPDATE trips SET revealed_at = ? WHERE id = ?").bind(now, manual.tripId).run();
    const items = (await list(su.token, "pageSize=100")).body.items;
    const of = (id: string) => items.find((t: any) => t.id === id);
    expect(of(up.tripId)).toMatchObject({ stage: "upcoming", revealed: false });
    expect(of(act.tripId)).toMatchObject({ stage: "active", revealed: false });
    expect(of(end.tripId)).toMatchObject({ stage: "ended", revealed: false });
    expect(of(rev.tripId)).toMatchObject({ stage: "revealed", revealed: true });
    expect(of(manual.tripId)).toMatchObject({ stage: "revealed", revealed: true });
  });

  it("creator is null when the rollo has no known creator", async () => {
    const su = await makeSuperadmin();
    const t = await newTrip();
    await env.DB.prepare("UPDATE trips SET created_by_user_id = NULL WHERE id = ?").bind(t.tripId).run();
    expect((await list(su.token)).body.items[0].creator).toBeNull();
  });

  it("accepts ADMIN_TOKEN and hides the route from a plain user", async () => {
    await newTrip();
    const ok = await api("GET", "/admin/trips", { env: { ADMIN_TOKEN: "secret" }, headers: { authorization: "Bearer secret" } });
    expect(ok.status).toBe(200);
    expect(ok.body.total).toBe(1);
    const { token } = await signUp();
    expect((await list(token)).status).toBe(404);
  });
});

describe("GET /admin/trips/:tripId", () => {
  it("admin trip detail lists event groups with counts", async () => {
    const su = await makeSuperadmin();
    const org = await signUp(undefined, "Org");
    await grantEvents(org.userId);
    const { tripId, code } = await createTrip(org.token, {
      type: "event",
      groups: ["Familia", "Amigos"],
      photoLimitMode: "total",
      totalPhotoLimit: 20,
      dailyPhotoLimit: undefined,
      dailyVideoLimit: undefined,
    });
    const detail = await api("GET", `/trips/${tripId}`, { token: org.token });
    const [fam, ami] = (detail.body.trip.groups as { id: string }[]).map((g) => g.id) as [string, string];
    const ana = await signUp(undefined, "Ana");
    const beto = await signUp(undefined, "Beto");
    const joinedAna = await api("POST", "/trips/join", { token: ana.token, body: { code, groupIds: [fam, ami] } });
    const joinedBeto = await api("POST", "/trips/join", { token: beto.token, body: { code, groupIds: [fam] } });
    await env.DB.prepare("UPDATE members SET left_at = 1 WHERE id = ?").bind(joinedBeto.body.member.id).run();
    const kept = await uploadMedia(tripId, ana.token);
    const pending = await uploadMedia(tripId, ana.token);
    const deleted = await uploadMedia(tripId, ana.token);
    await env.DB.prepare("UPDATE media SET status = 'pending' WHERE id = ?").bind(pending).run();
    await env.DB.prepare("UPDATE media SET deleted_at = 1 WHERE id = ?").bind(deleted).run();
    // Ana's uploads default to all her groups; narrow the kept one to Familia only.
    await env.DB.prepare("DELETE FROM media_groups WHERE media_id = ? AND group_id = ?").bind(kept, ami).run();
    expect(joinedAna.status).toBe(201);

    const r = await api("GET", `/admin/trips/${tripId}`, { token: su.token });
    expect(r.status).toBe(200);
    expect(r.body.type).toBe("event");
    expect(r.body.groups).toEqual([
      { id: fam, name: "Familia", memberCount: 1, mediaCount: 1 },
      { id: ami, name: "Amigos", memberCount: 1, mediaCount: 0 },
    ]);

    const plain = await newTrip();
    const p = await api("GET", `/admin/trips/${plain.tripId}`, { token: su.token });
    expect(p.body).toMatchObject({ type: "trip", groups: [] });
  });

  it("returns the row fields plus active members: creator, admins, then by join time", async () => {
    const su = await makeSuperadmin();
    const t = await newTrip();
    const ana = await joinAs(t.code, "Ana");
    const beto = await joinAs(t.code, "Beto");
    const caro = await joinAs(t.code, "Caro");
    const gone = await joinAs(t.code, "Fuera");
    await env.DB.prepare("UPDATE members SET created_at = 100 WHERE id = ?").bind(caro.memberId).run();
    await env.DB.prepare("UPDATE members SET created_at = 200 WHERE id = ?").bind(ana.memberId).run();
    await env.DB.prepare("UPDATE members SET created_at = 300, role = 'admin' WHERE id = ?").bind(beto.memberId).run();
    await env.DB.prepare("UPDATE members SET created_at = 50 WHERE id = ?").bind(t.adminId).run();
    await env.DB.prepare("UPDATE members SET left_at = 1 WHERE id = ?").bind(gone.memberId).run();
    const r = await api("GET", `/admin/trips/${t.tripId}`, { token: su.token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: t.tripId, joinCode: t.code, stage: "active", activeMembers: 4, maxMembers: 15, mediaCount: 0 });
    expect(r.body.members.map((m: any) => m.name)).toEqual(["Juani", "Beto", "Caro", "Ana"]);
    expect(r.body.members[0]).toEqual({
      id: t.adminId,
      userId: t.adminUserId,
      name: "Juani",
      username: expect.any(String),
      role: "admin",
      isCreator: true,
      joinedAt: 50,
    });
    expect(r.body.members[1]).toMatchObject({ userId: beto.userId, role: "admin", isCreator: false, joinedAt: 300 });
    expect(r.body.members[3]).toMatchObject({ id: ana.memberId, role: "member", isCreator: false });
  });

  it("ADMIN_TOKEN reads it; unknown id is 404; a plain user gets 404", async () => {
    const su = await makeSuperadmin();
    const t = await newTrip();
    const viaToken = await api("GET", `/admin/trips/${t.tripId}`, { env: { ADMIN_TOKEN: "secret" }, headers: { authorization: "Bearer secret" } });
    expect(viaToken.status).toBe(200);
    expect((await api("GET", "/admin/trips/nope", { token: su.token })).status).toBe(404);
    expect((await api("GET", `/admin/trips/${t.tripId}`, { token: t.adminToken })).status).toBe(404);
  });
});

describe("tripStage", () => {
  const now = 1_000_000;
  const base = { startsAt: now - 100, endsAt: now + 100, revealAt: now + 200, revealedAt: null as number | null };
  it.each([
    [{ revealedAt: now - 5 }, "revealed"],
    [{ revealAt: now }, "revealed"],
    [{ startsAt: now + 1 }, "upcoming"],
    [{ endsAt: now - 1 }, "ended"],
    [{}, "active"],
    [{ startsAt: now }, "active"],
    [{ endsAt: now }, "active"],
  ] as const)("%j is %s", (over, expected) => {
    expect(tripStage({ ...base, ...over }, now)).toBe(expected);
  });
});
