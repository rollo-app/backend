import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { api, createTrip, photoBody, signUp } from "./helpers";

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
  return { org, tripId, code, a, b };
}

describe("editing an event", () => {
  it("refuses turning on the daily moment", async () => {
    const ev = await eventFixture();
    const res = await api("PATCH", `/trips/${ev.tripId}`, { token: ev.org.token, body: { momentMode: "photo" } });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("En un evento el cupo es de todo el rollo y no hay momento del día.");
  });

  it("refuses switching the quota to daily", async () => {
    const ev = await eventFixture();
    const res = await api("PATCH", `/trips/${ev.tripId}`, { token: ev.org.token, body: { photoLimitMode: "daily", dailyPhotoLimit: 5 } });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("En un evento el cupo es de todo el rollo y no hay momento del día.");
  });

  it("still lets an organizer rename the event and keep the total quota", async () => {
    const ev = await eventFixture();
    const res = await api("PATCH", `/trips/${ev.tripId}`, { token: ev.org.token, body: { name: "Otro nombre", photoLimitMode: "total", momentMode: "off" } });
    expect(res.status).toBe(200);
  });
});

describe("organizers of an event", () => {
  it("cannot be demoted while they have no group, and can once they join one", async () => {
    const ev = await eventFixture();
    const friend = await signUp(undefined, "Friend");
    const joined = await api("POST", "/trips/join", { token: friend.token, body: { code: ev.code, groupIds: [ev.a] } });
    const memberId = joined.body.member.id as string;
    expect((await api("POST", `/trips/${ev.tripId}/members/${memberId}/admin`, { token: ev.org.token })).status).toBe(200);
    // Organizer without groups: demoting would leave a guest in no group.
    await env.DB.prepare("DELETE FROM member_groups WHERE member_id = ?").bind(memberId).run();
    const refused = await api("DELETE", `/trips/${ev.tripId}/members/${memberId}/admin`, { token: ev.org.token });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("Para quitarle el rol de organizador, primero tiene que sumarse a un grupo.");
    const role = await env.DB.prepare("SELECT role FROM members WHERE id = ?").bind(memberId).first<{ role: string }>();
    expect(role?.role).toBe("admin");
    await api("PUT", `/trips/${ev.tripId}/members/me/groups`, { token: friend.token, body: { groupIds: [ev.b] } });
    expect((await api("DELETE", `/trips/${ev.tripId}/members/${memberId}/admin`, { token: ev.org.token })).status).toBe(200);
  });
});

describe("a guest without groups", () => {
  it("cannot register a photo (it would be visible to nobody)", async () => {
    const ev = await eventFixture();
    const guest = await signUp(undefined, "Guest");
    const joined = await api("POST", "/trips/join", { token: guest.token, body: { code: ev.code, groupIds: [ev.a] } });
    await env.DB.prepare("DELETE FROM member_groups WHERE member_id = ?").bind(joined.body.member.id).run();
    const res = await api("POST", `/trips/${ev.tripId}/media`, { token: guest.token, body: photoBody() });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Elegí un grupo para mandar fotos.");
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM media WHERE trip_id = ?").bind(ev.tripId).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});

describe("deleting groups", () => {
  it("refuses to delete the last group of an event", async () => {
    const ev = await eventFixture();
    expect((await api("DELETE", `/trips/${ev.tripId}/groups/${ev.b}`, { token: ev.org.token })).status).toBe(204);
    const res = await api("DELETE", `/trips/${ev.tripId}/groups/${ev.a}`, { token: ev.org.token });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Un evento necesita al menos un grupo.");
  });
});
