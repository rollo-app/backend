import { generateToken, hashToken } from "../../lib/auth";
import { sendWaitlistEmail } from "../../lib/email";
import { combinedEmailsToday, releaseEmailSlot, reserveEmailSlot, WAITLIST_COMBINED_EMAILS_PER_DAY, WAITLIST_EMAILS_PER_DAY, WAITLIST_POSTS_PER_IP_PER_DAY } from "../../lib/email-caps";
import { ipKey } from "../../lib/ip";
import { type Page, type PageQuery, paginate } from "../../lib/paging";
import type { Env } from "../../types";
import * as repo from "./waitlist.repository";
import type { WaitlistStatus } from "./waitlist.schemas";

const DAY = 24 * 60 * 60_000;
/** One confirmation email per address per 24 h. */
const RESEND_GAP = DAY;
/** The tokens are 32 random bytes in base64url (`generateToken`). */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** "send_failed" means the email provider failed (the controller answers 502, like the login code). */
export type JoinResult = "ok" | "send_failed";

/**
 * Puts an address on the waitlist (double opt-in: it only counts once the confirm link is opened).
 * Every outcome except a provider failure is the same "ok" (204): who is listed, confirmed, rate limited or capped is never revealed.
 * Caps (silent, like the new-user login caps): the IP's daily posts and the global daily waitlist emails.
 */
export async function joinWaitlist(
  env: Env,
  input: { email: string; source: "app" | "web"; rawIp: string | undefined; origin: string },
): Promise<JoinResult> {
  const { email, source, origin } = input;
  const now = Date.now();
  const ip = input.rawIp ? ipKey(input.rawIp) : null;

  const ipKind = ip ? (`waitlist_ip:${ip}` as const) : null;
  if (ipKind && !(await reserveEmailSlot(env.DB, ipKind, WAITLIST_POSTS_PER_IP_PER_DAY))) {
    console.warn("[waitlist] daily post cap reached for an IP");
    return "ok";
  }

  const entry = await repo.findByEmail(env.DB, email);
  if (entry && entry.unsubscribedAt === null) {
    if (entry.confirmedAt !== null) return "ok";
    if (entry.lastSentAt !== null && now - entry.lastSentAt < RESEND_GAP) return "ok";
  }
  // Someone who unsubscribed and asks again gets a new confirmation right away: they chose it, and only they have the link to undo it.

  if (!(await reserveEmailSlot(env.DB, "waitlist", WAITLIST_EMAILS_PER_DAY))) {
    console.warn("[waitlist] daily waitlist email cap reached");
    return "ok";
  }
  // Login codes win: past the combined budget (this slot included) the waitlist mail is not sent.
  if ((await combinedEmailsToday(env.DB)) > WAITLIST_COMBINED_EMAILS_PER_DAY) {
    await releaseEmailSlot(env.DB, "waitlist");
    console.warn("[waitlist] combined daily email budget reached");
    return "ok";
  }
  const giveBack = async () => {
    await releaseEmailSlot(env.DB, "waitlist");
    if (ipKind) await releaseEmailSlot(env.DB, ipKind);
  };

  const confirmToken = generateToken();
  const unsubscribeToken = generateToken();
  const hashes = { email, now, confirmHash: await hashToken(confirmToken), unsubscribeHash: await hashToken(unsubscribeToken) };
  // Claiming the row (and its `last_sent_at`) before sending makes two simultaneous posts send one email.
  const claim = entry
    ? await repo.restartConfirmation(env.DB, { ...hashes, expectedLastSentAt: entry.lastSentAt }).run()
    : await repo.insertEntry(env.DB, { ...hashes, source }).run();
  if (claim.meta.changes !== 1) {
    await releaseEmailSlot(env.DB, "waitlist");
    return "ok";
  }

  try {
    await sendWaitlistEmail(env, email, {
      confirmUrl: `${origin}/waitlist/confirm?token=${confirmToken}`,
      unsubscribeUrl: `${origin}/waitlist/unsubscribe?token=${unsubscribeToken}`,
    });
  } catch (err) {
    console.error(err);
    await repo.revertSend(env.DB, email, entry ? entry.lastSentAt : undefined).run();
    await giveBack();
    return "send_failed";
  }
  return "ok";
}

/** Opens the confirm link. False for a malformed or unknown token, or when the person already unsubscribed. Idempotent. */
export async function confirmWaitlist(db: D1Database, token: string | undefined): Promise<boolean> {
  if (!token || !TOKEN.test(token)) return false;
  return repo.confirmByTokenHash(db, await hashToken(token), Date.now());
}

/** Opens the unsubscribe link. False for a malformed or unknown token. Idempotent. */
export async function unsubscribeWaitlist(db: D1Database, token: string | undefined): Promise<boolean> {
  if (!token || !TOKEN.test(token)) return false;
  return repo.unsubscribeByTokenHash(db, await hashToken(token), Date.now());
}

/** Read-only check for the GET pages (scanners open them): is there a link like this that a click would act on? */
export async function peekWaitlist(db: D1Database, action: "confirm" | "unsubscribe", token: string | undefined): Promise<boolean> {
  if (!token || !TOKEN.test(token)) return false;
  return repo.tokenIsLive(db, action, await hashToken(token));
}

// ---------- Backoffice ----------

const statusOf = (r: Pick<repo.AdminWaitlistRow, "confirmedAt" | "unsubscribedAt">): WaitlistStatus =>
  r.unsubscribedAt !== null ? "unsubscribed" : r.confirmedAt !== null ? "confirmed" : "pending";

export type AdminWaitlistPage = Page<repo.AdminWaitlistRow & { status: WaitlistStatus }> & {
  totals: Awaited<ReturnType<typeof repo.statusTotals>>;
};

/** `total` follows the search and status filter (for paging); `totals` are the whole list per status (for the tabs). */
export async function listForAdmin(db: D1Database, query: PageQuery & { status: WaitlistStatus | "all" }): Promise<AdminWaitlistPage> {
  const status = query.status === "all" ? undefined : query.status;
  const [page, totals] = await Promise.all([
    paginate<repo.AdminWaitlistRow>(
      {
        rows: ({ orderBy, limit, offset }) => repo.listEntries(db, { q: query.q, status, orderBy, limit, offset }),
        count: () => repo.countEntries(db, { q: query.q, status }),
        sortable: repo.sortable,
        defaultSort: "createdAt",
      },
      query,
    ),
    repo.statusTotals(db),
  ]);
  return { ...page, items: page.items.map((r) => ({ ...r, status: statusOf(r) })), totals };
}

/** A CSV cell: quoted when needed, and a leading `= + - @` (or tab/CR) is neutralized so a spreadsheet does not run it as a formula. */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const iso = (ms: number | null) => (ms === null ? "" : new Date(ms).toISOString());

/** The mailing list: confirmed and not unsubscribed, `email,source,created_at,confirmed_at` (ISO dates), oldest first. */
export async function confirmedCsv(db: D1Database): Promise<string> {
  const rows = await repo.listConfirmed(db);
  const lines = ["email,source,created_at,confirmed_at", ...rows.map((r) => [csvCell(r.email), r.source, iso(r.createdAt), iso(r.confirmedAt)].join(","))];
  return `${lines.join("\n")}\n`;
}
