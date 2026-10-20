import { describe, expect, it } from "vitest";
import { isValidUsername, normalizeUsername } from "../src/lib/username";

describe("normalizeUsername", () => {
  it("strips one leading @, trims and lowercases", () => {
    expect(normalizeUsername("  @JuaniFraga ")).toBe("juanifraga");
    expect(normalizeUsername("cami_99")).toBe("cami_99");
  });
});

describe("isValidUsername", () => {
  it("accepts letters, digits, dot and underscore from 3 to 30 chars", () => {
    for (const u of ["abc", "juani.fraga", "a_b", "x1.y2_z3", "a".repeat(30), "1.2"]) expect(isValidUsername(u), u).toBe(true);
  });

  it("rejects bad lengths", () => {
    for (const u of ["", "ab", "a".repeat(31)]) expect(isValidUsername(u), u).toBe(false);
  });

  it("rejects other characters, uppercase and spaces", () => {
    for (const u of ["ju ani", "juani!", "ñandú", "Juani", "a-b-c", "@juani", "a@b"]) expect(isValidUsername(u), u).toBe(false);
  });

  it("rejects leading, trailing and consecutive dots", () => {
    for (const u of [".abc", "abc.", "a..b"]) expect(isValidUsername(u), u).toBe(false);
  });
});
