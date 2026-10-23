import type { Env } from "../types";
import { sendSupportNotice } from "./email";

/** Resend's free plan allows 100 emails a day, shared by login codes and support emails. */
export const LOGIN_EMAILS_PER_DAY = 80;
/** Of the login budget, at most this many go to emails with no account yet (new sign-ups): spam of fake addresses cannot lock out existing users. */
export const LOGIN_NEW_USER_EMAILS_PER_DAY = 40;
export const SUPPORT_EMAILS_PER_DAY = 20;
/** Support emails (reports + blocks) one user can use per rolling 24 hours: two accounts cannot eat the whole daily support cap. */
export const SUPPORT_EMAILS_PER_USER_PER_DAY = 3;
/** Most reports and (separately) blocks a user can make per rolling 24 hours; beyond it the API answers 429. */
export const MODERATION_ACTIONS_PER_DAY = 50;

export type EmailKind = "login" | "login_new" | "support";

const utcDay = () => new Date().toISOString().slice(0, 10);

/**
 * Takes one slot of today's (UTC) global cap for this kind of email. Atomic: the counter is bumped and read back in one statement.
 * Returns false when the cap was already reached (the slot is not given back; call `releaseEmailSlot` if the email is not sent).
 */
export async function reserveEmailSlot(db: D1Database, kind: EmailKind, cap: number): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO email_counters (kind, day, count) VALUES (?1, ?2, 1)
       ON CONFLICT (kind, day) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(kind, utcDay())
    .first<{ count: number }>();
  return (row?.count ?? 0) <= cap;
}

/** Gives back a slot taken with `reserveEmailSlot` when the email was not actually sent. */
export async function releaseEmailSlot(db: D1Database, kind: EmailKind): Promise<void> {
  await db.prepare("UPDATE email_counters SET count = MAX(count - 1, 0) WHERE kind = ? AND day = ?").bind(kind, utcDay()).run();
}

/**
 * The first time each UTC day a cap is hit, emails support once (it takes a support slot; if those are gone too,
 * the alert is skipped). Never throws: the caller is about to answer 429.
 */
export async function alertCapReached(env: Env, kind: "login" | "login_new"): Promise<void> {
  try {
    const first = await env.DB.prepare("INSERT OR IGNORE INTO email_counters (kind, day, count) VALUES (?, ?, 1)").bind(`alert_${kind}`, utcDay()).run();
    if (first.meta.changes === 0) return;
    if (!(await reserveEmailSlot(env.DB, "support", SUPPORT_EMAILS_PER_DAY))) return;
    const what =
      kind === "login_new"
        ? `el tope diario de mails de login para cuentas nuevas (${LOGIN_NEW_USER_EMAILS_PER_DAY})`
        : `el tope diario de mails de login (${LOGIN_EMAILS_PER_DAY})`;
    await sendSupportNotice(env, `Rollo: se alcanzó ${what}`, `Se alcanzó ${what}. Hasta mañana (UTC) los pedidos que lo superen reciben 429.`);
  } catch (err) {
    console.error("[email-caps] could not send the cap alert", err);
  }
}
