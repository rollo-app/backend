import { describe, expect, it } from "vitest";
import {
  MIN_DAY_WINDOW_MS,
  MOMENT_WINDOW_MS,
  dayWindow,
  drawNotifyAt,
  tripDays,
  type MomentTrip,
} from "../src/lib/moments";

const BA = "America/Argentina/Buenos_Aires"; // UTC-3, no DST
const H = 3_600_000;
const M = 60_000;

// Local Buenos Aires time to UTC ms.
const ba = (day: string, hh: number, mm = 0) => Date.parse(`${day}T00:00:00Z`) + (hh + 3) * H + mm * M;

function trip(startsAt: number, endsAt: number, timezone = BA): MomentTrip {
  return { starts_at: startsAt, ends_at: endsAt, timezone, moment_window_start: 540, moment_window_end: 1380 };
}

describe("tripDays", () => {
  it("lists local dates from start to end inclusive", () => {
    const t = trip(ba("2027-01-11", 10), ba("2027-01-14", 20));
    expect(tripDays(t)).toEqual(["2027-01-11", "2027-01-12", "2027-01-13", "2027-01-14"]);
  });

  it("uses the trip time zone, not UTC", () => {
    // 23:30 local on the 11th is already the 12th in UTC
    const t = trip(ba("2027-01-11", 23, 30), ba("2027-01-12", 12));
    expect(tripDays(t)).toEqual(["2027-01-11", "2027-01-12"]);
  });
});

describe("dayWindow", () => {
  const t = trip(ba("2027-01-11", 8), ba("2027-01-14", 23, 59));

  it("covers 9:00 to 23:00 local on a full day", () => {
    expect(dayWindow(t, "2027-01-12")).toEqual({ from: ba("2027-01-12", 9), to: ba("2027-01-12", 23) });
  });

  it("starts at starts_at on the first day", () => {
    const t2 = trip(ba("2027-01-11", 15), ba("2027-01-14", 23, 59));
    expect(dayWindow(t2, "2027-01-11")?.from).toBe(ba("2027-01-11", 15));
  });

  it("ends 5 minutes before ends_at on the last day", () => {
    const t2 = trip(ba("2027-01-11", 8), ba("2027-01-14", 18));
    expect(dayWindow(t2, "2027-01-14")?.to).toBe(ba("2027-01-14", 17, 55));
  });

  it("returns null when starts_at leaves under 30 minutes", () => {
    const t2 = trip(ba("2027-01-11", 22, 45), ba("2027-01-14", 23, 59));
    expect(dayWindow(t2, "2027-01-11")).toBeNull();
  });

  it("returns null when ends_at leaves under 30 minutes", () => {
    const t2 = trip(ba("2027-01-11", 8), ba("2027-01-14", 9, 10));
    expect(dayWindow(t2, "2027-01-14")).toBeNull();
  });

  it("keeps 9:00 and 23:00 local across a DST change", () => {
    const tz = "America/Santiago";
    const t2 = trip(Date.parse("2027-04-03T12:00:00Z"), Date.parse("2027-04-06T12:00:00Z"), tz);
    const w = dayWindow(t2, "2027-04-04")!;
    const fmt = (ms: number) =>
      new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
        new Date(ms),
      );
    expect(fmt(w.from)).toBe("09:00");
    expect(fmt(w.to)).toBe("23:00");
    const before = dayWindow(t2, "2027-04-03")!;
    expect(w.from - before.from).not.toBe(24 * H); // offset changed between days
  });
});

describe("drawNotifyAt", () => {
  const w = { from: ba("2027-01-12", 9), to: ba("2027-01-12", 23) };

  it("returns from when random is 0", () => {
    expect(drawNotifyAt(w, () => 0)).toBe(w.from);
  });

  it("never exceeds to", () => {
    expect(drawNotifyAt(w, () => 0.999999)).toBeLessThanOrEqual(w.to);
  });

  it("is always a whole minute inside the window", () => {
    for (let i = 0; i < 200; i++) {
      const v = drawNotifyAt(w, Math.random);
      expect(v % M).toBe(0);
      expect(v).toBeGreaterThanOrEqual(w.from);
      expect(v).toBeLessThanOrEqual(w.to);
    }
  });

  it("rounds into the window when from is not on a minute", () => {
    const odd = { from: ba("2027-01-12", 9) + 30_000, to: ba("2027-01-12", 10) + 30_000 };
    for (const r of [0, 0.5, 0.999999]) {
      const v = drawNotifyAt(odd, () => r);
      expect(v % M).toBe(0);
      expect(v).toBeGreaterThanOrEqual(odd.from);
      expect(v).toBeLessThanOrEqual(odd.to);
    }
  });

  it("exposes the constants", () => {
    expect(MOMENT_WINDOW_MS).toBe(300_000);
    expect(MIN_DAY_WINDOW_MS).toBe(1_800_000);
  });
});
