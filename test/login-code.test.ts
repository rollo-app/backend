import { describe, expect, it } from "vitest";
import {
  LOGIN_CODE_ALPHABET,
  LOGIN_CODE_LENGTH,
  LOGIN_CODE_TTL,
  generateLoginCode,
  normalizeLoginCode,
  randomFromAlphabet,
} from "../src/lib/login-code";

describe("generateLoginCode", () => {
  it("uses the documented alphabet, length and TTL", () => {
    expect(LOGIN_CODE_ALPHABET).toBe("ABCDEFGHJKMNPQRSTUVWXYZ23456789");
    expect(LOGIN_CODE_LENGTH).toBe(6);
    expect(LOGIN_CODE_TTL).toBe(5 * 60_000);
  });

  it("generates 6 uppercase characters with no ambiguous ones", () => {
    for (let i = 0; i < 500; i++) {
      const code = generateLoginCode();
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
      expect(code).not.toMatch(/[01ILO]/);
    }
  });

  it("is not constant and reaches every character of the alphabet", () => {
    const seen = new Set<string>();
    const codes = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const code = generateLoginCode();
      codes.add(code);
      for (const ch of code) seen.add(ch);
    }
    expect(codes.size).toBeGreaterThan(1990);
    expect(seen.size).toBe(LOGIN_CODE_ALPHABET.length);
  });

  it("has no modulo bias: the characters that a plain `byte % 31` would favour are not over-represented", () => {
    // 256 % 31 = 8, so with modulo the first 8 characters would appear ~14% more often.
    const counts = new Map<string, number>();
    const n = 60_000;
    for (let i = 0; i < n / 6; i++) for (const ch of randomFromAlphabet(LOGIN_CODE_ALPHABET, 6)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    const expected = n / LOGIN_CODE_ALPHABET.length;
    const head = [...LOGIN_CODE_ALPHABET.slice(0, 8)].reduce((s, ch) => s + counts.get(ch)!, 0) / 8;
    const tail = [...LOGIN_CODE_ALPHABET.slice(8)].reduce((s, ch) => s + counts.get(ch)!, 0) / 23;
    expect(Math.abs(head / expected - 1)).toBeLessThan(0.06);
    expect(Math.abs(tail / expected - 1)).toBeLessThan(0.06);
  });
});

describe("normalizeLoginCode", () => {
  it("trims, uppercases and removes spaces and dashes", () => {
    expect(normalizeLoginCode("  abc-d2 3 ")).toBe("ABCD23");
    expect(normalizeLoginCode("hub 5ft")).toBe("HUB5FT");
    expect(normalizeLoginCode("HUB-5FT")).toBe("HUB5FT");
  });

  it("returns null for malformed input", () => {
    for (const bad of ["", "   ", "---", "AB$CD2", "ÁBCD23", "A".repeat(20)]) {
      expect(normalizeLoginCode(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
