import { describe, expect, it } from "vitest";
import { zoneOf } from "../src/lib/zone";

describe("zoneOf", () => {
  it("snaps a point to the center of its 0.05° cell", () => {
    // floor(-41.0806 / 0.05) = -822 → -41.1 + 0.025 = -41.075
    expect(zoneOf(-41.0806, -71.495)).toEqual({ lat: -41.075, lng: -71.475 });
  });

  it("handles positive coordinates", () => {
    expect(zoneOf(48.8584, 2.2945)).toEqual({ lat: 48.875, lng: 2.275 });
  });

  it("puts a point exactly on a boundary in the cell above it", () => {
    expect(zoneOf(0.15, -0.15)).toEqual({ lat: 0.175, lng: -0.125 });
    expect(zoneOf(0, 0)).toEqual({ lat: 0.025, lng: 0.025 });
  });

  it("rounds to 3 decimals", () => {
    const z = zoneOf(-49.33157, -72.88631)!;
    expect(z).toEqual({ lat: -49.325, lng: -72.875 });
    expect(String(z.lat).split(".")[1]!.length).toBeLessThanOrEqual(3);
  });

  it("gives the same zone for points close together in the same cell", () => {
    expect(zoneOf(-41.0806, -71.495)).toEqual(zoneOf(-41.0901, -71.4801));
  });

  it("returns null without GPS", () => {
    expect(zoneOf(null, null)).toBeNull();
    expect(zoneOf(-41.08, null)).toBeNull();
    expect(zoneOf(null, -71.49)).toBeNull();
  });
});
