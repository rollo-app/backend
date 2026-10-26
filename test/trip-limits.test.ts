import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, createTrip, DAY, join, newTrip, signUp, TZ } from "./helpers";

const body = () => {
  const now = Date.now();
  return {
    name: "Otro rollo",
    timezone: TZ,
    startsAt: now + 3600_000,
    endsAt: now + 2 * 3600_000,
    revealAt: now + 3 * 3600_000,
    dailyPhotoLimit: 2,
    dailyVideoLimit: 1,
  };
};
const create = (token: string) => api("POST", "/trips", { token, body: body() });
const setTrip = (tripId: string, sql: string, ...args: unknown[]) =>
  env.DB.prepare(`UPDATE trips SET ${sql} WHERE id = ?`).bind(...args, tripId).run();
const reveal = (tripId: string) => setTrip(tripId, "revealed_at = ?", Date.now());
const UNREVEALED = "Ya tenés 2 rollos sin revelar. Esperá a que se revele uno para crear otro.";

describe("limit on unrevealed rollos you created", () => {
  it("rejects the 3rd unrevealed rollo with 409 and the message", async () => {
    const a = await signUp();
    await createTrip(a.token);
    await createTrip(a.token);
    const res = await create(a.token);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(UNREVEALED);
  });

  it("does not count revealed rollos (manually or by date)", async () => {
    const a = await signUp();
    const t1 = await createTrip(a.token);
    const t2 = await createTrip(a.token);
    await reveal(t1.tripId);
    await setTrip(t2.tripId, "reveal_at = ?", Date.now() - 1000);
    expect((await create(a.token)).status).toBe(201);
  });

  it("does not count rollos you joined or were added to", async () => {
    const a = await signUp();
    const x = await newTrip();
    const y = await newTrip();
    await join(x.code, a.token);
    await join(y.code, a.token);
    await createTrip(a.token);
    expect((await create(a.token)).status).toBe(201);
  });

  it("an exempt user is unlimited", async () => {
    const a = await signUp();
    await env.DB.prepare("UPDATE users SET unlimited_rollos = 1 WHERE id = ?").bind(a.userId).run();
    for (let i = 0; i < 6; i++) expect((await create(a.token)).status).toBe(201);
  });
});

describe("limit of 4 rollos in 30 days", () => {
  async function fourRevealed(token: string, ages: number[]) {
    for (const age of ages) {
      const t = await createTrip(token);
      await reveal(t.tripId);
      await setTrip(t.tripId, "created_at = ?", Date.now() - age);
    }
  }

  it("rejects the 5th with the date the oldest turns 30 days", async () => {
    const a = await signUp();
    await fourRevealed(a.token, [20 * DAY, 10 * DAY, 5 * DAY, 1 * DAY]);
    const res = await create(a.token);
    expect(res.status).toBe(409);
    const expires = new Date(Date.now() + 10 * DAY);
    const months = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, day: "numeric", month: "numeric" }).formatToParts(expires);
    const day = Number(parts.find((p) => p.type === "day")!.value);
    const month = months[Number(parts.find((p) => p.type === "month")!.value) - 1];
    expect(res.body.error).toBe(`Ya creaste 4 rollos en los últimos 30 días. Vas a poder crear otro el ${day} de ${month}.`);
  });

  it("does not count rollos older than 30 days", async () => {
    const a = await signUp();
    await fourRevealed(a.token, [31 * DAY, 10 * DAY, 5 * DAY, 1 * DAY]);
    expect((await create(a.token)).status).toBe(201);
  });

  it("an exempt user is unlimited", async () => {
    const a = await signUp();
    await fourRevealed(a.token, [20 * DAY, 10 * DAY, 5 * DAY, 1 * DAY]);
    await env.DB.prepare("UPDATE users SET unlimited_rollos = 1 WHERE id = ?").bind(a.userId).run();
    expect((await create(a.token)).status).toBe(201);
  });
});
