import { describe, expect, it } from "vitest";
import { BIO_MAX_LENGTH, BIO_MAX_LINES, bioField } from "../src/schemas";
import { type SeedPhoto, planFeatured, planLikes, EXPECTED_COMMON, NO_USERNAME, SEED_BIOS, SEED_FRIENDSHIPS, commonTripsProblem, tripPhase } from "../scripts/seed/people";

const lines = (s: string) => s.split(/\r\n|\r|\n/).length;

describe("seed bios", () => {
  it("are all valid for PATCH /me", () => {
    for (const [name, bio] of Object.entries(SEED_BIOS)) expect(bioField.safeParse(bio).success, name).toBe(true);
  });

  it("cover a short one, one at the length limit and one with several lines", () => {
    const bios = Object.values(SEED_BIOS);
    expect(bios.some((b) => b.length <= 40 && lines(b) === 1)).toBe(true);
    expect(bios.some((b) => b.length === BIO_MAX_LENGTH)).toBe(true);
    expect(bios.some((b) => lines(b) >= 2 && lines(b) <= BIO_MAX_LINES)).toBe(true);
  });
});

describe("seed friendships", () => {
  it("has no duplicates and no self-friendships", () => {
    const keys = SEED_FRIENDSHIPS.map(([a, b]) => [a, b].sort().join("|"));
    expect(new Set(keys).size).toBe(keys.length);
    for (const [a, b] of SEED_FRIENDSHIPS) expect(a).not.toBe(b);
  });

  it("has an expectation for every friend of Juani", () => {
    const juanisFriends = SEED_FRIENDSHIPS.flatMap(([a, b]) => (a === "Juani" ? [b] : b === "Juani" ? [a] : []));
    expect(juanisFriends.sort()).toEqual(Object.keys(EXPECTED_COMMON).sort());
  });

  it("leaves a user without username only outside Juani's friends", () => {
    for (const name of NO_USERNAME) expect(EXPECTED_COMMON[name]).toBeUndefined();
  });
});

describe("commonTripsProblem", () => {
  it("accepts exactly the expected trips, in any order", () => {
    expect(commonTripsProblem({ exactly: ["A", "B"] }, ["B", "A"])).toBeNull();
    expect(commonTripsProblem({ exactly: [] }, [])).toBeNull();
  });

  it("reports missing or extra trips", () => {
    expect(commonTripsProblem({ exactly: ["A"] }, [])).toMatch(/A/);
    expect(commonTripsProblem({ exactly: [] }, ["Secreto"])).toMatch(/Secreto/);
  });

  it("checks a minimum and trips that must not show up", () => {
    expect(commonTripsProblem({ atLeast: 2, excludes: ["X"] }, ["A", "B"])).toBeNull();
    expect(commonTripsProblem({ atLeast: 2 }, ["A"])).toMatch(/2/);
    expect(commonTripsProblem({ excludes: ["X"] }, ["A", "X"])).toMatch(/X/);
  });
});

describe("tripPhase", () => {
  const now = 1_000_000;
  const trip = (startsAt: number, endsAt: number, revealAt: number, revealedAt: number | null = null) => ({ startsAt, endsAt, revealAt, revealedAt });

  it("names the phase of a trip at a given instant", () => {
    expect(tripPhase(trip(now + 10, now + 20, now + 30), now)).toBe("por empezar");
    expect(tripPhase(trip(now - 10, now + 20, now + 30), now)).toBe("en curso");
    expect(tripPhase(trip(now - 30, now - 20, now + 30), now)).toBe("terminado, sin revelar");
    expect(tripPhase(trip(now - 30, now - 20, now - 10), now)).toBe("revelado");
    expect(tripPhase(trip(now - 10, now + 20, now + 30, now - 1), now)).toBe("revelado");
  });
});

describe("planFeatured", () => {
  const photos = (spec: [string, number][]): SeedPhoto[] =>
    spec.flatMap(([author, n]) => Array.from({ length: n }, (_, i) => ({ id: `${author}-${i}`, author })));

  it("Cami blocks her first photo; Juani features 3 of her own and 2 of others (Tomi and Fede); Tomi 2 of his and 1 of Juani's", () => {
    const plan = planFeatured(photos([["Cami", 3], ["Tomi", 3], ["Fede", 3], ["Juani", 4], ["Lu", 2]]));
    expect(plan.blocked).toBe("Cami-0");
    expect(plan.byUser.Juani).toEqual(["Tomi-0", "Fede-0", "Juani-0", "Juani-1", "Juani-2"]);
    expect(plan.byUser.Tomi).toEqual(["Juani-0", "Tomi-0", "Tomi-1"]);
  });

  it("falls back to other people's photos when Juani has none (a Bariloche seeded before she took photos there)", () => {
    const plan = planFeatured(photos([["Cami", 3], ["Tomi", 3], ["Fede", 3], ["Lu", 2]]));
    expect(plan.byUser.Juani).toHaveLength(5);
    expect(plan.byUser.Juani).not.toContain("Cami-0");
    expect(new Set(plan.byUser.Juani).size).toBe(5);
    expect(plan.byUser.Tomi).toEqual(["Tomi-0", "Tomi-1"]);
  });

  it("never plans the blocked photo for anyone but its author", () => {
    const plan = planFeatured(photos([["Cami", 1], ["Juani", 1]]));
    expect(plan.blocked).toBe("Cami-0");
    expect(Object.values(plan.byUser).flat()).not.toContain("Cami-0");
  });
});

describe("planLikes", () => {
  const photos = (spec: [string, number][]): SeedPhoto[] =>
    spec.flatMap(([author, n]) => Array.from({ length: n }, (_, i) => ({ id: `${author}-${i}`, author })));
  const members = ["Juani", "Cami", "Tomi", "Fede", "Lu", "Nacho"];

  it("Juani's first photo gets several likes (not hers), and Juani likes a few photos of others", () => {
    const plan = planLikes(photos([["Cami", 3], ["Tomi", 3], ["Fede", 3], ["Juani", 4], ["Lu", 2]]), members);
    const on = (id: string) => plan.filter((l) => l.mediaId === id).map((l) => l.user).sort();
    expect(on("Juani-0")).toEqual(["Cami", "Fede", "Lu", "Nacho", "Tomi"]);
    expect(on("Tomi-0")).toEqual(["Cami", "Juani"]);
    expect(on("Fede-0")).toEqual(["Juani"]);
  });

  it("never plans a like twice, and every liker is a member", () => {
    const plan = planLikes(photos([["Cami", 3], ["Tomi", 3], ["Fede", 3], ["Juani", 4]]), members);
    const keys = plan.map((l) => `${l.user}|${l.mediaId}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const l of plan) expect(members).toContain(l.user);
  });

  it("works when some authors have no photos", () => {
    expect(planLikes([], members)).toEqual([]);
    expect(planLikes(photos([["Tomi", 1]]), members).map((l) => l.user)).toEqual(["Juani", "Cami"]);
  });
});
