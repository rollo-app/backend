import { describe, expect, it } from "vitest";
import { addMembersDirect, api, newTrip, uploadMedia } from "./helpers";

describe("addMembersDirect", () => {
  it("adds 100 distinct complete members that show up in the trip detail", async () => {
    const { tripId, adminToken } = await newTrip();
    const added = await addMembersDirect(tripId, 100);

    expect(added).toHaveLength(100);
    expect(new Set(added.map((m) => m.token)).size).toBe(100);
    expect(new Set(added.map((m) => m.userId)).size).toBe(100);
    expect(new Set(added.map((m) => m.memberId)).size).toBe(100);

    const detail = await api("GET", `/trips/${tripId}`, { token: adminToken });
    expect(detail.status).toBe(200);
    expect(detail.body.members).toHaveLength(101);
  }, 60_000);

  it("returns tokens that pass requireUser and can upload", async () => {
    const { tripId } = await newTrip();
    const member = (await addMembersDirect(tripId, 1, { namePrefix: "Fede" }))[0]!;

    const detail = await api("GET", `/trips/${tripId}`, { token: member.token });
    expect(detail.status).toBe(200);
    expect(detail.body.members.some((m: any) => m.name.startsWith("Fede"))).toBe(true);

    const mediaId = await uploadMedia(tripId, member.token);
    expect(mediaId).toBeTruthy();
  });

  it("does not collide when called twice on the same trip", async () => {
    const { tripId, adminToken } = await newTrip();
    const a = await addMembersDirect(tripId, 5);
    const b = await addMembersDirect(tripId, 5);

    expect(new Set([...a, ...b].map((m) => m.userId)).size).toBe(10);
    const detail = await api("GET", `/trips/${tripId}`, { token: adminToken });
    expect(detail.body.members).toHaveLength(11);
  });
});
