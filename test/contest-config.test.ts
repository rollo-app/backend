import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { addMediaDirect, api, createTrip, grantEvents, signUp } from "./helpers";
import { CONTEST_MIN_REVEAL_GAP_MS } from "../src/modules/contest/contest.rules";

const HOUR = 3_600_000;
const GAP_MESSAGE = "Con concurso, el revelado tiene que ser al menos 2 horas después del fin, para que elijas las finalistas.";

async function organizer() {
  const org = await signUp(undefined, "Org");
  await grantEvents(org.userId);
  return org;
}

function createEvent(token: string, extra: Record<string, unknown> = {}, revealGapMs = 3 * HOUR) {
  const now = Date.now();
  return api("POST", "/trips", {
    token,
    body: {
      name: "Boda",
      timezone: "America/Argentina/Buenos_Aires",
      startsAt: now + HOUR,
      endsAt: now + 2 * HOUR,
      revealAt: now + 2 * HOUR + revealGapMs,
      type: "event",
      groups: ["A"],
      ...extra,
    },
  });
}

describe("event contest config", () => {
  it("the gap constant is 2 hours", () => {
    expect(CONTEST_MIN_REVEAL_GAP_MS).toBe(2 * HOUR);
  });

  it("contest is off by default", async () => {
    const org = await organizer();
    const res = await createEvent(org.token);
    expect(res.status).toBe(201);
    expect(res.body.trip.contest).toEqual({ enabled: false, votingHours: 72 });
  });

  it("a regular trip has a null contest", async () => {
    const org = await signUp(undefined, "Juani");
    const { tripId } = await createTrip(org.token);
    const detail = await api("GET", `/trips/${tripId}`, { token: org.token });
    expect(detail.body.trip.contest).toBeNull();
  });

  it("creates an event with the contest on and 5 voting days", async () => {
    const org = await organizer();
    const res = await createEvent(org.token, { contestEnabled: true, contestVotingHours: 120 });
    expect(res.status).toBe(201);
    expect(res.body.trip.contest).toEqual({ enabled: true, votingHours: 120 });
    const detail = await api("GET", `/trips/${res.body.trip.id}`, { token: org.token });
    expect(detail.body.trip.contest).toEqual({ enabled: true, votingHours: 120 });
  });

  it("rejects contest in a regular trip", async () => {
    const org = await signUp(undefined, "Juani");
    const now = Date.now();
    const res = await api("POST", "/trips", {
      token: org.token,
      body: { name: "Viaje", timezone: "America/Argentina/Buenos_Aires", startsAt: now + HOUR, endsAt: now + 2 * HOUR, revealAt: now + 3 * HOUR, contestEnabled: true },
    });
    expect(res.status).toBe(400);
    const { tripId } = await createTrip(org.token);
    const patch = await api("PATCH", `/trips/${tripId}`, { token: org.token, body: { contestEnabled: true } });
    expect(patch.status).toBe(400);
  });

  it("rejects reveal closer than 2 hours to the end with the contest on", async () => {
    const org = await organizer();
    const res = await createEvent(org.token, { contestEnabled: true }, HOUR);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(GAP_MESSAGE);
    // Exactly 2 hours is fine, and the gap is not enforced with the contest off.
    expect((await createEvent(org.token, { contestEnabled: true }, 2 * HOUR)).status).toBe(201);
    expect((await createEvent((await organizer()).token, {}, 0)).status).toBe(201);

    const other = await organizer();
    const ok = await createEvent(other.token, { contestEnabled: true });
    const id = ok.body.trip.id;
    const patch = await api("PATCH", `/trips/${id}`, { token: other.token, body: { revealAt: ok.body.trip.endsAt + HOUR } });
    expect(patch.status).toBe(409);
    expect(patch.body.error).toBe(GAP_MESSAGE);
    const moveEnd = await api("PATCH", `/trips/${id}`, { token: other.token, body: { endsAt: ok.body.trip.revealAt - HOUR } });
    expect(moveEnd.status).toBe(409);
    expect(moveEnd.body.error).toBe(GAP_MESSAGE);
  });

  it("turning the contest on via PATCH checks the gap against the stored dates", async () => {
    const org = await organizer();
    const created = await createEvent(org.token, {}, HOUR);
    const id = created.body.trip.id;
    const bad = await api("PATCH", `/trips/${id}`, { token: org.token, body: { contestEnabled: true } });
    expect(bad.status).toBe(409);
    expect(bad.body.error).toBe(GAP_MESSAGE);
    // Moving the reveal in the same request makes it valid.
    const ok = await api("PATCH", `/trips/${id}`, { token: org.token, body: { contestEnabled: true, revealAt: created.body.trip.endsAt + 2 * HOUR } });
    expect(ok.status).toBe(200);
    expect(ok.body.trip.contest).toEqual({ enabled: true, votingHours: 72 });
    const hours = await api("PATCH", `/trips/${id}`, { token: org.token, body: { contestVotingHours: 48 } });
    expect(hours.body.trip.contest).toEqual({ enabled: true, votingHours: 48 });
  });

  it("voting hours out of range", async () => {
    const org = await organizer();
    for (const hours of [23, 337]) {
      expect((await createEvent(org.token, { contestVotingHours: hours })).status).toBe(400);
    }
    expect((await createEvent(org.token, { contestVotingHours: 24 })).status).toBe(201);
    const o2 = await organizer();
    const own = await createEvent(o2.token);
    for (const hours of [23, 337]) {
      const res = await api("PATCH", `/trips/${own.body.trip.id}`, { token: o2.token, body: { contestVotingHours: hours } });
      expect(res.status).toBe(400);
    }
  });

  it("contest settings frozen after reveal", async () => {
    const org = await organizer();
    const created = await createEvent(org.token, { contestEnabled: true });
    const id = created.body.trip.id;
    await env.DB.prepare("UPDATE trips SET starts_at = ?, ends_at = ?, reveal_at = ?, revealed_at = ? WHERE id = ?")
      .bind(Date.now() - 4 * HOUR, Date.now() - 3 * HOUR, Date.now() - HOUR, Date.now() - HOUR, id)
      .run();
    for (const body of [{ contestEnabled: false }, { contestVotingHours: 48 }]) {
      const res = await api("PATCH", `/trips/${id}`, { token: org.token, body });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("Este evento ya se reveló.");
    }
  });

  it("turning the contest off deletes chosen finalists", async () => {
    const org = await organizer();
    const created = await createEvent(org.token, { contestEnabled: true });
    const id = created.body.trip.id;
    const member = await env.DB.prepare("SELECT id FROM members WHERE trip_id = ? AND user_id = ?").bind(id, org.userId).first<{ id: string }>();
    const [mediaId] = await addMediaDirect(id, [{ userId: org.userId, memberId: member!.id }], 1);
    await env.DB.prepare("INSERT INTO contest_finalists (trip_id, media_id, position, created_at) VALUES (?, ?, 0, ?)")
      .bind(id, mediaId, Date.now())
      .run();
    const res = await api("PATCH", `/trips/${id}`, { token: org.token, body: { contestEnabled: false } });
    expect(res.status).toBe(200);
    expect(res.body.trip.contest.enabled).toBe(false);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM contest_finalists WHERE trip_id = ?").bind(id).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("editing contest settings after ends_at but before reveal is allowed", async () => {
    const org = await organizer();
    const created = await createEvent(org.token, {});
    const id = created.body.trip.id;
    const now = Date.now();
    await env.DB.prepare("UPDATE trips SET starts_at = ?, ends_at = ?, reveal_at = ? WHERE id = ?")
      .bind(now - 4 * HOUR, now - 3 * HOUR, now + 2 * HOUR, id)
      .run();
    const on = await api("PATCH", `/trips/${id}`, { token: org.token, body: { contestEnabled: true, contestVotingHours: 96 } });
    expect(on.status).toBe(200);
    expect(on.body.trip.contest).toEqual({ enabled: true, votingHours: 96 });
    const off = await api("PATCH", `/trips/${id}`, { token: org.token, body: { contestEnabled: false } });
    expect(off.status).toBe(200);
  });
});
