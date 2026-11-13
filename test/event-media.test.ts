import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { resolveMediaGroups } from "../src/modules/media/media.service";
import { DAY, api, createTrip, newTrip, photoBody, signUp, uploadMedia, grantEvents } from "./helpers";

type Guest = { token: string; memberId: string };

/** Event with groups A and B, an organizer and one guest in A and B (`both`), one only in A (`ga`) and one only in B (`gb`). */
async function eventWithGuests(overrides: Record<string, unknown> = {}) {
  const org = await signUp(undefined, "Org");
  await grantEvents(org.userId);
  const { tripId, code } = await createTrip(org.token, {
    type: "event",
    groups: ["A", "B"],
    photoLimitMode: "total",
    totalPhotoLimit: 20,
    dailyPhotoLimit: undefined,
    dailyVideoLimit: undefined,
    ...overrides,
  });
  const detail = await api("GET", `/trips/${tripId}`, { token: org.token });
  const [a, b] = (detail.body.trip.groups as { id: string }[]).map((g) => g.id) as [string, string];
  const guest = async (name: string, groupIds: string[]): Promise<Guest> => {
    const user = await signUp(undefined, name);
    const res = await api("POST", "/trips/join", { token: user.token, body: { code, groupIds } });
    if (res.status !== 201) throw new Error(`join failed: ${res.status} ${JSON.stringify(res.body)}`);
    return { token: user.token, memberId: res.body.member.id };
  };
  const both = await guest("Both", [a, b]);
  const ga = await guest("Ga", [a]);
  const gb = await guest("Gb", [b]);
  return { org, tripId, code, a, b, both, ga, gb, guest };
}

const groupsOf = async (mediaId: string) =>
  (await env.DB.prepare("SELECT group_id FROM media_groups WHERE media_id = ? ORDER BY group_id").bind(mediaId).all<{ group_id: string }>()).results.map(
    (r) => r.group_id,
  );

const reveal = (tripId: string) => env.DB.prepare("UPDATE trips SET reveal_at = ? WHERE id = ?").bind(Date.now() - DAY, tripId).run();

const feedIds = async (tripId: string, token: string) => {
  const res = await api("GET", `/trips/${tripId}/feed`, { token });
  expect(res.status).toBe(200);
  return (res.body.items as { id: string }[]).map((i) => i.id);
};

describe("sending a photo to groups of an event", () => {
  it("a guest's photo goes to the chosen groups", async () => {
    const ev = await eventWithGuests();
    const id = await uploadMedia(ev.tripId, ev.both.token, { groupIds: [ev.b] });
    expect(await groupsOf(id)).toEqual([ev.b]);
    await reveal(ev.tripId);
    expect(await feedIds(ev.tripId, ev.gb.token)).toContain(id);
    expect(await feedIds(ev.tripId, ev.ga.token)).not.toContain(id);
  });

  it("a photo sent to two groups counts once against the quota", async () => {
    const ev = await eventWithGuests({ totalPhotoLimit: 1 });
    await uploadMedia(ev.tripId, ev.both.token, { groupIds: [ev.a, ev.b] });
    const second = await api("POST", `/trips/${ev.tripId}/media`, { token: ev.both.token, body: photoBody({ groupIds: [ev.a] }) });
    expect(second.status).toBe(429);
  });

  it("stale group ids are ignored and fall back to the guest's groups", async () => {
    const ev = await eventWithGuests();
    const me = await ev.guest("Moved", [ev.a, ev.b]);
    // The guest leaves A (queued photos still name it) and a group id that was deleted never existed here.
    await env.DB.prepare("DELETE FROM member_groups WHERE member_id = ? AND group_id = ?").bind(me.memberId, ev.a).run();
    const id = crypto.randomUUID();
    const body = photoBody({ id, groupIds: [ev.a, crypto.randomUUID()] });
    const res = await api("POST", `/trips/${ev.tripId}/media`, { token: me.token, body });
    expect(res.status).toBe(201);
    expect(await groupsOf(id)).toEqual([ev.b]);
  });

  it("an organizer can send to all groups", async () => {
    const ev = await eventWithGuests();
    const id = await uploadMedia(ev.tripId, ev.org.token, { groupIds: [ev.a, ev.b] });
    expect(await groupsOf(id)).toEqual([ev.a, ev.b].sort());
    await reveal(ev.tripId);
    expect(await feedIds(ev.tripId, ev.ga.token)).toContain(id);
    expect(await feedIds(ev.tripId, ev.gb.token)).toContain(id);
  });

  it("an organizer's photo with no groups goes to all of them", async () => {
    const ev = await eventWithGuests();
    const id = await uploadMedia(ev.tripId, ev.org.token);
    expect(await groupsOf(id)).toEqual([ev.a, ev.b].sort());
  });

  it("a group created later does not see an all-groups photo", async () => {
    const ev = await eventWithGuests();
    const id = await uploadMedia(ev.tripId, ev.org.token, { groupIds: [ev.a, ev.b] });
    const late = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO event_groups (id, trip_id, name, position, created_at) VALUES (?, ?, 'C', 2, ?)").bind(late, ev.tripId, Date.now()).run();
    const gc = await ev.guest("Gc", [late]);
    await reveal(ev.tripId);
    expect(await groupsOf(id)).not.toContain(late);
    expect(await feedIds(ev.tripId, gc.token)).not.toContain(id);
  });

  it("register is idempotent with groups", async () => {
    const ev = await eventWithGuests();
    const body = photoBody({ groupIds: [ev.a, ev.b] });
    expect((await api("POST", `/trips/${ev.tripId}/media`, { token: ev.both.token, body })).status).toBe(201);
    // The retry (even naming other groups) neither duplicates nor changes the stored ones.
    const retry = await api("POST", `/trips/${ev.tripId}/media`, { token: ev.both.token, body: { ...body, groupIds: [ev.a] } });
    expect(retry.status).toBe(200);
    expect(await groupsOf(body.id)).toEqual([ev.a, ev.b].sort());
  });

  it("groupIds is ignored in a regular rollo", async () => {
    const { tripId, adminToken } = await newTrip();
    const id = await uploadMedia(tripId, adminToken, { groupIds: [crypto.randomUUID()] });
    expect(await groupsOf(id)).toEqual([]);
  });

  it("rejects more than 30 group ids", async () => {
    const ev = await eventWithGuests();
    const ids = Array.from({ length: 31 }, () => crypto.randomUUID());
    const res = await api("POST", `/trips/${ev.tripId}/media`, { token: ev.both.token, body: photoBody({ groupIds: ids }) });
    expect(res.status).toBe(400);
  });
});

describe("resolveMediaGroups", () => {
  const base = { memberGroupIds: ["a", "b"], allGroupIds: ["a", "b", "c"] };

  it("a guest keeps the requested groups they are in", () => {
    expect(resolveMediaGroups({ ...base, requested: ["b", "c"], isAdmin: false })).toEqual(["b"]);
  });

  it("a guest with none valid goes to their own groups", () => {
    expect(resolveMediaGroups({ ...base, requested: ["c", "zzz"], isAdmin: false })).toEqual(["a", "b"]);
    expect(resolveMediaGroups({ ...base, requested: [], isAdmin: false })).toEqual(["a", "b"]);
  });

  it("an admin keeps the requested groups that exist", () => {
    expect(resolveMediaGroups({ ...base, requested: ["c", "zzz"], isAdmin: true })).toEqual(["c"]);
  });

  it("an admin with none valid goes to all groups", () => {
    expect(resolveMediaGroups({ ...base, requested: ["zzz"], isAdmin: true })).toEqual(["a", "b", "c"]);
    expect(resolveMediaGroups({ ...base, requested: [], isAdmin: true })).toEqual(["a", "b", "c"]);
  });

  it("drops duplicates", () => {
    expect(resolveMediaGroups({ ...base, requested: ["a", "a"], isAdmin: false })).toEqual(["a"]);
  });
});
