import { describe, expect, it } from "vitest";
import { HOUR, TZ, api, createTrip, signUp } from "./helpers";

const eventBody = (overrides: Record<string, unknown> = {}) => {
  const now = Date.now();
  return {
    name: "Casamiento",
    timezone: TZ,
    startsAt: now + HOUR,
    endsAt: now + 2 * HOUR,
    revealAt: now + 3 * HOUR,
    type: "event",
    groups: ["Familia de él", "Trabajo de ella"],
    photoLimitMode: "total",
    totalPhotoLimit: 20,
    ...overrides,
  };
};

describe("POST /trips (event)", () => {
  it("creates an event with its groups in order", async () => {
    const { token } = await signUp(undefined, "Org");
    const res = await api("POST", "/trips", { token, body: eventBody() });
    expect(res.status).toBe(201);
    expect(res.body.trip.type).toBe("event");
    expect(res.body.trip.groups.map((g: { name: string }) => g.name)).toEqual(["Familia de él", "Trabajo de ella"]);
    expect(res.body.trip.groups[0].id).toEqual(expect.any(String));
    expect(res.body.trip.coverUrl).toBeNull();
  });

  it("rejects an event without groups", async () => {
    const { token } = await signUp(undefined, "Org");
    expect((await api("POST", "/trips", { token, body: eventBody({ groups: [] }) })).status).toBe(400);
    expect((await api("POST", "/trips", { token, body: eventBody({ groups: undefined }) })).status).toBe(400);
  });

  it("rejects duplicate group names", async () => {
    const { token } = await signUp(undefined, "Org");
    const res = await api("POST", "/trips", { token, body: eventBody({ groups: ["Familia", "Familia"] }) });
    expect(res.status).toBe(400);
  });

  it("forces total photo limit and no moment on events", async () => {
    const { token } = await signUp(undefined, "Org");
    const created = await api("POST", "/trips", {
      token,
      body: eventBody({ photoLimitMode: "daily", momentMode: "photo", totalPhotoLimit: undefined }),
    });
    expect(created.status).toBe(201);
    const res = await api("GET", `/trips/${created.body.trip.id}`, { token });
    expect(res.status).toBe(200);
    expect(res.body.trip.photoLimitMode).toBe("total");
    expect(res.body.trip.momentMode).toBe("off");
    expect(res.body.trip.totalPhotoLimit).toBe(20);
    expect(res.body.me.groupIds).toEqual([]);
  });

  it("a regular trip reports type trip and no groups", async () => {
    const { token } = await signUp(undefined, "Org");
    const { tripId } = await createTrip(token);
    const res = await api("GET", `/trips/${tripId}`, { token });
    expect(res.body.trip.type).toBe("trip");
    expect(res.body.trip.groups).toEqual([]);
    expect(res.body.trip.coverUrl).toBeNull();
  });

  it("rejects groups on a regular trip", async () => {
    const { token } = await signUp(undefined, "Org");
    const res = await api("POST", "/trips", { token, body: eventBody({ type: "trip" }) });
    expect(res.status).toBe(400);
  });

  it("my trips list carries type and cover", async () => {
    const { token } = await signUp(undefined, "Org");
    await api("POST", "/trips", { token, body: eventBody() });
    const res = await api("GET", "/me/trips", { token });
    expect(res.status).toBe(200);
    expect(res.body.trips[0]).toMatchObject({ type: "event", coverUrl: null });
  });
});
