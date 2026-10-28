import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, joinAs, newTrip } from "./helpers";

async function setup(reveal: boolean) {
  const trip = await newTrip();
  const ana = await joinAs(trip.code, "Ana");
  if (reveal) await api("POST", `/trips/${trip.tripId}/reveal`, { token: trip.adminToken });
  const patch = (token: string, body: unknown) => api("PATCH", `/trips/${trip.tripId}/members/me`, { token, body });
  const archivedFor = async (token: string) =>
    ((await api("GET", "/me/trips", { token })).body.trips as { id: string; archived: boolean }[]).find((t) => t.id === trip.tripId)!.archived;
  return { trip, ana, patch, archivedFor };
}

describe("archiving a rollo (per member)", () => {
  it("archives and unarchives a revealed rollo only for me", async () => {
    const { trip, ana, patch, archivedFor } = await setup(true);
    const res = await patch(ana.token, { archived: true });
    expect(res.status).toBe(200);
    expect(res.body.archived).toBe(true);
    expect(await archivedFor(ana.token)).toBe(true);
    expect(await archivedFor(trip.adminToken)).toBe(false);
    const back = await patch(ana.token, { archived: false });
    expect(back.body.archived).toBe(false);
    expect(await archivedFor(ana.token)).toBe(false);
  });

  it("an unrevealed rollo can't be archived", async () => {
    const { ana, patch } = await setup(false);
    const res = await patch(ana.token, { archived: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Solo podés archivar rollos revelados");
  });

  it("allowFeaturing alone still works", async () => {
    const { ana, patch } = await setup(true);
    const res = await patch(ana.token, { allowFeaturing: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ allowFeaturing: false, archived: false });
  });

  it("an empty body is 400", async () => {
    const { ana, patch } = await setup(true);
    expect((await patch(ana.token, {})).status).toBe(400);
  });

  it("leaving clears the archive", async () => {
    const { trip, ana, patch } = await setup(true);
    await patch(ana.token, { archived: true });
    expect((await api("DELETE", `/trips/${trip.tripId}/members/me`, { token: ana.token })).status).toBe(204);
    // A revealed rollo can't be rejoined by code, so check the row a rejoin would revive.
    const row = await env.DB.prepare("SELECT archived_at a FROM members WHERE id = ?").bind(ana.memberId).first<{ a: number | null }>();
    expect(row!.a).toBeNull();
  });

  it("removing a member clears the archive", async () => {
    const { trip, ana, patch } = await setup(true);
    await patch(ana.token, { archived: true });
    expect((await api("DELETE", `/trips/${trip.tripId}/members/${ana.memberId}`, { token: trip.adminToken })).status).toBe(204);
    const row = await env.DB.prepare("SELECT archived_at a FROM members WHERE id = ?").bind(ana.memberId).first<{ a: number | null }>();
    expect(row!.a).toBeNull();
  });
});
