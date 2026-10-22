import { describe, expect, it } from "vitest";
import { LOGIN_CODE_ALPHABET } from "../src/lib/login-code";
import { FRIEND_CODE_LENGTH, generateFriendCode, normalizeFriendCode, pairKey } from "../src/lib/friend-code";

describe("friend code", () => {
  it("generates 8 characters from the login alphabet", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateFriendCode();
      expect(code).toHaveLength(FRIEND_CODE_LENGTH);
      for (const ch of code) expect(LOGIN_CODE_ALPHABET).toContain(ch);
    }
  });

  it("normalizes case, spaces and dashes", () => {
    expect(normalizeFriendCode(" k7m2-qx9a ")).toBe("K7M2QX9A");
  });

  it("rejects malformed codes", () => {
    expect(normalizeFriendCode("abc")).toBeNull();
    expect(normalizeFriendCode("K7M2QX9AB")).toBeNull();
    expect(normalizeFriendCode("K7M2QX9!")).toBeNull();
  });

  it("orders a pair of user ids", () => {
    expect(pairKey("b", "a")).toEqual(["a", "b"]);
    expect(pairKey("a", "b")).toEqual(["a", "b"]);
  });
});
