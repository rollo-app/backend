import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { flushPendingPushes } from "../src/lib/push";
import { tripRevealedMessage, tripStartedMessage } from "../src/lib/trip-notices";
import { DAY, HOUR, MINUTE, api, befriend, joinAs, mockExpo, newTrip, registerToken, signUp, uploadMedia } from "./helpers";

/** Runs the Worker's Cron Trigger the way Cloudflare does and waits for everything it started. */
async function runCron(scheduledTime = Date.now()) {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ scheduledTime, cron: "*/5 * * * *" }), env, ctx);
  await waitOnExecutionContext(ctx);
}

/** Who got which push: one line per message, "token: body → url". */
function received(expo: ReturnType<typeof mockExpo>) {
  return expo.sent.map((m) => `${m.to}: ${m.body} → ${m.data.url}`).sort();
}

async function tripRow(tripId: string) {
  return (await env.DB.prepare("SELECT * FROM trips WHERE id = ?").bind(tripId).first<Record<string, number | null>>())!;
}

// ---------- Messages (pure) ----------

describe("trip notice messages", () => {
  it("started: names the rollo and today's photos", () => {
    expect(tripStartedMessage({ id: "t1", name: "Bariloche", daily_photo_limit: 10 })).toEqual({
      body: "Arrancó Bariloche. Tenés 10 fotos hoy.",
      url: "/roll?trip=t1",
    });
    expect(tripStartedMessage({ id: "t1", name: "Bariloche", daily_photo_limit: 1 }).body).toBe("Arrancó Bariloche. Tenés 1 foto hoy.");
  });

  it("revealed: names the rollo and opens the reveal", () => {
    expect(tripRevealedMessage({ id: "t1", name: "Bariloche" })).toEqual({ body: "Se reveló Bariloche", url: "/reveal?trip=t1" });
  });
});

// ---------- Events from actions ----------

describe("addedToTrip", () => {
  it("notifies whoever a member adds, not the member who adds them", async () => {
    const expo = mockExpo();
    const t = await newTrip();
    const cami = await signUp(undefined, "Cami");
    await befriend(t.adminToken, cami.token);
    const adminToken = await registerToken(t.adminToken);
    const camiToken = await registerToken(cami.token);
    await flushPendingPushes();
    expo.sent.length = 0;

    const res = await api("POST", `/trips/${t.tripId}/members`, { token: t.adminToken, body: { friendIds: [cami.userId] } });
    expect(res.status).toBe(200);
    await flushPendingPushes();

    expect(received(expo)).toEqual([`${camiToken}: Juani te sumó a Viaje al sur → /roll?trip=${t.tripId}`]);
    expect(expo.sent.some((m) => m.to === adminToken)).toBe(false);
  });

  it("does not notify someone who was already a member or could not be added", async () => {
    const expo = mockExpo();
    const t = await newTrip();
    const member = await joinAs(t.code, "Cami");
    await befriend(t.adminToken, member.token);
    const stranger = await signUp(undefined, "Tomi");
    await registerToken(member.token);
    await registerToken(stranger.token);
    await flushPendingPushes();
    expo.sent.length = 0;

    await api("POST", `/trips/${t.tripId}/members`, { token: t.adminToken, body: { friendIds: [member.userId, stranger.userId] } });
    await flushPendingPushes();
    expect(expo.sent).toEqual([]);
  });

  it("a failing Expo never breaks adding someone", async () => {
    const t = await newTrip();
    const cami = await signUp(undefined, "Cami");
    await befriend(t.adminToken, cami.token);
    await registerToken(cami.token);
    mockExpo({ fail: true });
    const res = await api("POST", `/trips/${t.tripId}/members`, { token: t.adminToken, body: { friendIds: [cami.userId] } });
    await flushPendingPushes();
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ userId: cami.userId, status: "added" }]);
  });
});

describe("newFriend", () => {
  it("notifies the owner of the link when someone redeems it", async () => {
    const expo = mockExpo();
    const juani = await signUp(undefined, "Juani");
    const tomi = await signUp(undefined, "Tomi");
    const juaniToken = await registerToken(juani.token);
    const tomiToken = await registerToken(tomi.token);

    await befriend(juani.token, tomi.token);
    await flushPendingPushes();

    expect(received(expo)).toEqual([`${juaniToken}: Tomi ahora es tu amigo → /user/${tomi.userId}`]);
    expect(expo.sent.some((m) => m.to === tomiToken)).toBe(false);
  });

  it("does not notify again when they were already friends", async () => {
    const expo = mockExpo();
    const juani = await signUp(undefined, "Juani");
    const tomi = await signUp(undefined, "Tomi");
    await registerToken(juani.token);
    await befriend(juani.token, tomi.token);
    await flushPendingPushes();
    expo.sent.length = 0;

    await befriend(juani.token, tomi.token);
    await flushPendingPushes();
    expect(expo.sent).toEqual([]);
  });

  it("also notifies when redeemed with a claim token", async () => {
    const expo = mockExpo();
    const juani = await signUp(undefined, "Juani");
    const juaniToken = await registerToken(juani.token);
    const link = await api("POST", "/friends/link", { token: juani.token });
    const claim = await api("POST", "/friend-links/claim", { body: { code: link.body.code } });
    const tomi = await signUp(undefined, "Tomi");
    expect((await api("POST", "/friends/redeem", { token: tomi.token, body: { claimToken: claim.body.claimToken } })).status).toBe(200);
    await flushPendingPushes();
    expect(received(expo)).toEqual([`${juaniToken}: Tomi ahora es tu amigo → /user/${tomi.userId}`]);
  });
});

describe("photoFeatured", () => {
  async function revealedTripWithPhoto() {
    const t = await newTrip();
    const cami = await joinAs(t.code, "Cami");
    const mediaId = await uploadMedia(t.tripId, t.adminToken);
    const ownId = await uploadMedia(t.tripId, cami.token);
    await api("POST", `/trips/${t.tripId}/reveal`, { token: t.adminToken });
    await flushPendingPushes();
    return { t, cami, mediaId, ownId };
  }

  it("notifies the author when someone features their photo", async () => {
    const expo = mockExpo();
    const { t, cami, mediaId } = await revealedTripWithPhoto();
    const juaniToken = await registerToken(t.adminToken);
    const camiToken = await registerToken(cami.token);

    expect((await api("PUT", `/me/featured/${mediaId}`, { token: cami.token })).status).toBe(204);
    await flushPendingPushes();
    expect(received(expo)).toEqual([`${juaniToken}: Cami destacó una foto tuya → /user/${cami.userId}`]);
    expect(expo.sent.some((m) => m.to === camiToken)).toBe(false);

    // Featuring it again is a no-op and does not notify.
    expo.sent.length = 0;
    await api("PUT", `/me/featured/${mediaId}`, { token: cami.token });
    await flushPendingPushes();
    expect(expo.sent).toEqual([]);
  });

  it("does not notify when you feature your own photo", async () => {
    const expo = mockExpo();
    const { cami, ownId } = await revealedTripWithPhoto();
    await registerToken(cami.token);
    expect((await api("PUT", `/me/featured/${ownId}`, { token: cami.token })).status).toBe(204);
    await flushPendingPushes();
    expect(expo.sent).toEqual([]);
  });
});

describe("tripRevealed by the admin", () => {
  it("notifies the active members right away, but not the admin", async () => {
    const expo = mockExpo();
    const t = await newTrip();
    const cami = await joinAs(t.code, "Cami");
    const gone = await joinAs(t.code, "Tomi");
    await api("DELETE", `/trips/${t.tripId}/members/me`, { token: gone.token });
    await registerToken(t.adminToken);
    const camiToken = await registerToken(cami.token);
    await registerToken(gone.token);

    expect((await api("POST", `/trips/${t.tripId}/reveal`, { token: t.adminToken })).status).toBe(200);
    await flushPendingPushes();

    expect(received(expo)).toEqual([`${camiToken}: Se reveló Viaje al sur → /reveal?trip=${t.tripId}`]);
    expect((await tripRow(t.tripId)).revealed_notified_at).not.toBeNull();
  });

  it("revealing again or the cron right after does not notify twice", async () => {
    const expo = mockExpo();
    const t = await newTrip();
    const cami = await joinAs(t.code, "Cami");
    await registerToken(cami.token);
    await api("POST", `/trips/${t.tripId}/reveal`, { token: t.adminToken });
    await flushPendingPushes();
    expect(expo.sent).toHaveLength(1);

    await api("POST", `/trips/${t.tripId}/reveal`, { token: t.adminToken });
    await flushPendingPushes();
    await runCron();
    await runCron(Date.now() + 20 * DAY);
    expect(expo.sent.filter((m) => m.body.startsWith("Se reveló"))).toHaveLength(1);
  });
});

// ---------- Cron ----------

describe("cron: tripStarted", () => {
  it("notifies every active member once when the rollo starts", async () => {
    const expo = mockExpo();
    const t = await newTrip({ startsAt: Date.now() - MINUTE });
    const cami = await joinAs(t.code, "Cami");
    const gone = await joinAs(t.code, "Tomi");
    await api("DELETE", `/trips/${t.tripId}/members/me`, { token: gone.token });
    const adminToken = await registerToken(t.adminToken);
    const camiToken = await registerToken(cami.token);
    await registerToken(gone.token);

    await runCron();
    await runCron();

    expect(received(expo)).toEqual(
      [adminToken, camiToken].map((tk) => `${tk}: Arrancó Viaje al sur. Tenés 2 fotos hoy. → /roll?trip=${t.tripId}`).sort(),
    );
    expect((await tripRow(t.tripId)).started_notified_at).not.toBeNull();
  });

  it("does not notify a rollo that has not started yet", async () => {
    const expo = mockExpo();
    const t = await newTrip({ startsAt: Date.now() + HOUR, endsAt: Date.now() + DAY, revealAt: Date.now() + 2 * DAY });
    await registerToken(t.adminToken);
    await runCron();
    expect(expo.sent).toEqual([]);
    expect((await tripRow(t.tripId)).started_notified_at).toBeNull();

    // Once it starts, the next run notifies.
    await runCron(Date.now() + 2 * HOUR);
    expect(expo.sent).toHaveLength(1);
  });

  it("skips a rollo that was already revealed when it started, and marks it", async () => {
    const expo = mockExpo();
    const t = await newTrip({ startsAt: Date.now() + HOUR, endsAt: Date.now() + DAY, revealAt: Date.now() + 2 * DAY });
    const cami = await joinAs(t.code, "Cami");
    await registerToken(cami.token);
    await api("POST", `/trips/${t.tripId}/reveal`, { token: t.adminToken });
    await flushPendingPushes();
    expo.sent.length = 0;

    await runCron(Date.now() + 2 * HOUR);
    expect(expo.sent).toEqual([]);
    expect((await tripRow(t.tripId)).started_notified_at).not.toBeNull();
  });

  it("respects the tripStarted preference", async () => {
    const expo = mockExpo();
    const t = await newTrip({ startsAt: Date.now() - MINUTE });
    await registerToken(t.adminToken);
    await api("PATCH", "/me/settings", { token: t.adminToken, body: { notifications: { tripStarted: false } } });
    await runCron();
    expect(expo.sent).toEqual([]);
  });
});

describe("cron: tripRevealed", () => {
  it("notifies every active member once when revealAt passes", async () => {
    const expo = mockExpo();
    const now = Date.now();
    const t = await newTrip({ startsAt: now - 2 * DAY, endsAt: now - DAY, revealAt: now - MINUTE });
    await env.DB.prepare("UPDATE trips SET started_notified_at = 1 WHERE id = ?").bind(t.tripId).run();
    const adminToken = await registerToken(t.adminToken);

    await runCron(now);
    await runCron(now + 5 * MINUTE);

    expect(received(expo)).toEqual([`${adminToken}: Se reveló Viaje al sur → /reveal?trip=${t.tripId}`]);
    expect((await tripRow(t.tripId)).revealed_notified_at).not.toBeNull();
  });

  it("a rollo that started and revealed between two runs only says it revealed", async () => {
    const expo = mockExpo();
    const now = Date.now();
    const t = await newTrip({ startsAt: now + MINUTE, endsAt: now + 2 * MINUTE, revealAt: now + 3 * MINUTE });
    const adminToken = await registerToken(t.adminToken);

    await runCron(now + 5 * MINUTE);

    expect(received(expo)).toEqual([`${adminToken}: Se reveló Viaje al sur → /reveal?trip=${t.tripId}`]);
    const row = await tripRow(t.tripId);
    expect(row.started_notified_at).not.toBeNull();
    expect(row.revealed_notified_at).not.toBeNull();
  });
});

describe("cron: receipts", () => {
  it("deletes the tokens whose receipt says DeviceNotRegistered", async () => {
    const u = await signUp();
    const dead = await registerToken(u.token, "dead");
    await env.DB.prepare("INSERT INTO push_receipts (id, token, created_at) VALUES ('r1', ?, ?)").bind(dead, Date.now() - 20 * MINUTE).run();
    mockExpo({ receipts: { r1: { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } } } });

    await runCron();

    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_tokens").first<{ n: number }>();
    expect(row!.n).toBe(0);
  });
});
