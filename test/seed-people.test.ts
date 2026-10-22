import { describe, expect, it } from "vitest";
import { BIO_MAX_LENGTH, BIO_MAX_LINES, bioField } from "../src/schemas";
import { EXPECTED_COMMON, NO_USERNAME, SEED_BIOS, SEED_FRIENDSHIPS, commonTripsProblem, tripPhase } from "../scripts/seed/people";

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
