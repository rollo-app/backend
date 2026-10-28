import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DAY, api, befriend, mockExpo, registerToken, signUp } from "./helpers";
import { flushPendingPushes } from "../src/lib/push";

const send = (token: string, userId: string) => api("POST", `/users/${userId}/friend-request`, { token });
const cancel = (token: string, userId: string) => api("DELETE", `/users/${userId}/friend-request`, { token });
const accept = (token: string, userId: string) => api("POST", `/me/friend-requests/${userId}/accept`, { token });
const reject = (token: string, userId: string) => api("POST", `/me/friend-requests/${userId}/reject`, { token });
const received = async (token: string) => (await api("GET", "/me/friend-requests", { token })).body.requests as any[];
const stateOf = async (token: string, userId: string) => (await api("GET", `/users/${userId}`, { token })).body.friendRequest;
const friendsOf = async (token: string) => (await api("GET", "/friends", { token })).body.friends as any[];
const bodies = (expo: ReturnType<typeof mockExpo>) => expo.sent.map((m) => `${m.to}: ${m.body} → ${m.data.url}`).sort();

describe("sending a friend request", () => {
  it("creates it and shows the right state on each side's profile", async () => {
    const ana = await signUp(undefined, "Ana");
    const beto = await signUp(undefined, "Beto");
    expect(await stateOf(ana.token, beto.userId)).toBe("none");

    const res = await send(ana.token, beto.userId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "sent" });

    expect(await stateOf(ana.token, beto.userId)).toBe("sent");
    expect(await stateOf(beto.token, ana.userId)).toBe("received");
    expect(await friendsOf(ana.token)).toEqual([]);
  });

  it("is idempotent while pending and does not notify twice", async () => {
    const expo = mockExpo();
    const ana = await signUp(undefined, "Ana");
    const beto = await signUp(undefined, "Beto");
    const betoPush = await registerToken(beto.token);
    await send(ana.token, beto.userId);
    expect((await send(ana.token, beto.userId)).body).toEqual({ status: "sent" });
    await flushPendingPushes();
    expect(bodies(expo)).toEqual([`${betoPush}: Ana te mandó una solicitud de amistad → /friends`]);
    expect(await received(beto.token)).toHaveLength(1);
  });

  it("answers friends when they already are", async () => {
    const ana = await signUp(undefined, "Ana");
    const beto = await signUp(undefined, "Beto");
    await befriend(ana.token, beto.token);
    expect((await send(ana.token, beto.userId)).body).toEqual({ status: "friends" });
    expect(await stateOf(ana.token, beto.userId)).toBe("none");
  });

  it("rejects yourself and unknown users", async () => {
    const ana = await signUp(undefined, "Ana");
    expect((await send(ana.token, ana.userId)).status).toBe(400);
    expect((await send(ana.token, crypto.randomUUID())).status).toBe(404);
  });

  it("requires a session", async () => {
    expect((await api("POST", `/users/${crypto.randomUUID()}/friend-request`)).status).toBe(401);
    expect((await api("GET", "/me/friend-requests")).status).toBe(401);
  });

  it("makes them friends when both sent one (crossed), and notifies the first sender", async () => {
    const expo = mockExpo();
    const ana = await signUp(undefined, "Ana");
    const beto = await signUp(undefined, "Beto");
    const anaPush = await registerToken(ana.token);
    await send(ana.token, beto.userId);
    await flushPendingPushes();
    expo.sent.length = 0;

    expect((await send(beto.token, ana.userId)).body).toEqual({ status: "friends" });
    await flushPendingPushes();

    expect((await friendsOf(ana.token)).map((f) => f.id)).toEqual([beto.userId]);
    expect((await friendsOf(beto.token)).map((f) => f.id)).toEqual([ana.userId]);
    expect(await received(ana.token)).toEqual([]);
    expect(await received(beto.token)).toEqual([]);
    expect(bodies(expo)).toEqual([`${anaPush}: Beto ahora es tu amigo → /user/${beto.userId}`]);
  });
});

describe("push for a request", () => {
  it("goes to the receiver only, and respects their setting", async () => {
    const expo = mockExpo();
    const ana = await signUp(undefined, "Ana");
    const beto = await signUp(undefined, "Beto");
    const anaPush = await registerToken(ana.token);
    const betoPush = await registerToken(beto.token);
    await send(ana.token, beto.userId);
    await flushPendingPushes();
    expect(bodies(expo)).toEqual([`${betoPush}: Ana te mandó una solicitud de amistad → /friends`]);
    expect(expo.sent.some((m) => m.to === anaPush)).toBe(false);

    const carla = await signUp(undefined, "Carla");
    await registerToken(carla.token);
    await api("PATCH", "/me/settings", { token: carla.token, body: { notifications: { friendRequest: false } } });
    expo.sent.length = 0;
    await send(ana.token, carla.userId);
    await flushPendingPushes();
    expect(expo.sent).toEqual([]);
  });

  it("settings expose friendRequest, on by default", async () => {
    const ana = await signUp();
    const res = await api("GET", "/me/settings", { token: ana.token });
    expect(res.body.notifications.friendRequest).toBe(true);
    const off = await api("PATCH", "/me/settings", { token: ana.token, body: { notifications: { friendRequest: false } } });
    expect(off.body.notifications.friendRequest).toBe(false);
  });
});

describe("cancelling", () => {
  it("removes the request on both sides", async () => {
    const ana = await signUp(undefined, "Ana");
    const beto = await signUp(undefined, "Beto");
    await send(ana.token, beto.userId);
    expect((await cancel(ana.token, beto.userId)).status).toBe(204);
    expect(await stateOf(ana.token, beto.userId)).toBe("none");
    expect(await received(beto.token)).toEqual([]);
    expect((await cancel(ana.token, beto.userId)).status).toBe(204);
  });
});

describe("received requests", () => {
  it("lists them newest first with the sender's public data", async () => {
    const ana = await signUp(undefined, "Ana", "ana1");
    const beto = await signUp(undefined, "Beto", "beto1");
    const carla = await signUp(undefined, "Carla", "carla1");
    await send(ana.token, carla.userId);
    await env.DB.prepare("UPDATE friend_requests SET created_at = created_at - 1000").run();
    await send(beto.token, carla.userId);
    const list = await received(carla.token);
    expect(list.map((r) => r.user.id)).toEqual([beto.userId, ana.userId]);
    expect(list[0].user).toEqual({ id: beto.userId, name: "Beto", username: "beto1", avatarUrl: null, bio: null });
    expect(typeof list[0].createdAt).toBe("number");
  });

  it("accepting makes them friends, clears the request and notifies the sender", async () => {
    const expo = mockExpo();
    const ana = await signUp(undefined, "Ana");
    const beto = await signUp(undefined, "Beto");
    const anaPush = await registerToken(ana.token);
    await send(ana.token, beto.userId);
    await flushPendingPushes();
    expo.sent.length = 0;

    const res = await accept(beto.token, ana.userId);
    expect(res.status).toBe(200);
    expect(res.body.friend.id).toBe(ana.userId);
    await flushPendingPushes();
    expect((await friendsOf(beto.token)).map((f) => f.id)).toEqual([ana.userId]);
    expect(await received(beto.token)).toEqual([]);
    expect(await stateOf(ana.token, beto.userId)).toBe("none");
    expect(bodies(expo)).toEqual([`${anaPush}: Beto ahora es tu amigo → /user/${beto.userId}`]);
  });

  it("404 when there is nothing to accept", async () => {
    const ana = await signUp(undefined, "Ana");
    const beto = await signUp(undefined, "Beto");
    expect((await accept(beto.token, ana.userId)).status).toBe(404);
  });

  it("rejecting is silent: the sender still sees 'sent', the receiver no longer sees it, nobody is notified", async () => {
    const expo = mockExpo();
    const ana = await signUp(undefined, "Ana");
    const beto = await signUp(undefined, "Beto");
    const anaPush = await registerToken(ana.token);
    await send(ana.token, beto.userId);
    await flushPendingPushes();
    expo.sent.length = 0;

    expect((await reject(beto.token, ana.userId)).status).toBe(204);
    await flushPendingPushes();
    expect(expo.sent.some((m) => m.to === anaPush)).toBe(false);
    expect(await received(beto.token)).toEqual([]);
    expect(await stateOf(beto.token, ana.userId)).toBe("none");
    expect(await stateOf(ana.token, beto.userId)).toBe("sent");
    expect((await accept(beto.token, ana.userId)).status).toBe(404);
    expect((await reject(beto.token, ana.userId)).status).toBe(204);
  });

  it("after a rejection the sender can resend only after 30 days (silently before)", async () => {
    const expo = mockExpo();
    const ana = await signUp(undefined, "Ana");
    const beto = await signUp(undefined, "Beto");
    const betoPush = await registerToken(beto.token);
    await send(ana.token, beto.userId);
    await reject(beto.token, ana.userId);
    await flushPendingPushes();
    expo.sent.length = 0;

    expect((await send(ana.token, beto.userId)).body).toEqual({ status: "sent" });
    await flushPendingPushes();
    expect(await received(beto.token)).toEqual([]);
    expect(expo.sent).toEqual([]);

    await env.DB.prepare("UPDATE friend_requests SET rejected_at = rejected_at - ?").bind(30 * DAY + 1000).run();
    expect((await send(ana.token, beto.userId)).body).toEqual({ status: "sent" });
    await flushPendingPushes();
    expect((await received(beto.token)).map((r) => r.user.id)).toEqual([ana.userId]);
    expect(bodies(expo)).toEqual([`${betoPush}: Ana te mandó una solicitud de amistad → /friends`]);
    expect(await stateOf(beto.token, ana.userId)).toBe("received");
  });

  it("sending to someone whose request you rejected is a new request, not instant friendship", async () => {
    const ana = await signUp(undefined, "Ana");
    const beto = await signUp(undefined, "Beto");
    await send(ana.token, beto.userId);
    await reject(beto.token, ana.userId);
    expect((await send(beto.token, ana.userId)).body).toEqual({ status: "sent" });
    expect(await friendsOf(ana.token)).toEqual([]);
    expect((await received(ana.token)).map((r) => r.user.id)).toEqual([beto.userId]);
  });

  it("a rejected request shows as sent for 30 days and then the sender can ask again", async () => {
    const ana = await signUp(undefined, "Ana");
    const beto = await signUp(undefined, "Beto");
    await send(ana.token, beto.userId);
    await reject(beto.token, ana.userId);
    expect(await stateOf(ana.token, beto.userId)).toBe("sent");
    await env.DB.prepare("UPDATE friend_requests SET rejected_at = rejected_at - ?").bind(30 * DAY + 1000).run();
    expect(await stateOf(ana.token, beto.userId)).toBe("none");
  });
});

describe("cancel tombstones and stale requests", () => {
  it("cancelling a rejected request does not skip the 30 days", async () => {
    const ana = await signUp(undefined, "Ana");
    const beto = await signUp(undefined, "Beto");
    await send(ana.token, beto.userId);
    await reject(beto.token, ana.userId);
    await cancel(ana.token, beto.userId);
    expect(await stateOf(ana.token, beto.userId)).toBe("sent");
    await send(ana.token, beto.userId);
    expect(await received(beto.token)).toEqual([]);
  });

  it("cancel and resend within a day is silent and does not use another slot of the daily cap", async () => {
    const expo = mockExpo();
    const ana = await signUp(undefined, "Ana");
    const beto = await signUp(undefined, "Beto");
    await registerToken(beto.token);
    await send(ana.token, beto.userId);
    await flushPendingPushes();
    expo.sent.length = 0;
    await cancel(ana.token, beto.userId);
    expect(await received(beto.token)).toEqual([]);
    expect((await send(ana.token, beto.userId)).body).toEqual({ status: "sent" });
    await flushPendingPushes();
    expect(expo.sent).toEqual([]);
    expect((await received(beto.token)).map((r) => r.user.id)).toEqual([ana.userId]);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM friend_requests").first<{ n: number }>();
    expect(row!.n).toBe(1);
  });

  it("cancel and resend after a day notifies again", async () => {
    const expo = mockExpo();
    const ana = await signUp(undefined, "Ana");
    const beto = await signUp(undefined, "Beto");
    await registerToken(beto.token);
    await send(ana.token, beto.userId);
    await cancel(ana.token, beto.userId);
    await env.DB.prepare("UPDATE friend_requests SET created_at = created_at - ?").bind(DAY + 1000).run();
    await flushPendingPushes();
    expo.sent.length = 0;
    await send(ana.token, beto.userId);
    await flushPendingPushes();
    expect(expo.sent).toHaveLength(1);
  });

  it("a cancelled request is not consent for a crossed send", async () => {
    const ana = await signUp(undefined, "Ana");
    const beto = await signUp(undefined, "Beto");
    await send(ana.token, beto.userId);
    await cancel(ana.token, beto.userId);
    expect((await send(beto.token, ana.userId)).body).toEqual({ status: "sent" });
    expect(await friendsOf(ana.token)).toEqual([]);
  });

  it("redeeming a friend link clears a pending request, and so does removing the friend", async () => {
    const ana = await signUp(undefined, "Ana");
    const beto = await signUp(undefined, "Beto");
    await send(ana.token, beto.userId);
    await befriend(beto.token, ana.token);
    const count = () => env.DB.prepare("SELECT COUNT(*) AS n FROM friend_requests").first<{ n: number }>().then((r) => r!.n);
    expect(await count()).toBe(0);

    await send(ana.token, beto.userId);
    await api("DELETE", `/friends/${beto.userId}`, { token: ana.token });
    expect(await stateOf(beto.token, ana.userId)).toBe("none");
    // The old request cannot be used as consent after the friendship ended.
    await env.DB.prepare("INSERT INTO friend_requests (from_user_id, to_user_id, created_at) VALUES (?, ?, ?)").bind(ana.userId, beto.userId, Date.now()).run();
    await api("DELETE", `/friends/${ana.userId}`, { token: beto.token });
    expect(await count()).toBe(0);
  });
});

describe("blocks", () => {
  it("cannot send in either direction (404) and blocking deletes pending requests", async () => {
    const ana = await signUp(undefined, "Ana");
    const beto = await signUp(undefined, "Beto");
    const carla = await signUp(undefined, "Carla");
    await send(ana.token, beto.userId);
    await send(carla.token, ana.userId);

    expect((await api("PUT", `/blocks/${beto.userId}`, { token: ana.token })).status).toBe(204);
    expect(await received(beto.token)).toEqual([]);
    expect((await send(ana.token, beto.userId)).status).toBe(404);
    expect((await send(beto.token, ana.userId)).status).toBe(404);
    expect(await stateOf(beto.token, ana.userId)).toBe("none");

    expect((await api("PUT", `/blocks/${carla.userId}`, { token: ana.token })).status).toBe(204);
    expect(await received(ana.token)).toEqual([]);
    expect((await accept(ana.token, carla.userId)).status).toBe(404);
  });

  it("deleting an account removes its requests", async () => {
    const ana = await signUp(undefined, "Ana");
    const beto = await signUp(undefined, "Beto");
    await send(ana.token, beto.userId);
    expect((await api("DELETE", "/me", { token: ana.token })).status).toBeLessThan(300);
    expect(await received(beto.token)).toEqual([]);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM friend_requests").first<{ n: number }>();
    expect(row!.n).toBe(0);
  });
});

describe("daily cap", () => {
  it("allows 30 requests in 24 hours and then answers 429; a day later it works again", async () => {
    const ana = await signUp(undefined, "Ana");
    const others = [];
    for (let i = 0; i < 31; i++) others.push(await signUp(undefined, `U${i}`));
    for (const o of others.slice(0, 30)) expect((await send(ana.token, o.userId)).status).toBe(200);
    expect((await send(ana.token, others[30]!.userId)).status).toBe(429);

    await env.DB.prepare("UPDATE friend_requests SET created_at = created_at - ?").bind(DAY + 1000).run();
    expect((await send(ana.token, others[30]!.userId)).status).toBe(200);
  }, 60_000);

  it("resending an existing pending request does not count", async () => {
    const ana = await signUp(undefined, "Ana");
    const beto = await signUp(undefined, "Beto");
    for (let i = 0; i < 35; i++) expect((await send(ana.token, beto.userId)).status).toBe(200);
  });
});
