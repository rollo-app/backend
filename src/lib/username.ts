/** Message for a username that breaks the format rules. */
export const USERNAME_INVALID_MESSAGE = "El nombre de usuario puede tener letras, números, punto y guion bajo (3 a 30).";

/** Message for a username that belongs to someone else. */
export const USERNAME_TAKEN_MESSAGE = "Ese nombre de usuario ya está en uso.";

/** Canonical form: no leading `@`, trimmed, lowercase. This is what is stored and compared. */
export function normalizeUsername(input: string): string {
  const trimmed = input.trim();
  return (trimmed.startsWith("@") ? trimmed.slice(1) : trimmed).trim().toLowerCase();
}

/** Checks an already normalized username: a-z 0-9 . _, 3 to 30 chars, no leading/trailing dot, no "..". */
export function isValidUsername(username: string): boolean {
  return /^[a-z0-9._]{3,30}$/.test(username) && !username.startsWith(".") && !username.endsWith(".") && !username.includes("..");
}
