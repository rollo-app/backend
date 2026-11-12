import { describe, expect, it } from "vitest";
import { VENUE, planPartyShots, spreadTimes, venueSpot } from "../scripts/seed/large";

describe("large seed helpers", () => {
  it("spreads times inside the window, sorted", () => {
    const t = spreadTimes(500, 1000, 2000);
    expect(t).toHaveLength(500);
    expect(t.every((x, i) => x >= 1000 && x <= 2000 && (i === 0 || x >= t[i - 1]!))).toBe(true);
  });

  it("is denser in the middle of the window", () => {
    const t = spreadTimes(2000, 0, 1000);
    const middle = t.filter((x) => x >= 250 && x < 750).length;
    expect(middle).toBeGreaterThan(1000);
  });

  it("keeps spots within ~100 m of the venue", () => {
    for (let i = 0; i < 300; i++) {
      const s = venueSpot();
      if (s) {
        expect(Math.abs(s.lat - VENUE.lat)).toBeLessThan(0.001);
        expect(Math.abs(s.lng - VENUE.lng)).toBeLessThan(0.001);
      }
    }
  });

  it("plans photos for valid members, with some captions and some GPS", () => {
    const shots = planPartyShots(400, 101, 0, 1e6);
    expect(shots).toHaveLength(400);
    expect(shots.every((s) => s.type === "photo" && s.member >= 0 && s.member < 101)).toBe(true);
    expect(shots.some((s) => s.caption)).toBe(true);
    expect(shots.some((s) => s.lat !== null)).toBe(true);
  });
});
