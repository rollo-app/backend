import { LOGIN_CODE_ALPHABET, randomFromAlphabet } from "./login-code";

export const FRIEND_CODE_LENGTH = 8;
/** A friend link works for one hour after it is generated. */
export const FRIEND_LINK_TTL = 3_600_000;
/** After opening a link, the claim token (permission to redeem it) lasts 24 hours. */
export const FRIEND_CLAIM_TTL = 86_400_000;

export const generateFriendCode = (): string => randomFromAlphabet(LOGIN_CODE_ALPHABET, FRIEND_CODE_LENGTH);

/** Canonical form of a typed friend code (no spaces or dashes, uppercase), or null if it is not 8 letters/digits. */
export function normalizeFriendCode(input: string): string | null {
  const code = input.replace(/[\s-]+/g, "").toUpperCase();
  return new RegExp(`^[A-Z0-9]{${FRIEND_CODE_LENGTH}}$`).test(code) ? code : null;
}

/** The two user ids in canonical order (friendships are stored once, with user_a < user_b). */
export function pairKey(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}
