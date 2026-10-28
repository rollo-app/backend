import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { BACKFILL_CREATOR_SQL } from "../src/lib/creator";
import { joinAs, newTrip } from "./helpers";

const backfill = (tripId: string | null) =>
  env.DB.batch(BACKFILL_CREATOR_SQL.map((sql) => env.DB.prepare(sql).bind(tripId)));
const creatorOf = (tripId: string) =>
  env.DB.prepare("SELECT created_by_user_id c FROM trips WHERE id = ?").bind(tripId).first<{ c: string | null }>();
const roleOf = (memberId: string) =>
  env.DB.prepare("SELECT role FROM members WHERE id = ?").bind(memberId).first<{ role: string }>();

describe("migration 0029 backfill", () => {
  it("migration backfills a missing creator with the oldest active admin", async () => {
    const trip = await newTrip();
    await joinAs(trip.code, "Ana");
    await env.DB.prepare("UPDATE trips SET created_by_user_id = NULL WHERE id = ?").bind(trip.tripId).run();
    await backfill(null);
    expect((await creatorOf(trip.tripId))!.c).toBe(trip.adminUserId);
  });

  it("without active admins the oldest active member becomes creator and admin", async () => {
    const trip = await newTrip();
    const ana = await joinAs(trip.code, "Ana");
    const beto = await joinAs(trip.code, "Beto");
    await env.DB.prepare("UPDATE trips SET created_by_user_id = NULL WHERE id = ?").bind(trip.tripId).run();
    // The admin left; Ana is the oldest active member.
    await env.DB.prepare("UPDATE members SET left_at = 1 WHERE id = ?").bind(trip.adminId).run();
    await backfill(trip.tripId);
    expect((await creatorOf(trip.tripId))!.c).toBe(ana.userId);
    expect((await roleOf(ana.memberId))!.role).toBe("admin");
    expect((await roleOf(beto.memberId))!.role).toBe("member");
  });

  it("scoped to one trip leaves other trips untouched", async () => {
    const a = await newTrip();
    const b = await newTrip();
    await env.DB.prepare("UPDATE trips SET created_by_user_id = NULL WHERE id IN (?, ?)").bind(a.tripId, b.tripId).run();
    await backfill(a.tripId);
    expect((await creatorOf(a.tripId))!.c).toBe(a.adminUserId);
    expect((await creatorOf(b.tripId))!.c).toBeNull();
  });
});
