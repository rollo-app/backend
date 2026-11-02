import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, befriend, join, joinAs, newTrip, signUp, uploadMedia } from "./helpers";

const clearUsername = (userId: string) => env.DB.prepare("UPDATE users SET username = NULL WHERE id = ?").bind(userId).run();

describe("incomplete accounts are invisible outside their rollos", () => {
  it("an incomplete account's profile is not found", async () => {
    const a = await signUp();
    const b = await signUp();
    await befriend(a.token, b.token);
    await clearUsername(b.userId);
    const res = await api("GET", `/users/${b.userId}`, { token: a.token });
    expect(res.status).toBe(404);
  });

  it("incomplete accounts are left out of friend lists", async () => {
    const a = await signUp();
    const b = await signUp();
    const c = await signUp();
    await befriend(a.token, b.token);
    await befriend(a.token, c.token);
    await befriend(b.token, c.token);
    await clearUsername(b.userId);
    const mine = await api("GET", "/friends", { token: a.token });
    const ids = JSON.stringify(mine.body);
    expect(ids).toContain(c.userId);
    expect(ids).not.toContain(b.userId);
    const theirs = await api("GET", `/users/${c.userId}/friends`, { token: a.token });
    expect(theirs.status).toBe(200);
    expect(JSON.stringify(theirs.body)).not.toContain(b.userId);
  });

  it("incomplete accounts are left out of received requests", async () => {
    const a = await signUp();
    const b = await signUp();
    await clearUsername(b.userId);
    await env.DB.prepare("INSERT INTO friend_requests (from_user_id, to_user_id, created_at) VALUES (?, ?, ?)")
      .bind(b.userId, a.userId, Date.now())
      .run();
    const res = await api("GET", "/me/friend-requests", { token: a.token });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(b.userId);
  });

  it("incomplete members still show inside their rollos", async () => {
    const { tripId, code, adminToken } = await newTrip();
    const b = await signUp();
    await join(code, b.token);
    await clearUsername(b.userId);
    const res = await api("GET", `/trips/${tripId}`, { token: adminToken });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain(b.userId);
  });

  it("an incomplete owner's friend list and featured photos are not found", async () => {
    const a = await signUp();
    const b = await signUp();
    await befriend(a.token, b.token);
    await clearUsername(b.userId);
    await env.DB.prepare("UPDATE users SET profile_visibility = 'public' WHERE id = ?").bind(b.userId).run();
    expect((await api("GET", `/users/${b.userId}/friends`, { token: a.token })).status).toBe(404);
    expect((await api("GET", `/users/${b.userId}/featured`, { token: a.token })).status).toBe(404);
    expect((await api("GET", `/featured/${b.userId}/${crypto.randomUUID()}/thumb`, { token: a.token })).status).toBe(404);
  });

  it("an incomplete account that featured your photo is not listed in featured-by", async () => {
    const trip = await newTrip({ dailyPhotoLimit: 10 });
    const fede = await joinAs(trip.code, "Fede");
    const photo = await uploadMedia(trip.tripId, trip.adminToken);
    await api("POST", `/trips/${trip.tripId}/reveal`, { token: trip.adminToken });
    await befriend(trip.adminToken, fede.token);
    expect((await api("PUT", `/me/featured/${photo}`, { token: fede.token })).status).toBe(204);
    const before = await api("GET", "/me/featured-by", { token: trip.adminToken });
    expect(before.body.total).toBe(1);
    await clearUsername(fede.userId);
    const after = await api("GET", "/me/featured-by", { token: trip.adminToken });
    expect(after.body).toEqual({ items: [], nextCursor: null, total: 0 });
  });
});
