/** Resend's free plan allows 100 emails a day, shared by login codes and support emails. */
export const LOGIN_EMAILS_PER_DAY = 80;
export const SUPPORT_EMAILS_PER_DAY = 20;
/** Most reports and (separately) blocks a user can make per rolling 24 hours; beyond it the API answers 429. */
export const MODERATION_ACTIONS_PER_DAY = 50;

export type EmailKind = "login" | "support";

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
