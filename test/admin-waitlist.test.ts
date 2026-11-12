import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, makeSuperadmin, signUp } from "./helpers";

type Seed = { source?: "app" | "web"; createdAt?: number; confirmedAt?: number | null; unsubscribedAt?: number | null };

let n = 0;
async function seed(email: string, s: Seed = {}) {
  n++;
  await env.DB.prepare(
    `INSERT INTO waitlist (email, source, created_at, confirm_token_hash, confirmed_at, unsubscribe_token_hash, unsubscribed_at, last_sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(email, s.source ?? "app", s.createdAt ?? 1_000 * n, `c${n}`, s.confirmedAt ?? null, `u${n}`, s.unsubscribedAt ?? null, 1)
    .run();
}

/** pending a (1000), confirmed b (2000), unsubscribed c (3000, was confirmed), confirmed d (4000, web). */
async function seedAll() {
  await seed("a@rollo.test", { createdAt: 1_000 });
  await seed("b@rollo.test", { createdAt: 2_000, confirmedAt: 2_500 });
  await seed("c@rollo.test", { createdAt: 3_000, confirmedAt: 3_100, unsubscribedAt: 3_200 });
  await seed("d@rollo.test", { createdAt: 4_000, confirmedAt: Date.UTC(2026, 10, 5, 12, 0, 0), source: "web" });
}

const emails = (r: { body: any }) => r.body.items.map((i: any) => i.email);

describe("GET /admin/waitlist", () => {
  it("lists newest first with the status of each and totals per status", async () => {
    const su = await makeSuperadmin();
    await seedAll();
    const res = await api("GET", "/admin/waitlist", { token: su.token });
    expect(res.status).toBe(200);
    expect(emails(res)).toEqual(["d@rollo.test", "c@rollo.test", "b@rollo.test", "a@rollo.test"]);
    expect(res.body).toMatchObject({ page: 1, pageSize: 25, total: 4, totals: { all: 4, confirmed: 2, pending: 1, unsubscribed: 1 } });
    expect(res.body.items.map((i: any) => i.status)).toEqual(["confirmed", "unsubscribed", "confirmed", "pending"]);
    expect(res.body.items[0]).toEqual({
      email: "d@rollo.test",
      source: "web",
      status: "confirmed",
      createdAt: 4_000,
      confirmedAt: Date.UTC(2026, 10, 5, 12, 0, 0),
      unsubscribedAt: null,
    });
  });

  it("filters by status; total follows the filter but totals stay global", async () => {
    const su = await makeSuperadmin();
    await seedAll();
    const by = (status: string) => api("GET", `/admin/waitlist?status=${status}`, { token: su.token });
    expect(emails(await by("confirmed"))).toEqual(["d@rollo.test", "b@rollo.test"]);
    expect(emails(await by("pending"))).toEqual(["a@rollo.test"]);
    expect(emails(await by("unsubscribed"))).toEqual(["c@rollo.test"]);
    expect(emails(await by("all"))).toHaveLength(4);
    const confirmed = await by("confirmed");
    expect(confirmed.body.total).toBe(2);
    expect(confirmed.body.totals).toEqual({ all: 4, confirmed: 2, pending: 1, unsubscribed: 1 });
    expect((await by("otro")).status).toBe(400);
  });

  it("pages and searches by email without wildcards", async () => {
    const su = await makeSuperadmin();
    await seedAll();
    await seed("ana_perez@rollo.test");
    await seed("100%@rollo.test");
    const p2 = await api("GET", "/admin/waitlist?pageSize=2&page=2", { token: su.token });
    expect(p2.body).toMatchObject({ page: 2, pageSize: 2, total: 6 });
    expect(p2.body.items).toHaveLength(2);
    const q = async (s: string) => emails(await api("GET", `/admin/waitlist?q=${encodeURIComponent(s)}`, { token: su.token }));
    expect(await q("ANA_P")).toEqual(["ana_perez@rollo.test"]);
    expect(await q("a_a")).toEqual([]);
    expect(await q("%")).toEqual(["100%@rollo.test"]);
    const filtered = await api("GET", `/admin/waitlist?q=${encodeURIComponent("b@")}&status=confirmed`, { token: su.token });
    expect(emails(filtered)).toEqual(["b@rollo.test"]);
  });

  it("is for superadmin sessions and ADMIN_TOKEN only", async () => {
    await seedAll();
    const { token } = await signUp();
    expect((await api("GET", "/admin/waitlist", { token })).status).toBe(404);
    expect((await api("GET", "/admin/waitlist")).status).toBe(404);
    const t = await api("GET", "/admin/waitlist", { token: "secret-admin", env: { ADMIN_TOKEN: "secret-admin" } });
    expect(t.status).toBe(200);
    expect((await api("GET", "/admin/waitlist?page=0", { token: (await makeSuperadmin()).token })).status).toBe(400);
  });
});

describe("GET /admin/waitlist.csv", () => {
  it("exports only confirmed, not unsubscribed, as email,source,created_at,confirmed_at in ISO dates", async () => {
    const su = await makeSuperadmin();
    await seedAll();
    const res = await api("GET", "/admin/waitlist.csv", { token: su.token });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.body.split("\n")).toEqual([
      "email,source,created_at,confirmed_at",
      "b@rollo.test,app,1970-01-01T00:00:02.000Z,1970-01-01T00:00:02.500Z",
      "d@rollo.test,web,1970-01-01T00:00:04.000Z,2026-11-05T12:00:00.000Z",
      "",
    ]);
  });

  it("is just the header when nobody is confirmed", async () => {
    const su = await makeSuperadmin();
    await seed("a@rollo.test");
    expect((await api("GET", "/admin/waitlist.csv", { token: su.token })).body).toBe("email,source,created_at,confirmed_at\n");
  });

  it("neutralizes spreadsheet formulas in the email", async () => {
    const su = await makeSuperadmin();
    await seed("=1+1@rollo.test", { confirmedAt: 5_000 });
    const lines = (await api("GET", "/admin/waitlist.csv", { token: su.token })).body.split("\n");
    expect(lines[1]!.startsWith("'=1+1@rollo.test,")).toBe(true);
  });

  it("needs a superadmin session or ADMIN_TOKEN", async () => {
    const { token } = await signUp();
    expect((await api("GET", "/admin/waitlist.csv", { token })).status).toBe(404);
    expect((await api("GET", "/admin/waitlist.csv", { token: "secret-admin", env: { ADMIN_TOKEN: "secret-admin" } })).status).toBe(200);
  });
});
