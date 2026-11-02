import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, befriend, join, newTrip, signUp } from "./helpers";

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
});
