import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { api, createTrip, grantEvents, signUp } from "./helpers";

const DAY = 86_400_000;

async function organizer() {
  const org = await signUp(undefined, "Org");
  await grantEvents(org.userId);
  return org;
}

const eventBody = (description?: string) => ({ type: "event", groups: ["A"], ...(description === undefined ? {} : { description }) });

async function createEvent(token: string, description?: string) {
  const now = Date.now();
  return api("POST", "/trips", {
    token,
    body: {
      name: "Boda",
      timezone: "America/Argentina/Buenos_Aires",
      startsAt: now + 3_600_000,
      endsAt: now + 2 * 3_600_000,
      revealAt: now + 3 * 3_600_000,
      ...eventBody(description),
    },
  });
}

describe("event description", () => {
  it("creates an event with a description", async () => {
    const org = await organizer();
    const res = await createEvent(org.token, "  Premio a la mejor foto  ");
    expect(res.status).toBe(201);
    expect(res.body.trip.description).toBe("Premio a la mejor foto");
  });

  it("has a null description when none is sent", async () => {
    const org = await organizer();
    const res = await createEvent(org.token);
    expect(res.body.trip.description).toBeNull();
  });

  it("empty description becomes null", async () => {
    const org = await organizer();
    const res = await createEvent(org.token, "   ");
    expect(res.status).toBe(201);
    expect(res.body.trip.description).toBeNull();
  });

  it("rejects 301 characters", async () => {
    const org = await organizer();
    expect((await createEvent(org.token, "a".repeat(300))).status).toBe(201);
    expect((await createEvent(org.token, "a".repeat(301))).status).toBe(400);
  });

  it("rejects 7 lines", async () => {
    const org = await organizer();
    expect((await createEvent(org.token, "1\n2\n3\n4\n5\n6\n7")).status).toBe(400);
    expect((await createEvent(org.token, "1\r\n2\r\n3\r\n4\r\n5\r\n6\r\n7")).status).toBe(400);
  });

  it("edits the description after the event ended and after reveal", async () => {
    const org = await organizer();
    const created = await createEvent(org.token, "Antes");
    const id = created.body.trip.id;
    await env.DB.prepare("UPDATE trips SET starts_at = ?, ends_at = ?, reveal_at = ? WHERE id = ?")
      .bind(Date.now() - 3 * DAY, Date.now() - 2 * DAY, Date.now() - DAY, id)
      .run();
    const res = await api("PATCH", `/trips/${id}`, { token: org.token, body: { description: " Despues " } });
    expect(res.status).toBe(200);
    expect(res.body.trip.description).toBe("Despues");
    await env.DB.prepare("UPDATE trips SET revealed_at = ? WHERE id = ?").bind(Date.now(), id).run();
    const cleared = await api("PATCH", `/trips/${id}`, { token: org.token, body: { description: "" } });
    expect(cleared.status).toBe(200);
    expect(cleared.body.trip.description).toBeNull();
    const bad = await api("PATCH", `/trips/${id}`, { token: org.token, body: { description: "a".repeat(301) } });
    expect(bad.status).toBe(400);
  });

  it("a regular trip accepts a description too", async () => {
    const org = await signUp(undefined, "Juani");
    const { tripId } = await createTrip(org.token, { description: "Notas del viaje" });
    const detail = await api("GET", `/trips/${tripId}`, { token: org.token });
    expect(detail.body.trip.description).toBe("Notas del viaje");
  });

  it("public event preview includes description", async () => {
    const org = await organizer();
    const created = await createEvent(org.token, "Premio a la mejor foto");
    const preview = await api("GET", `/events/${created.body.trip.joinCode}`);
    expect(preview.status).toBe(200);
    expect(preview.body.description).toBe("Premio a la mejor foto");
    const none = await createEvent((await organizer()).token);
    expect((await api("GET", `/events/${none.body.trip.joinCode}`)).body.description).toBeNull();
  });
});
