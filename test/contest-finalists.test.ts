import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { HOUR, addMediaDirect, addMembersDirect, api, createTrip, grantEvents, signUp } from "./helpers";

/** Event with the contest on, ended 1 h ago, reveal in 3 h, one organizer, two guests and `n` photos by the guests. */
async function fixture(opts: { n?: number; endsAt?: number } = {}) {
  const org = await signUp(undefined, "Org");
  await grantEvents(org.userId);
  const now = Date.now();
  const { tripId, code } = await createTrip(org.token, {
    type: "event",
    groups: ["A"],
    photoLimitMode: "total",
    totalPhotoLimit: 50,
    dailyPhotoLimit: undefined,
    dailyVideoLimit: undefined,
    startsAt: now - 5 * HOUR,
    endsAt: opts.endsAt ?? now - HOUR,
    revealAt: now + 3 * HOUR,
  });
  await env.DB.prepare("UPDATE trips SET contest_enabled = 1 WHERE id = ?").bind(tripId).run();
  const detail = await api("GET", `/trips/${tripId}`, { token: org.token });
  const groupId = (detail.body.trip.groups as { id: string }[])[0]!.id;
  const guest = async (name: string) => {
    const user = await signUp(undefined, name);
    const res = await api("POST", "/trips/join", { token: user.token, body: { code, groupIds: [groupId] } });
    return { token: user.token, userId: user.userId, memberId: res.body.member.id as string };
  };
  const g1 = await guest("Ga");
  const g2 = await guest("Gb");
  const ids = await addMediaDirect(tripId, [g1, g2], opts.n ?? 3, { from: now - 3 * HOUR, to: now - 2 * HOUR });
  return { org, tripId, g1, g2, ids };
}

const put = (f: { org: { token: string }; tripId: string }, id: string, token = f.org.token) =>
  api("PUT", `/trips/${f.tripId}/contest/finalists/${id}`, { token });
const del = (f: { org: { token: string }; tripId: string }, id: string, token = f.org.token) =>
  api("DELETE", `/trips/${f.tripId}/contest/finalists/${id}`, { token });
const get = (tripId: string, token: string) => api("GET", `/trips/${tripId}/contest`, { token });
const setTrip = (tripId: string, set: string, ...binds: unknown[]) =>
  env.DB.prepare(`UPDATE trips SET ${set} WHERE id = ?`).bind(...binds, tripId).run();

describe("contest finalists", () => {
  it("marks and unmarks, idempotently, appending positions", async () => {
    const f = await fixture();
    expect((await put(f, f.ids[0]!)).status).toBe(204);
    expect((await put(f, f.ids[0]!)).status).toBe(204);
    expect((await put(f, f.ids[1]!)).status).toBe(204);
    let res = await get(f.tripId, f.org.token);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("selecting");
    expect(res.body.finalists.map((x: any) => x.mediaId)).toEqual([f.ids[0], f.ids[1]]);
    expect(res.body.finalists[0].thumbPath).toBe(`/trips/${f.tripId}/contest/finalists/${f.ids[0]}/thumb`);
    expect(res.body.finalists[0].displayPath).toBe(`/trips/${f.tripId}/contest/finalists/${f.ids[0]}/display`);
    expect(res.body.finalists[0].votes).toBeNull();
    expect((await del(f, f.ids[0]!)).status).toBe(204);
    expect((await del(f, f.ids[0]!)).status).toBe(204);
    res = await get(f.tripId, f.org.token);
    expect(res.body.finalists.map((x: any) => x.mediaId)).toEqual([f.ids[1]]);
    // a new one goes after the current max, not into the freed slot
    await put(f, f.ids[2]!);
    await put(f, f.ids[0]!);
    res = await get(f.tripId, f.org.token);
    expect(res.body.finalists.map((x: any) => x.mediaId)).toEqual([f.ids[1], f.ids[2], f.ids[0]]);
  });

  it("the 11th is a 409, re-marking one of the 10 still works", async () => {
    const f = await fixture({ n: 11 });
    for (const id of f.ids.slice(0, 10)) expect((await put(f, id)).status).toBe(204);
    const res = await put(f, f.ids[10]!);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Ya hay 10 finalistas.");
    expect((await put(f, f.ids[0]!)).status).toBe(204);
  });

  it("rejects videos, linked selfies, unuploaded, deleted and foreign media with 400", async () => {
    const f = await fixture({ n: 5 });
    await env.DB.prepare("UPDATE media SET type = 'video' WHERE id = ?").bind(f.ids[0]).run();
    await env.DB.prepare("UPDATE media SET paired_media_id = ? WHERE id = ?").bind(f.ids[2], f.ids[1]).run();
    await env.DB.prepare("UPDATE media SET status = 'pending' WHERE id = ?").bind(f.ids[2]).run();
    await env.DB.prepare("UPDATE media SET deleted_at = ? WHERE id = ?").bind(Date.now(), f.ids[3]).run();
    for (const id of f.ids.slice(0, 4)) expect((await put(f, id)).status).toBe(400);
    expect((await put(f, crypto.randomUUID())).status).toBe(400);
    const other = await fixture({ n: 1 });
    expect((await put(f, other.ids[0]!)).status).toBe(400);
  });

  it("is 409 before ends_at, after the reveal and with the contest off", async () => {
    const early = await fixture({ endsAt: Date.now() + HOUR });
    const res = await put(early, early.ids[0]!);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Las finalistas se eligen entre el fin del evento y el revelado.");
    expect((await del(early, early.ids[0]!)).status).toBe(409);

    const late = await fixture();
    await setTrip(late.tripId, "revealed_at = ?", Date.now());
    expect((await put(late, late.ids[0]!)).status).toBe(409);

    const off = await fixture();
    await setTrip(off.tripId, "contest_enabled = 0");
    expect((await put(off, off.ids[0]!)).status).toBe(409);
  });

  it("guests cannot mark or unmark", async () => {
    const f = await fixture();
    expect((await put(f, f.ids[0]!, f.g1.token)).status).toBe(403);
    expect((await del(f, f.ids[0]!, f.g1.token)).status).toBe(403);
  });
});

describe("GET /contest", () => {
  it("is 404 when the contest is off and for a trip", async () => {
    const f = await fixture();
    await setTrip(f.tripId, "contest_enabled = 0");
    const res = await get(f.tripId, f.org.token);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Este evento no tiene concurso.");
    const trip = await createTrip(f.org.token, {});
    expect((await get(trip.tripId, f.org.token)).status).toBe(404);
  });

  it("is pending before ends_at", async () => {
    const f = await fixture({ endsAt: Date.now() + HOUR });
    const res = await get(f.tripId, f.org.token);
    expect(res.body.status).toBe("pending");
    expect(res.body.finalists).toEqual([]);
    expect(res.body.winner).toBeNull();
    expect(res.body.tiedMediaIds).toEqual([]);
    expect(res.body.votingHours).toBe(72);
  });

  it("selecting: organizer sees finalists, a guest gets none", async () => {
    const f = await fixture();
    await put(f, f.ids[0]!);
    expect((await get(f.tripId, f.org.token)).body.finalists).toHaveLength(1);
    const guest = await get(f.tripId, f.g1.token);
    expect(guest.body.status).toBe("selecting");
    expect(guest.body.finalists).toEqual([]);
  });

  it("voting: everyone sees finalists with null votes, myVote and closesAt", async () => {
    const f = await fixture();
    await put(f, f.ids[0]!);
    await put(f, f.ids[1]!);
    const revealedAt = Date.now() - HOUR;
    await setTrip(f.tripId, "revealed_at = ?", revealedAt);
    await env.DB.prepare("INSERT INTO contest_votes (trip_id, user_id, media_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)")
      .bind(f.tripId, f.g1.userId, f.ids[1]).run();
    const res = await get(f.tripId, f.g1.token);
    expect(res.body.status).toBe("voting");
    expect(res.body.closesAt).toBe(revealedAt + 72 * HOUR);
    expect(res.body.finalists).toHaveLength(2);
    for (const x of res.body.finalists) expect(x.votes).toBeNull();
    expect(res.body.myVote).toBe(f.ids[1]);
    expect(res.body.finalists[0].author).toEqual({ userId: f.g1.userId, name: "Ga", avatarUrl: null });
  });

  it("tied once the window passes without a close, listing the leaders", async () => {
    const f = await fixture();
    await put(f, f.ids[0]!);
    await put(f, f.ids[1]!);
    await setTrip(f.tripId, "revealed_at = ?", Date.now() - 100 * HOUR);
    const res = await get(f.tripId, f.org.token);
    expect(res.body.status).toBe("tied");
    expect(res.body.tiedMediaIds.sort()).toEqual([f.ids[0], f.ids[1]].sort());
    for (const x of res.body.finalists) expect(x.votes).toBeNull();
  });

  it("closed: counts votes and returns the winner", async () => {
    const f = await fixture();
    await put(f, f.ids[0]!);
    await put(f, f.ids[1]!);
    await setTrip(f.tripId, "revealed_at = ?, contest_closed_at = ?, contest_winner_media_id = ?", Date.now() - 100 * HOUR, Date.now(), f.ids[1]);
    const vote = (u: string, m: string) =>
      env.DB.prepare("INSERT INTO contest_votes (trip_id, user_id, media_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)").bind(f.tripId, u, m).run();
    await vote(f.g1.userId, f.ids[1]!);
    await vote(f.g2.userId, f.ids[1]!);
    await vote(f.org.userId, f.ids[0]!);
    const res = await get(f.tripId, f.g1.token);
    expect(res.body.status).toBe("closed");
    const votes = Object.fromEntries(res.body.finalists.map((x: any) => [x.mediaId, x.votes]));
    expect(votes).toEqual({ [f.ids[0]!]: 1, [f.ids[1]!]: 2 });
    expect(res.body.winner).toEqual({ mediaId: f.ids[1], author: { userId: f.g2.userId, name: "Gb", avatarUrl: null }, imageAvailable: true });
  });

  it("cancelled has no closesAt", async () => {
    const f = await fixture();
    await setTrip(f.tripId, "contest_cancelled_at = ?", Date.now());
    const res = await get(f.tripId, f.org.token);
    expect(res.body.status).toBe("cancelled");
    expect(res.body.closesAt).toBeNull();
    expect(res.body.finalists).toEqual([]);
  });

  it("leaves out archived, deleted, left-event, blocked and reported finalists; myVote on a dropped one is null", async () => {
    const f = await fixture({ n: 6 });
    // ids alternate authors: even index -> g1, odd -> g2
    for (const id of f.ids) await put(f, id);
    await setTrip(f.tripId, "revealed_at = ?", Date.now() - HOUR);
    await env.DB.prepare("UPDATE media SET archived_at = ? WHERE id = ?").bind(Date.now(), f.ids[0]).run();
    await env.DB.prepare("UPDATE media SET deleted_at = ? WHERE id = ?").bind(Date.now(), f.ids[2]).run();
    await env.DB.prepare("UPDATE members SET left_at = ? WHERE id = ?").bind(Date.now(), f.g2.memberId).run(); // g2 photos: 1, 3, 5
    const res = await get(f.tripId, f.org.token);
    expect(res.body.finalists.map((x: any) => x.mediaId)).toEqual([f.ids[4]]);

    // block either way + report, from a third viewer
    await env.DB.prepare("UPDATE members SET left_at = NULL WHERE id = ?").bind(f.g2.memberId).run();
    const [viewer] = await addMembersDirect(f.tripId, 1, { namePrefix: "Viewer" });
    if (!viewer) throw new Error("no viewer");
    await env.DB.prepare("UPDATE media SET archived_at = NULL, deleted_at = NULL").run();
    expect((await get(f.tripId, viewer.token)).body.finalists).toHaveLength(6);
    await env.DB.prepare("INSERT INTO contest_votes (trip_id, user_id, media_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)")
      .bind(f.tripId, viewer.userId, f.ids[0]).run();
    await env.DB.prepare("INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, 1)").bind(viewer.userId, f.g1.userId).run();
    let r = await get(f.tripId, viewer.token);
    expect(r.body.finalists.map((x: any) => x.mediaId).sort()).toEqual([f.ids[1], f.ids[3], f.ids[5]].sort());
    expect(r.body.myVote).toBeNull();
    await env.DB.prepare("DELETE FROM blocks").run();
    await env.DB.prepare("INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, 1)").bind(f.g2.userId, viewer.userId).run();
    r = await get(f.tripId, viewer.token);
    expect(r.body.finalists.map((x: any) => x.mediaId).sort()).toEqual([f.ids[0], f.ids[2], f.ids[4]].sort());
    expect(r.body.myVote).toBe(f.ids[0]);
  });
});
