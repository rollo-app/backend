import { adminCurlFor, sendSupportNotice } from "../../lib/email";
import { MODERATION_ACTIONS_PER_DAY, reserveEmailSlot, SUPPORT_EMAILS_PER_DAY, SUPPORT_EMAILS_PER_USER_PER_DAY } from "../../lib/email-caps";
import type { Env } from "../../types";
import * as repo from "./moderation.repository";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether the user already made the maximum of reports (or blocks) in the last 24 hours. */
export async function atModerationActionCap(db: D1Database, table: "reports" | "blocks", userId: string): Promise<boolean> {
  return (await repo.countActionsSince(db, table, userId, Date.now() - DAY_MS)) >= MODERATION_ACTIONS_PER_DAY;
}

export const MODERATION_ACTION_CAP_MESSAGE = "Hiciste muchas denuncias o bloqueos hoy. Probá mañana.";

/**
 * Whether a moderation email may be sent for this user. Call after inserting the new report/block row,
 * so the count includes it: the 3rd is still emailed, the 4th is not. Also takes a slot of the global daily support cap
 * (`SUPPORT_EMAILS_PER_DAY`), so call it only when an email will actually be sent.
 */
export async function withinModerationEmailCap(db: D1Database, userId: string): Promise<boolean> {
  const n = await repo.countReportsAndBlocksSince(db, userId, Date.now() - DAY_MS);
  return n <= SUPPORT_EMAILS_PER_USER_PER_DAY && (await reserveEmailSlot(db, "support", SUPPORT_EMAILS_PER_DAY));
}

/** The cron has no request to take the origin from. */
const ADMIN_BASE = "https://rollo-api.juanifraga.com";
/** Rows younger than this may still be on their way out by email (the route clears the flag after sending). */
const GRACE = 10 * 60_000;
const MAX_LISTED = 40;

/**
 * Once per UTC day, ONE email to support listing the reports and blocks that were stored without email
 * (support caps, or Resend failing), then marks them as notified. Not counted against the support cap.
 * Does nothing if there are none. The day is claimed first so overlapping cron runs send a single email;
 * a failed send gives the claim back so the next run retries.
 */
export async function sendModerationSummary(env: Env, now: number): Promise<void> {
  const before = now - GRACE;
  const [reports, blocks] = await Promise.all([
    repo.listUnemailedReports(env.DB, before),
    repo.listUnemailedBlocks(env.DB, before),
  ]);
  if (!reports.results.length && !blocks.results.length) return;

  const day = new Date(now).toISOString().slice(0, 10);
  if (!(await repo.claimSummaryDay(env.DB, day))) return;

  const lines: string[] = [];
  if (reports.results.length) {
    lines.push(`Denuncias sin mail: ${reports.results.length}`);
    for (const r of reports.results.slice(0, MAX_LISTED)) {
      lines.push(`- ${r.reason}: denunció ${r.reporter_id}, denunciado ${r.target_user_id}`);
      if (r.media_id) lines.push(`  ${adminCurlFor(ADMIN_BASE, `/admin/media/${r.media_id}`)}`);
      lines.push(`  ${adminCurlFor(ADMIN_BASE, `/admin/users/${r.target_user_id}`)}`);
    }
    if (reports.results.length > MAX_LISTED) lines.push(`... y ${reports.results.length - MAX_LISTED} más`);
    lines.push("");
  }
  if (blocks.results.length) {
    lines.push(`Bloqueos sin mail: ${blocks.results.length}`);
    for (const b of blocks.results.slice(0, MAX_LISTED)) {
      lines.push(`- ${b.blocker_id} bloqueó a ${b.blocked_id}`);
      lines.push(`  ${adminCurlFor(ADMIN_BASE, `/admin/users/${b.blocked_id}`)}`);
    }
    if (blocks.results.length > MAX_LISTED) lines.push(`... y ${blocks.results.length - MAX_LISTED} más`);
  }

  try {
    await sendSupportNotice(env, `Rollo: ${reports.results.length} denuncias y ${blocks.results.length} bloqueos sin mail`, lines.join("\n"));
  } catch (err) {
    await repo.releaseSummaryDay(env.DB, day);
    throw err;
  }
  await env.DB.batch([
    ...reports.results.map((r) => repo.markReportEmailed(env.DB, r.id)),
    ...blocks.results.map((b) => repo.markBlockEmailed(env.DB, b.blocker_id, b.blocked_id)),
  ]);
}
