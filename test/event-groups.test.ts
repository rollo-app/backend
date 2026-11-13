import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { DAY, api, createTrip, newTrip, photoBody, signUp, uploadMedia } from "./helpers";

async function eventFixture() {
  const org = await signUp(undefined, "Org");
  const { tripId, code } = await createTrip(org.token, {
    type: "event",
    groups: ["A", "B"],
    photoLimitMode: "total",
    totalPhotoLimit: 20,
    dailyPhotoLimit: undefined,
    dailyVideoLimit: undefined,
  });
  const detail = await api("GET", `/trips/${tripId}`, { token: org.token });
  const [a, b] = (detail.body.trip.groups as { id: string }[]).map((g) => g.id) as [string, string];
  const guestUser = await signUp(undefined, "Guest");
  const joined = await api("POST", "/trips/join", { token: guestUser.token, body: { code, groupIds: [a] } });
  expect(joined.status).toBe(201);
  return { org, tripId, a, b, guest: guestUser, guestMemberId: joined.body.member.id as string };
}

const groupNames = async (tripId: string, token: string) =>
  ((await api("GET", `/trips/${tripId}`, { token })).body.trip.groups as { name: string }[]).map((g) => g.name);

describe("organizers manage the groups of an event", () => {
  it("creates, renames and deletes an empty group", async () => {
    const ev = await eventFixture();
    const created = await api("POST", `/trips/${ev.tripId}/groups`, { token: ev.org.token, body: { name: "  Familia  " } });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id: expect.any(String), name: "Familia" });
    expect(await groupNames(ev.tripId, ev.org.token)).toEqual(["A", "B", "Familia"]);

    const renamed = await api("PATCH", `/trips/${ev.tripId}/groups/${created.body.id}`, { token: ev.org.token, body: { name: "Amigos" } });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toEqual({ id: created.body.id, name: "Amigos" });
    expect(await groupNames(ev.tripId, ev.org.token)).toEqual(["A", "B", "Amigos"]);

    const deleted = await api("DELETE", `/trips/${ev.tripId}/groups/${created.body.id}`, { token: ev.org.token });
    expect(deleted.status).toBe(204);
    expect(await groupNames(ev.tripId, ev.org.token)).toEqual(["A", "B"]);
  });

  it("refuses duplicate and invalid names", async () => {
    const ev = await eventFixture();
    const dup = await api("POST", `/trips/${ev.tripId}/groups`, { token: ev.org.token, body: { name: "A" } });
    expect(dup.status).toBe(409);
    const renameDup = await api("PATCH", `/trips/${ev.tripId}/groups/${ev.b}`, { token: ev.org.token, body: { name: "A" } });
    expect(renameDup.status).toBe(409);
    // Renaming a group to its own name is fine.
    expect((await api("PATCH", `/trips/${ev.tripId}/groups/${ev.b}`, { token: ev.org.token, body: { name: "B" } })).status).toBe(200);
    expect((await api("POST", `/trips/${ev.tripId}/groups`, { token: ev.org.token, body: { name: "   " } })).status).toBe(400);
    expect((await api("POST", `/trips/${ev.tripId}/groups`, { token: ev.org.token, body: { name: "x".repeat(41) } })).status).toBe(400);
  });

  it("refuses to delete a group that has people", async () => {
    const ev = await eventFixture();
    const res = await api("DELETE", `/trips/${ev.tripId}/groups/${ev.a}`, { token: ev.org.token });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Este grupo tiene gente o fotos.");
    expect(await groupNames(ev.tripId, ev.org.token)).toEqual(["A", "B"]);
  });

  it("refuses to delete a group that has photos", async () => {
    const ev = await eventFixture();
    const id = await uploadMedia(ev.tripId, ev.org.token, { groupIds: [ev.b] });
    const res = await api("DELETE", `/trips/${ev.tripId}/groups/${ev.b}`, { token: ev.org.token });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Este grupo tiene gente o fotos.");
    expect(id).toBeTruthy();
  });

  it("a group of another event is a 404", async () => {
    const ev = await eventFixture();
    const other = await eventFixture();
    expect((await api("PATCH", `/trips/${ev.tripId}/groups/${other.b}`, { token: ev.org.token, body: { name: "Z" } })).status).toBe(404);
    expect((await api("DELETE", `/trips/${ev.tripId}/groups/${other.b}`, { token: ev.org.token })).status).toBe(404);
  });

  it("guests cannot manage groups", async () => {
    const ev = await eventFixture();
    const t = ev.guest.token;
    expect((await api("POST", `/trips/${ev.tripId}/groups`, { token: t, body: { name: "Z" } })).status).toBe(403);
    expect((await api("PATCH", `/trips/${ev.tripId}/groups/${ev.b}`, { token: t, body: { name: "Z" } })).status).toBe(403);
    expect((await api("DELETE", `/trips/${ev.tripId}/groups/${ev.b}`, { token: t })).status).toBe(403);
  });

  it("is refused once the event is revealed", async () => {
    const ev = await eventFixture();
    await env.DB.prepare("UPDATE trips SET reveal_at = ? WHERE id = ?").bind(Date.now() - DAY, ev.tripId).run();
    for (const res of [
      await api("POST", `/trips/${ev.tripId}/groups`, { token: ev.org.token, body: { name: "Z" } }),
      await api("PATCH", `/trips/${ev.tripId}/groups/${ev.b}`, { token: ev.org.token, body: { name: "Z" } }),
      await api("DELETE", `/trips/${ev.tripId}/groups/${ev.b}`, { token: ev.org.token }),
    ]) {
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("Este evento ya se reveló.");
    }
  });

  it("a regular trip has no groups to manage", async () => {
    const t = await newTrip();
    const res = await api("POST", `/trips/${t.tripId}/groups`, { token: t.adminToken, body: { name: "A" } });
    expect(res.status).toBe(409);
  });

  it("caps the number of groups at 30", async () => {
    const ev = await eventFixture();
    for (let i = 0; i < 28; i++) {
      expect((await api("POST", `/trips/${ev.tripId}/groups`, { token: ev.org.token, body: { name: `G${i}` } })).status).toBe(201);
    }
    expect((await api("POST", `/trips/${ev.tripId}/groups`, { token: ev.org.token, body: { name: "extra" } })).status).toBe(409);
  });
});
