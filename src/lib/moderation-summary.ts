import type { Env } from "../types";
import { adminCurlFor, sendSupportNotice } from "./email";

/** The cron has no request to take the origin from. */
const ADMIN_BASE = "https://rollo-api.juanifraga.com";
/** Rows younger than this may still be on their way out by email (the route clears the flag after sending). */
const GRACE = 10 * 60_000;
const MAX_LISTED = 40;

type PendingReport = { id: string; reporter_id: string; media_id: string | null; target_user_id: string; reason: string };
type PendingBlock = { blocker_id: string; blocked_id: string };

/**
 * Once per UTC day, ONE email to support listing the reports and blocks that were stored without email
 * (support caps, or Resend failing), then marks them as notified. Not counted against the support cap.
 * Does nothing if there are none. The day is claimed first so overlapping cron runs send a single email;
 * a failed send gives the claim back so the next run retries.
 */
export async function sendModerationSummary(env: Env, now: number): Promise<void> {
  const before = now - GRACE;
  const [reports, blocks] = await Promise.all([
    env.DB.prepare("SELECT id, reporter_id, media_id, target_user_id, reason FROM reports WHERE unemailed = 1 AND created_at < ? ORDER BY created_at LIMIT 500")
      .bind(before)
      .all<PendingReport>(),
    env.DB.prepare("SELECT blocker_id, blocked_id FROM blocks WHERE unemailed = 1 AND created_at < ? ORDER BY created_at LIMIT 500")
      .bind(before)
      .all<PendingBlock>(),
  ]);
  if (!reports.results.length && !blocks.results.length) return;

  const day = new Date(now).toISOString().slice(0, 10);
  const claim = await env.DB.prepare("INSERT OR IGNORE INTO email_counters (kind, day, count) VALUES ('summary', ?, 1)").bind(day).run();
  if (claim.meta.changes === 0) return;

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
    await env.DB.prepare("DELETE FROM email_counters WHERE kind = 'summary' AND day = ?").bind(day).run();
    throw err;
  }
  await env.DB.batch([
    ...reports.results.map((r) => env.DB.prepare("UPDATE reports SET unemailed = 0 WHERE id = ?").bind(r.id)),
    ...blocks.results.map((b) => env.DB.prepare("UPDATE blocks SET unemailed = 0 WHERE blocker_id = ? AND blocked_id = ?").bind(b.blocker_id, b.blocked_id)),
  ]);
}
