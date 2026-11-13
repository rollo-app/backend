import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { canSeeMediaInTrip, mediaVisibleToSql } from "../src/lib/event-visibility";
import { flushPendingPushes } from "../src/lib/push";
import { DAY, addMediaDirect, addMembersDirect, api, createTrip, joinAs, mockExpo, newTrip, putFiles, registerToken, signUp, uploadMedia } from "./helpers";

type Guest = { token: string; userId: string; memberId: string };

/** Revealed event with groups A and B: guest `ga` in A, guest `gb` in B, the organizer, a photo of `ga` in A and one of `gb` in B. */
async function revealedEvent() {
  const org = await signUp(undefined, "Org");
  const { tripId, code, memberId: orgMemberId } = await createTrip(org.token, {
    type: "event",
    groups: ["A", "B"],
    photoLimitMode: "total",
    totalPhotoLimit: 20,
    dailyPhotoLimit: undefined,
    dailyVideoLimit: undefined,
  });
  const detail = await api("GET", `/trips/${tripId}`, { token: org.token });
  const [a, b] = (detail.body.trip.groups as { id: string }[]).map((g) => g.id) as [string, string];
  const guest = async (name: string, groupIds: string[]): Promise<Guest> => {
    const user = await signUp(undefined, name);
    const res = await api("POST", "/trips/join", { token: user.token, body: { code, groupIds } });
    if (res.status !== 201) throw new Error(`join failed: ${res.status} ${JSON.stringify(res.body)}`);
    return { token: user.token, userId: user.userId, memberId: res.body.member.id };
  };
  const ga = await guest("Ga", [a]);
  const gb = await guest("Gb", [b]);
  const photo = async (author: Guest, groupIds: string[]) => {
    const [id] = await addMediaDirect(tripId, [author], 1);
    for (const g of groupIds) await env.DB.prepare("INSERT INTO media_groups (media_id, group_id) VALUES (?, ?)").bind(id, g).run();
    await putFiles(tripId, id!);
    return id!;
  };
  const photoA = await photo(ga, [a]);
  const photoB = await photo(gb, [b]);
  await env.DB.prepare("UPDATE trips SET reveal_at = ? WHERE id = ?").bind(Date.now() - DAY, tripId).run();
  return { org: { ...org, memberId: orgMemberId }, tripId, code, a, b, ga, gb, photoA, photoB, photo, guest };
}

const feedIds = async (tripId: string, token: string) => {
  const res = await api("GET", `/trips/${tripId}/feed`, { token });
  expect(res.status).toBe(200);
  return (res.body.items as { id: string }[]).map((i) => i.id).sort();
};

describe("event photo visibility by group", () => {
  it("a guest sees only photos of their groups in the feed", async () => {
    const ev = await revealedEvent();
    expect(await feedIds(ev.tripId, ev.ga.token)).toEqual([ev.photoA]);
    expect(await feedIds(ev.tripId, ev.gb.token)).toEqual([ev.photoB]);
    expect(await feedIds(ev.tripId, ev.org.token)).toEqual([ev.photoA, ev.photoB].sort());
  });

  it("feed items carry their groupIds, only in events", async () => {
    const ev = await revealedEvent();
    const res = await api("GET", `/trips/${ev.tripId}/feed`, { token: ev.org.token });
    const byId = new Map((res.body.items as { id: string; groupIds: string[] }[]).map((i) => [i.id, i.groupIds]));
    expect(byId.get(ev.photoA)).toEqual([ev.a]);
    expect(byId.get(ev.photoB)).toEqual([ev.b]);
    const trip = await newTrip();
    await uploadMedia(trip.tripId, trip.adminToken);
    const tripFeed = await api("GET", `/trips/${trip.tripId}/feed`, { token: trip.adminToken });
    expect(tripFeed.body.items[0].groupIds).toEqual([]);
  });

  it("a photo in two groups is seen by both", async () => {
    const ev = await revealedEvent();
    const both = await ev.photo(ev.ga, [ev.a, ev.b]);
    expect(await feedIds(ev.tripId, ev.ga.token)).toEqual([ev.photoA, both].sort());
    expect(await feedIds(ev.tripId, ev.gb.token)).toEqual([ev.photoB, both].sort());
  });

  it("a photo in no group is seen by the organizer only", async () => {
    const ev = await revealedEvent();
    const orphan = await ev.photo(ev.gb, []);
    expect(await feedIds(ev.tripId, ev.ga.token)).toEqual([ev.photoA]);
    expect(await feedIds(ev.tripId, ev.org.token)).toContain(orphan);
  });

  it("keyset pagination keeps working with the filter", async () => {
    const ev = await revealedEvent();
    const extra: string[] = [];
    for (let i = 0; i < 4; i++) extra.push(await ev.photo(ev.ga, [ev.a]));
    for (let i = 0; i < 3; i++) await ev.photo(ev.gb, [ev.b]);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const res: { body: { items: { id: string }[]; nextCursor: string | null } } = await api(
        "GET",
        `/trips/${ev.tripId}/feed?limit=2${cursor ? `&cursor=${cursor}` : ""}`,
        { token: ev.ga.token },
      );
      seen.push(...res.body.items.map((i) => i.id));
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    expect([...seen].sort()).toEqual([ev.photoA, ...extra].sort());
  });

  it("a guest cannot download another group's photo", async () => {
    const ev = await revealedEvent();
    for (const variant of ["thumb", "original"]) {
      expect((await api("GET", `/trips/${ev.tripId}/media/${ev.photoB}/${variant}`, { token: ev.ga.token })).status).toBe(404);
      expect((await api("GET", `/trips/${ev.tripId}/media/${ev.photoA}/${variant}`, { token: ev.ga.token })).status).toBe(200);
    }
    expect((await api("GET", `/trips/${ev.tripId}/media/${ev.photoB}/thumb`, { token: ev.org.token })).status).toBe(200);
  });

  it("a guest cannot like or comment another group's photo", async () => {
    const ev = await revealedEvent();
    expect((await api("PUT", `/media/${ev.photoB}/like`, { token: ev.ga.token })).status).toBe(404);
    expect((await api("POST", `/media/${ev.photoB}/comments`, { token: ev.ga.token, body: { text: "hola" } })).status).toBe(404);
    expect((await api("GET", `/media/${ev.photoB}/comments`, { token: ev.ga.token })).status).toBe(404);
    expect((await api("PUT", `/media/${ev.photoA}/like`, { token: ev.ga.token })).status).toBe(204);
    expect((await api("POST", `/media/${ev.photoA}/comments`, { token: ev.ga.token, body: { text: "hola" } })).status).toBe(201);
    // The organizer acts on every photo.
    expect((await api("PUT", `/media/${ev.photoB}/like`, { token: ev.org.token })).status).toBe(204);
    expect((await api("POST", `/media/${ev.photoB}/comments`, { token: ev.org.token, body: { text: "linda" } })).status).toBe(201);
  });

  it("a guest cannot report or feature another group's photo", async () => {
    const ev = await revealedEvent();
    expect((await api("POST", "/reports", { token: ev.ga.token, body: { mediaId: ev.photoB, reason: "other" } })).status).toBe(404);
    expect((await api("PUT", `/me/featured/${ev.photoB}`, { token: ev.ga.token })).status).toBe(404);
  });

  it("my likes and my comments never list photos the guest stopped seeing", async () => {
    const ev = await revealedEvent();
    const other = await ev.photo(ev.gb, [ev.a]);
    expect((await api("PUT", `/media/${other}/like`, { token: ev.ga.token })).status).toBe(204);
    expect((await api("POST", `/media/${other}/comments`, { token: ev.ga.token, body: { text: "hola" } })).status).toBe(201);
    expect((await api("GET", "/me/likes", { token: ev.ga.token })).body.items.map((i: { mediaId: string }) => i.mediaId)).toEqual([other]);
    expect((await api("GET", "/me/comments", { token: ev.ga.token })).body.items).toHaveLength(1);
    // Groups can only change before the reveal: write the change straight to D1.
    await env.DB.prepare("DELETE FROM member_groups WHERE member_id = ?").bind(ev.ga.memberId).run();
    await env.DB.prepare("INSERT INTO member_groups (member_id, group_id, created_at) VALUES (?, ?, ?)").bind(ev.ga.memberId, ev.b, Date.now()).run();
    const likes = await api("GET", "/me/likes", { token: ev.ga.token });
    expect(likes.body.items).toEqual([]);
    expect(likes.body.total).toBe(0);
    const comments = await api("GET", "/me/comments", { token: ev.ga.token });
    expect(comments.body.items).toEqual([]);
    expect(comments.body.total).toBe(0);
  });

  it("members list shows organizers and shared-group guests only", async () => {
    const ev = await revealedEvent();
    // The event is already revealed (joining is closed): add the guests straight to D1.
    const addGuest = async (name: string, groupIds: string[]) => {
      const [g] = await addMembersDirect(ev.tripId, 1, { namePrefix: name });
      for (const id of groupIds) await env.DB.prepare("INSERT INTO member_groups (member_id, group_id, created_at) VALUES (?, ?, ?)").bind(g!.memberId, id, Date.now()).run();
      return g!;
    };
    const ga2 = await addGuest("Ga2", [ev.a]);
    const both = await addGuest("Both", [ev.a, ev.b]);
    const names = async (token: string) =>
      ((await api("GET", `/trips/${ev.tripId}`, { token })).body.members as { name: string }[]).map((m) => m.name.replace(/ 1$/, "")).sort();
    expect(await names(ev.ga.token)).toEqual(["Both", "Ga", "Ga2", "Org"]);
    expect(await names(ev.gb.token)).toEqual(["Both", "Gb", "Org"]);
    expect(await names(both.token)).toEqual(["Both", "Ga", "Ga2", "Gb", "Org"]);
    expect(await names(ev.org.token)).toEqual(["Both", "Ga", "Ga2", "Gb", "Org"]);
    expect(ga2.userId).toBeTruthy();
  });

  it("joining another group shows its past photos", async () => {
    const ev = await revealedEvent();
    expect(await feedIds(ev.tripId, ev.ga.token)).toEqual([ev.photoA]);
    await env.DB.prepare("INSERT INTO member_groups (member_id, group_id, created_at) VALUES (?, ?, ?)").bind(ev.ga.memberId, ev.b, Date.now()).run();
    expect(await feedIds(ev.tripId, ev.ga.token)).toEqual([ev.photoA, ev.photoB].sort());
    expect((await api("GET", `/trips/${ev.tripId}/media/${ev.photoB}/thumb`, { token: ev.ga.token })).status).toBe(200);
  });

  it("totalUploaded and my trips count only what the guest sees", async () => {
    const ev = await revealedEvent();
    const detail = await api("GET", `/trips/${ev.tripId}`, { token: ev.ga.token });
    expect(detail.body.totalUploaded).toBe(1);
    expect((await api("GET", `/trips/${ev.tripId}`, { token: ev.org.token })).body.totalUploaded).toBe(2);
    const mine = await api("GET", "/me/trips", { token: ev.ga.token });
    expect(mine.body.trips.find((t: { id: string }) => t.id === ev.tripId).totalUploaded).toBe(1);
  });

  it("the cover of my trips never comes from a photo the guest does not see", async () => {
    const ev = await revealedEvent();
    await env.DB.prepare("UPDATE media SET thumbhash = ? WHERE id = ?").bind("hashA", ev.photoA).run();
    await env.DB.prepare("UPDATE media SET thumbhash = ?, taken_at = taken_at + 1000000 WHERE id = ?").bind("hashB", ev.photoB).run();
    const mine = await api("GET", "/me/trips", { token: ev.ga.token });
    expect(mine.body.trips.find((t: { id: string }) => t.id === ev.tripId).coverThumbhash).toBe("hashA");
  });

  it("regular trips are unaffected", async () => {
    const trip = await newTrip({ dailyPhotoLimit: 10 });
    const fede = await joinAs(trip.code, "Fede");
    const p1 = await uploadMedia(trip.tripId, trip.adminToken);
    const p2 = await uploadMedia(trip.tripId, fede.token);
    await api("POST", `/trips/${trip.tripId}/reveal`, { token: trip.adminToken });
    expect(await feedIds(trip.tripId, trip.adminToken)).toEqual([p1, p2].sort());
    expect(await feedIds(trip.tripId, fede.token)).toEqual([p1, p2].sort());
    expect((await api("PUT", `/media/${p1}/like`, { token: fede.token })).status).toBe(204);
    expect((await api("GET", `/trips/${trip.tripId}/media/${p1}/thumb`, { token: fede.token })).status).toBe(200);
    expect((await api("GET", `/trips/${trip.tripId}`, { token: fede.token })).body.members).toHaveLength(2);
  });

  it("the push to earlier commenters skips those who no longer see the photo", async () => {
    const ev = await revealedEvent();
    const expo = mockExpo();
    const gbPush = await registerToken(ev.gb.token);
    const photo = await ev.photo(ev.ga, [ev.b]);
    expect((await api("POST", `/media/${photo}/comments`, { token: ev.gb.token, body: { text: "uno" } })).status).toBe(201);
    const resetWindow = () => env.DB.prepare("UPDATE media SET comment_notified_at = NULL WHERE id = ?").bind(photo).run();
    // Control: while gb still sees the photo, an earlier commenter is notified.
    await resetWindow();
    expect((await api("POST", `/media/${photo}/comments`, { token: ev.org.token, body: { text: "dos" } })).status).toBe(201);
    await flushPendingPushes();
    expect(expo.sent.filter((m) => m.to === gbPush)).toHaveLength(1);
    await env.DB.prepare("DELETE FROM member_groups WHERE member_id = ?").bind(ev.gb.memberId).run();
    await env.DB.prepare("INSERT INTO member_groups (member_id, group_id, created_at) VALUES (?, ?, ?)").bind(ev.gb.memberId, ev.a, Date.now()).run();
    await resetWindow();
    expect((await api("POST", `/media/${photo}/comments`, { token: ev.org.token, body: { text: "tres" } })).status).toBe(201);
    await flushPendingPushes();
    expect(expo.sent.filter((m) => m.to === gbPush)).toHaveLength(1);
  });

  it("an author keeps seeing their own photo after leaving its group", async () => {
    const org = await signUp(undefined, "Org");
    const { tripId, code } = await createTrip(org.token, {
      type: "event", groups: ["A", "B"], photoLimitMode: "total", totalPhotoLimit: 20, dailyPhotoLimit: undefined, dailyVideoLimit: undefined,
    });
    const [a, b] = ((await api("GET", `/trips/${tripId}`, { token: org.token })).body.trip.groups as { id: string }[]).map((g) => g.id) as [string, string];
    const join = async (name: string, groupId: string): Promise<Guest> => {
      const u = await signUp(undefined, name);
      const res = await api("POST", "/trips/join", { token: u.token, body: { code, groupIds: [groupId] } });
      return { token: u.token, userId: u.userId, memberId: res.body.member.id };
    };
    const ga = await join("Ga", a);
    const gb = await join("Gb", b);
    const [id] = await addMediaDirect(tripId, [ga], 1);
    await env.DB.prepare("INSERT INTO media_groups (media_id, group_id) VALUES (?, ?)").bind(id, a).run();
    await putFiles(tripId, id!);
    await env.DB.prepare("DELETE FROM member_groups WHERE member_id = ?").bind(ga.memberId).run();
    await env.DB.prepare("INSERT INTO member_groups (member_id, group_id, created_at) VALUES (?, ?, ?)").bind(ga.memberId, b, Date.now()).run();
    await env.DB.prepare("UPDATE trips SET reveal_at = ? WHERE id = ?").bind(Date.now() - DAY, tripId).run();
    expect(await feedIds(tripId, ga.token)).toEqual([id]);
    expect((await api("GET", `/trips/${tripId}/media/${id}/thumb`, { token: ga.token })).status).toBe(200);
    expect(await feedIds(tripId, gb.token)).toEqual([]);
    expect((await api("GET", `/trips/${tripId}/media/${id}/thumb`, { token: gb.token })).status).toBe(404);
  });

  it("before the reveal a guest's feed only lists their groups' photos", async () => {
    const ev = await revealedEvent();
    await env.DB.prepare("UPDATE trips SET reveal_at = ? WHERE id = ?").bind(Date.now() + DAY, ev.tripId).run();
    const res = await api("GET", `/trips/${ev.tripId}/feed`, { token: ev.ga.token });
    expect(res.body.revealed).toBe(false);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe(ev.photoA);
    expect(JSON.stringify(res.body)).not.toContain(ev.photoB);
    expect(await feedIds(ev.tripId, ev.org.token)).toEqual([ev.photoA, ev.photoB].sort());
  });

  it("the raw and Drizzle predicates agree", async () => {
    const ev = await revealedEvent();
    const orphan = await ev.photo(ev.ga, []);
    for (const viewer of [ev.ga, ev.gb, ev.org]) {
      for (const id of [ev.photoA, ev.photoB, orphan]) {
        const raw = await env.DB.prepare(`SELECT ${mediaVisibleToSql("?1", "?2", "?3")} AS v`).bind(viewer.userId, id, ev.tripId).first<{ v: number }>();
        const viaFeed = (await feedIds(ev.tripId, viewer.token)).includes(id);
        expect(raw!.v === 1).toBe(viaFeed);
        expect(await canSeeMediaInTrip(env.DB, viewer.userId, id, ev.tripId)).toBe(viaFeed);
      }
    }
  });

  it.each([
    ["removed", "removed_at"],
    ["left", "left_at"],
  ])("a %s author gets no like or comment push", async (_label, column) => {
    const ev = await revealedEvent();
    const expo = mockExpo();
    const gaPush = await registerToken(ev.ga.token);
    const resetWindows = () =>
      env.DB.prepare("UPDATE media SET like_notified_at = NULL, comment_notified_at = NULL WHERE id = ?").bind(ev.photoA).run();
    // Control: an active author is notified of both.
    expect((await api("PUT", `/media/${ev.photoA}/like`, { token: ev.org.token })).status).toBe(204);
    expect((await api("POST", `/media/${ev.photoA}/comments`, { token: ev.org.token, body: { text: "uno" } })).status).toBe(201);
    await flushPendingPushes();
    expect(expo.sent.filter((m) => m.to === gaPush)).toHaveLength(2);
    // The author stops being an active member: their photo still exists (and they are not its viewer any more).
    await env.DB.prepare(`UPDATE members SET ${column} = ? WHERE id = ?`).bind(Date.now(), ev.ga.memberId).run();
    await env.DB.prepare("DELETE FROM likes WHERE media_id = ?").bind(ev.photoA).run();
    await resetWindows();
    expect((await api("PUT", `/media/${ev.photoA}/like`, { token: ev.org.token })).status).toBe(204);
    expect((await api("POST", `/media/${ev.photoA}/comments`, { token: ev.org.token, body: { text: "dos" } })).status).toBe(201);
    await flushPendingPushes();
    expect(expo.sent.filter((m) => m.to === gaPush)).toHaveLength(2);
    // And they do not see it through the visibility rule either.
    const raw = await env.DB.prepare(`SELECT ${mediaVisibleToSql("?1", "?2", "?3")} AS v`).bind(ev.ga.userId, ev.photoA, ev.tripId).first<{ v: number }>();
    expect(raw!.v).toBe(0);
  });
});
