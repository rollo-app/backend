import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { checkPushReceipts, sendPush } from "../src/lib/push";
import { MINUTE, api, logIn, mockExpo, registerToken, signUp } from "./helpers";

const message = { body: "Cami te sumó a Bariloche", url: "/roll?trip=t1" };

async function tokenCount(token: string) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_tokens WHERE token = ?").bind(token).first<{ n: number }>();
  return row!.n;
}

describe("sendPush", () => {
  it("sends the message to every token of the recipients, with the deep link in data", async () => {
    const expo = mockExpo();
    const a = await signUp();
    const b = await signUp();
    const a1 = await registerToken(a.token);
    const a2 = await registerToken(a.token);
    const b1 = await registerToken(b.token);

    await sendPush(env, [a.userId, b.userId], "addedToTrip", { ...message, title: "Rollo" });

    expect(expo.sent.map((m) => m.to).sort()).toEqual([a1, a2, b1].sort());
    expect(expo.sent[0]).toEqual({
      to: expect.any(String),
      title: "Rollo",
      body: "Cami te sumó a Bariloche",
      sound: "default",
      data: { url: "/roll?trip=t1" },
    });
  });

  it("leaves the title out when there is none", async () => {
    const expo = mockExpo();
    const a = await signUp();
    await registerToken(a.token);
    await sendPush(env, [a.userId], "addedToTrip", message);
    expect(expo.sent).toHaveLength(1);
    expect(expo.sent[0]).not.toHaveProperty("title");
  });

  it("never notifies the actor of their own action", async () => {
    const expo = mockExpo();
    const actor = await signUp();
    const other = await signUp();
    await registerToken(actor.token);
    const otherToken = await registerToken(other.token);
    await sendPush(env, [actor.userId, other.userId], "tripRevealed", message, { actorId: actor.userId });
    expect(expo.sent.map((m) => m.to)).toEqual([otherToken]);
  });

  it("skips recipients who turned that kind of notification off", async () => {
    const expo = mockExpo();
    const off = await signUp();
    const on = await signUp();
    await registerToken(off.token);
    const onToken = await registerToken(on.token);
    expect((await api("PATCH", "/me/settings", { token: off.token, body: { notifications: { tripStarted: false } } })).status).toBe(200);

    await sendPush(env, [off.userId, on.userId], "tripStarted", message);
    expect(expo.sent.map((m) => m.to)).toEqual([onToken]);

    // Another kind still reaches them.
    await sendPush(env, [off.userId], "tripRevealed", message);
    expect(expo.sent).toHaveLength(2);
  });

  it("skips recipients with a block with the actor, in either direction", async () => {
    const expo = mockExpo();
    const actor = await signUp();
    const blockedByActor = await signUp();
    const blockerOfActor = await signUp();
    const fine = await signUp();
    for (const u of [blockedByActor, blockerOfActor]) await registerToken(u.token);
    const fineToken = await registerToken(fine.token);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, 1)").bind(actor.userId, blockedByActor.userId),
      env.DB.prepare("INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, 1)").bind(blockerOfActor.userId, actor.userId),
    ]);

    await sendPush(env, [blockedByActor.userId, blockerOfActor.userId, fine.userId], "photoLiked", message, { actorId: actor.userId });
    expect(expo.sent.map((m) => m.to)).toEqual([fineToken]);
  });

  it("never sends to a token whose session expired", async () => {
    const expo = mockExpo();
    const a = await signUp();
    const otherPhone = await logIn(a.email);
    const expired = await registerToken(a.token, "expired");
    const valid = await registerToken(otherPhone, "valid");
    await env.DB.prepare(
      "UPDATE sessions SET expires_at = ? WHERE id = (SELECT session_id FROM push_tokens WHERE token = ?)",
    ).bind(Date.now() - 1, expired).run();

    await sendPush(env, [a.userId], "addedToTrip", message);

    expect(expo.sent.map((m) => m.to)).toEqual([valid]);
  });

  it("after another account registers the same token, the previous account no longer gets pushes there", async () => {
    const expo = mockExpo();
    const a = await signUp();
    const b = await signUp();
    const shared = await registerToken(a.token, "samephone");
    expect(await registerToken(b.token, "samephone")).toBe(shared);

    await sendPush(env, [a.userId], "addedToTrip", message);
    expect(expo.sent).toEqual([]);
    await sendPush(env, [b.userId], "addedToTrip", message);
    expect(expo.sent.map((m) => m.to)).toEqual([shared]);
  });

  it("does not call Expo when nobody has a token", async () => {
    const expo = mockExpo();
    const a = await signUp();
    await sendPush(env, [a.userId], "addedToTrip", message);
    expect(expo.sendBatches).toEqual([]);
  });

  it("sends in batches of at most 100", async () => {
    const expo = mockExpo();
    const a = await signUp();
    const now = Date.now();
    const session = await env.DB.prepare("SELECT id FROM sessions WHERE user_id = ?").bind(a.userId).first<{ id: string }>();
    await env.DB.batch(
      Array.from({ length: 150 }, (_, i) =>
        env.DB.prepare("INSERT INTO push_tokens (token, user_id, session_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)").bind(
          `ExponentPushToken[t${i}]`, a.userId, session!.id, now, now,
        ),
      ),
    );
    await sendPush(env, [a.userId], "addedToTrip", message);
    expect(expo.sendBatches).toEqual([100, 50]);
  });

  it("deletes tokens whose ticket says DeviceNotRegistered and keeps the ids of the ok tickets for the receipts", async () => {
    const a = await signUp();
    const dead = await registerToken(a.token, "dead");
    const alive = await registerToken(a.token, "alive");
    mockExpo({
      ticketFor: (m) =>
        m.to === dead
          ? { status: "error", message: "not registered", details: { error: "DeviceNotRegistered" } }
          : { status: "ok", id: "ticket-alive" },
    });

    await sendPush(env, [a.userId], "addedToTrip", message);

    expect(await tokenCount(dead)).toBe(0);
    expect(await tokenCount(alive)).toBe(1);
    const { results } = await env.DB.prepare("SELECT id, token FROM push_receipts").all();
    expect(results).toEqual([{ id: "ticket-alive", token: alive }]);
  });

  it("never throws when Expo fails", async () => {
    mockExpo({ fail: true });
    const a = await signUp();
    const t = await registerToken(a.token);
    await expect(sendPush(env, [a.userId], "addedToTrip", message)).resolves.toBeUndefined();
    expect(await tokenCount(t)).toBe(1);
  });
});

describe("checkPushReceipts", () => {
  async function addReceipt(id: string, token: string, createdAt: number) {
    await env.DB.prepare("INSERT INTO push_receipts (id, token, created_at) VALUES (?, ?, ?)").bind(id, token, createdAt).run();
  }
  async function receiptIds() {
    const { results } = await env.DB.prepare("SELECT id FROM push_receipts ORDER BY id").all<{ id: string }>();
    return results.map((r) => r.id);
  }

  it("asks for the receipts older than 15 minutes and deletes the tokens that are not registered anymore", async () => {
    const a = await signUp();
    const dead = await registerToken(a.token, "dead");
    const alive = await registerToken(a.token, "alive");
    const now = Date.now();
    await addReceipt("r-dead", dead, now - 20 * MINUTE);
    await addReceipt("r-alive", alive, now - 20 * MINUTE);
    await addReceipt("r-recent", alive, now - 5 * MINUTE);
    const expo = mockExpo({
      receipts: {
        "r-dead": { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } },
        "r-alive": { status: "ok" },
      },
    });

    await checkPushReceipts(env, now);

    expect(expo.receiptRequests).toEqual([["r-dead", "r-alive"].sort()]);
    expect(await tokenCount(dead)).toBe(0);
    expect(await tokenCount(alive)).toBe(1);
    // Answered receipts are done; the recent one waits for a later run.
    expect(await receiptIds()).toEqual(["r-recent"]);
  });

  it("keeps a receipt Expo did not answer yet, until it is a day old", async () => {
    const a = await signUp();
    const t = await registerToken(a.token);
    const now = Date.now();
    await addReceipt("r-pending", t, now - 20 * MINUTE);
    await addReceipt("r-stale", t, now - 25 * 60 * MINUTE);
    mockExpo({ receipts: {} });

    await checkPushReceipts(env, now);

    expect(await receiptIds()).toEqual(["r-pending"]);
    expect(await tokenCount(t)).toBe(1);
  });

  it("does nothing without receipts to check", async () => {
    const expo = mockExpo();
    await checkPushReceipts(env, Date.now());
    expect(expo.receiptRequests).toEqual([]);
  });

  it("never throws when Expo fails", async () => {
    const a = await signUp();
    const t = await registerToken(a.token);
    await addReceipt("r1", t, Date.now() - 20 * MINUTE);
    mockExpo({ fail: true });
    await expect(checkPushReceipts(env, Date.now())).resolves.toBeUndefined();
    expect(await receiptIds()).toEqual(["r1"]);
  });
});
