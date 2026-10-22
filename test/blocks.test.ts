import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { hiddenMediaSql } from "../src/lib/moderation";
import { api, befriend, joinAs, newTrip, signUp, uploadMedia } from "./helpers";

const friendsOf = async (token: string) => (await api("GET", "/friends", { token })).body.friends as any[];
const blockedOf = async (token: string) => (await api("GET", "/blocks", { token })).body.blocked as any[];

describe("blocks", () => {
  it("PUT /blocks/{id} blocks, removes the friendship and lists the user", async () => {
    const a = await signUp(undefined, "Ana");
    const b = await signUp(undefined, "Beto");
    await befriend(a.token, b.token);

    const res = await api("PUT", `/blocks/${b.userId}`, { token: a.token });
    expect(res.status).toBe(204);

    expect((await friendsOf(a.token)).map((f) => f.id)).not.toContain(b.userId);
    expect((await friendsOf(b.token)).map((f) => f.id)).not.toContain(a.userId);
    const blocked = await blockedOf(a.token);
    expect(blocked[0].id).toBe(b.userId);
    expect(blocked[0].name).toBe("Beto");
  });

  it("blocking is idempotent and one-directional", async () => {
    const a = await signUp();
    const b = await signUp();
    expect((await api("PUT", `/blocks/${b.userId}`, { token: a.token })).status).toBe(204);
    expect((await api("PUT", `/blocks/${b.userId}`, { token: a.token })).status).toBe(204);
    expect(await blockedOf(a.token)).toHaveLength(1);
    expect(await blockedOf(b.token)).toEqual([]);
  });

  it("unblocking one direction keeps the other", async () => {
    const a = await signUp();
    const b = await signUp();
    await api("PUT", `/blocks/${b.userId}`, { token: a.token });
    await api("PUT", `/blocks/${a.userId}`, { token: b.token });

    expect((await api("DELETE", `/blocks/${b.userId}`, { token: a.token })).status).toBe(204);
    expect(await blockedOf(a.token)).toEqual([]);
    expect((await blockedOf(b.token)).map((u) => u.id)).toEqual([a.userId]);
    // Unblocking someone you never blocked is still 204.
    expect((await api("DELETE", `/blocks/${b.userId}`, { token: a.token })).status).toBe(204);
  });

  it("lists blocked users by name", async () => {
    const a = await signUp();
    const z = await signUp(undefined, "Zoe");
    const m = await signUp(undefined, "Mati");
    await api("PUT", `/blocks/${z.userId}`, { token: a.token });
    await api("PUT", `/blocks/${m.userId}`, { token: a.token });
    expect((await blockedOf(a.token)).map((u) => u.name)).toEqual(["Mati", "Zoe"]);
  });

  it("cannot block yourself", async () => {
    const a = await signUp();
    const res = await api("PUT", `/blocks/${a.userId}`, { token: a.token });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("No podés bloquearte");
  });

  it("blocking an unknown user is a 404", async () => {
    const a = await signUp();
    expect((await api("PUT", `/blocks/${crypto.randomUUID()}`, { token: a.token })).status).toBe(404);
  });

  it("requires a session", async () => {
    expect((await api("GET", "/blocks")).status).toBe(401);
    expect((await api("PUT", `/blocks/${crypto.randomUUID()}`)).status).toBe(401);
    expect((await api("DELETE", `/blocks/${crypto.randomUUID()}`)).status).toBe(401);
  });
});

describe("hiddenMediaSql", () => {
  it("excludes media the viewer reported and media by authors the viewer blocked", async () => {
    const trip = await newTrip();
    const viewer = await joinAs(trip.code, "Viewer");
    const reported = await joinAs(trip.code, "Reported");
    const blockedAuthor = await joinAs(trip.code, "Blocked");
    const other = await joinAs(trip.code, "Other");
    const reportedId = await uploadMedia(trip.tripId, reported.token);
    const blockedId = await uploadMedia(trip.tripId, blockedAuthor.token);
    const otherId = await uploadMedia(trip.tripId, other.token);

    await env.DB.prepare(
      "INSERT INTO reports (id, reporter_id, media_id, target_user_id, trip_id, reason, created_at) VALUES (?, ?, ?, ?, ?, 'offensive', ?)",
    )
      .bind(crypto.randomUUID(), viewer.userId, reportedId, reported.userId, trip.tripId, Date.now())
      .run();
    await api("PUT", `/blocks/${blockedAuthor.userId}`, { token: viewer.token });

    const visibleTo = async (userId: string) => {
      const { results } = await env.DB.prepare(
        `SELECT m.id FROM media m JOIN members mem ON mem.id = m.member_id WHERE m.trip_id = ? AND ${hiddenMediaSql("m", "mem")}`,
      )
        .bind(trip.tripId, userId, userId)
        .all<{ id: string }>();
      return results.map((r) => r.id);
    };

    const forViewer = await visibleTo(viewer.userId);
    expect(forViewer).toContain(otherId);
    expect(forViewer).not.toContain(reportedId);
    expect(forViewer).not.toContain(blockedId);
    // Another user is unaffected.
    expect((await visibleTo(other.userId)).sort()).toEqual([reportedId, blockedId, otherId].sort());
  });
});
