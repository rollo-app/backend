/** No 0/O or 1/I/L so it can be read out loud and typed without doubts. 31 characters. */
export const LOGIN_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const LOGIN_CODE_LENGTH = 6;
/** How long an emailed login code stays valid. */
export const LOGIN_CODE_TTL = 5 * 60_000;

/** Random string from `alphabet` using rejection sampling, so every character is equally likely (no modulo bias). */
export function randomFromAlphabet(alphabet: string, length: number): string {
  const limit = 256 - (256 % alphabet.length); // bytes >= limit are discarded
  const buf = new Uint8Array(length * 2);
  let out = "";
  while (out.length < length) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < limit && out.length < length) out += alphabet[b % alphabet.length];
    }
  }
  return out;
}

export const generateLoginCode = (): string => randomFromAlphabet(LOGIN_CODE_ALPHABET, LOGIN_CODE_LENGTH);

/**
 * Canonical form of a typed code (trim, uppercase, no spaces or dashes), or null if it is malformed
 * (empty, too long, or with characters that can't be in a code). The alphabet is not enforced here
 * so the configured App Review code keeps working whatever it is.
 */
export function normalizeLoginCode(input: string): string | null {
  const code = input.replace(/[\s-]+/g, "").toUpperCase();
  return /^[A-Z0-9]{1,12}$/.test(code) ? code : null;
}
