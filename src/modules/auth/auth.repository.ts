import { nameSearchColumn } from "../../lib/search-text";
import type { UserRow } from "../../types";

// Reads execute and return rows; writes return an unexecuted statement so the service decides
// whether to `.run()` it or group it with others in `db.batch([...])`.

export type AttemptRow = { id: string; code_hash: string; link_hash: string | null; link_challenge: string | null };

export type NewAuthCode = {
  id: string;
  email: string;
  codeHash: string;
  linkHash: string | null;
  linkChallenge: string | null;
  ip: string | null;
  createdAt: number;
  expiresAt: number;
};

export async function countCodes(db: D1Database, column: "email" | "ip", value: string, since: number): Promise<number> {
  return (
    (
      await db.prepare(`SELECT COUNT(*) AS n FROM auth_codes WHERE ${column} = ? AND created_at > ?`)
        .bind(value, since)
        .first<{ n: number }>()
    )?.n ?? 0
  );
}

export async function userExists(db: D1Database, email: string): Promise<boolean> {
  return !!(await db.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first());
}

export function invalidateOpenCodes(db: D1Database, email: string, now: number): D1PreparedStatement {
  return db.prepare("UPDATE auth_codes SET used_at = ? WHERE email = ? AND used_at IS NULL").bind(now, email);
}

export function insertCode(db: D1Database, c: NewAuthCode): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO auth_codes (id, email, code_hash, link_hash, link_challenge, ip, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(c.id, c.email, c.codeHash, c.linkHash, c.linkChallenge, c.ip, c.createdAt, c.expiresAt);
}

export function deleteCode(db: D1Database, id: string): D1PreparedStatement {
  return db.prepare("DELETE FROM auth_codes WHERE id = ?").bind(id);
}

/** Consumes one attempt of the email's current login code atomically; null when there is no usable code. */
export async function takeAttempt(db: D1Database, email: string, maxAttempts: number, now: number): Promise<AttemptRow | null> {
  return db
    .prepare(
      `UPDATE auth_codes SET attempts = attempts + 1
     WHERE id = (SELECT id FROM auth_codes WHERE email = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1)
       AND used_at IS NULL AND attempts < ? AND expires_at > ?
     RETURNING id, code_hash, link_hash, link_challenge`,
    )
    .bind(email, maxAttempts, now)
    .first<AttemptRow>();
}

export function markCodeUsed(db: D1Database, id: string, now: number): D1PreparedStatement {
  return db.prepare("UPDATE auth_codes SET used_at = ? WHERE id = ? AND used_at IS NULL").bind(now, id);
}

export function insertUserIfMissing(db: D1Database, id: string, email: string, now: number): D1PreparedStatement {
  return db.prepare("INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)").bind(id, email, now);
}

export async function findUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<UserRow>();
}

export type IdentityProvider = "google" | "apple";

/** The user linked to an external sign-in account (provider + its stable account id). */
export async function findUserByIdentity(db: D1Database, provider: IdentityProvider, subject: string): Promise<UserRow | null> {
  return db
    .prepare("SELECT u.* FROM user_identities i JOIN users u ON u.id = i.user_id WHERE i.provider = ? AND i.subject = ?")
    .bind(provider, subject)
    .first<UserRow>();
}

/** Links the external account to the user with that email (no-op if it is already linked). */
export function linkIdentityByEmail(
  db: D1Database,
  l: { provider: IdentityProvider; subject: string; email: string; now: number },
): D1PreparedStatement {
  return db
    .prepare("INSERT OR IGNORE INTO user_identities (provider, subject, user_id, created_at) SELECT ?, ?, id, ? FROM users WHERE email = ?")
    .bind(l.provider, l.subject, l.now, l.email);
}

/** Sets the name only if the account has none: a suggestion for the profile step, never over the user's own. */
export function setNameIfMissing(db: D1Database, email: string, name: string): D1PreparedStatement {
  return db
    .prepare("UPDATE users SET name = ?, name_search = ? WHERE email = ? AND name IS NULL")
    .bind(name, nameSearchColumn(name), email);
}

export function insertSession(
  db: D1Database,
  s: { id: string; userId: string; tokenHash: string; now: number; expiresAt: number },
): D1PreparedStatement {
  return db
    .prepare("INSERT INTO sessions (id, user_id, token_hash, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(s.id, s.userId, s.tokenHash, s.now, s.now, s.expiresAt);
}

export function deletePushTokensOfSession(db: D1Database, sessionId: string): D1PreparedStatement {
  return db.prepare("DELETE FROM push_tokens WHERE session_id = ?").bind(sessionId);
}

export function deleteSession(db: D1Database, sessionId: string): D1PreparedStatement {
  return db.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId);
}
