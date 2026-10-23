import type { Env } from "../types";
import { renderLoginEmail } from "./login-email";

/**
 * Login codes "sent" without a Resend key (local dev and tests), by email.
 * Test-visible: tests read the code from here instead of an inbox.
 */
export const devSentCodes = new Map<string, string>();

/** Magic-link URLs "sent" without a Resend key (local dev and tests), by email. */
export const devSentLinks = new Map<string, string>();

export const DEFAULT_LOGIN_LINK_URL = "https://rollo.juanifraga.com/entrar";

/**
 * The magic-link URL. Token and email go in the fragment, which browsers never send to a server,
 * so mail scanners and link previewers that open it can't see (or burn) the token.
 */
export function loginLinkUrl(env: Env, email: string, token: string): string {
  const base = env.LOGIN_LINK_URL || DEFAULT_LOGIN_LINK_URL;
  return `${base}#t=${token}&e=${encodeURIComponent(email)}`;
}

/**
 * Sends the login code and, when there is a link token, the magic link (without one, only the code: old app builds).
 * Without `RESEND_API_KEY` it only logs them (and keeps them in `devSentCodes`/`devSentLinks`).
 */
export async function sendLoginCode(env: Env, email: string, code: string, linkToken: string | null): Promise<void> {
  const url = linkToken ? loginLinkUrl(env, email, linkToken) : null;
  if (!env.RESEND_API_KEY) {
    console.log(`[auth] código para ${email}: ${code}${url ? ` · link: ${url}` : ""}`);
    devSentCodes.set(email, code);
    if (url) devSentLinks.set(email, url);
    else devSentLinks.delete(email);
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: env.EMAIL_FROM ?? "Rollo <rollo@juanifraga.com>",
      to: [email],
      ...renderLoginEmail({ code, url }),
    }),
  });
  if (!res.ok) throw new Error(`Resend responded ${res.status}`);
}

export type Person = { id: string; name: string | null; username: string | null; email: string };

export type ReportEmail = {
  reason: string;
  reporter: Person;
  target: Person;
  trip?: { name: string };
  media?: { id: string; type: "photo" | "video"; caption: string | null; takenAt: number; url: string };
  /** Origin of the API, used to build the admin commands. */
  adminBase: string;
};

/** Reports "sent" without a Resend key (local dev and tests). */
export const devSentReports: ReportEmail[] = [];

const REASON_LABELS: Record<string, string> = {
  offensive: "Es ofensivo",
  abuse: "Es acoso o abuso",
  other: "Otro motivo",
};

const handle = (p: Person) => (p.username ? `@${p.username}` : (p.name ?? p.email));
const describePerson = (p: Person) => `${p.name ?? "(sin nombre)"} (${p.username ? `@${p.username}` : "sin usuario"}), ${p.email}, id ${p.id}`;

/** Emails sent to support without a Resend key (local dev and tests): reports and blocks. */
export const devSentBlocks: BlockEmail[] = [];

export type BlockEmail = { blocker: Person; blocked: Person; adminBase: string };

async function deliverToSupport(env: Env, subject: string, text: string): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: env.EMAIL_FROM ?? "Rollo <rollo@juanifraga.com>",
      to: [env.REPORTS_EMAIL ?? "soporte@juanifraga.com"],
      subject,
      text,
    }),
  });
  if (!res.ok) throw new Error(`Resend responded ${res.status}`);
}

const adminCurlFor = (adminBase: string, path: string) => `curl -X DELETE -H "Authorization: Bearer $ROLLO_ADMIN_TOKEN" ${adminBase}${path}`;

/**
 * Emails a report to support. Without `RESEND_API_KEY` it only logs it (and keeps it in `devSentReports`). Throws if Resend fails.
 * The admin commands come first and user-provided text (names, caption) last and quoted, so it cannot imitate a command.
 */
export async function sendReportEmail(env: Env, report: ReportEmail): Promise<void> {
  const subject = report.media
    ? `Denuncia en Rollo: ${report.media.type === "video" ? "video" : "foto"} de ${handle(report.target)}`
    : `Denuncia en Rollo: ${handle(report.target)}`;

  const lines: string[] = [];
  if (report.media) lines.push("Borrar el archivo:", adminCurlFor(report.adminBase, `/admin/media/${report.media.id}`), "");
  lines.push("Borrar la cuenta:", adminCurlFor(report.adminBase, `/admin/users/${report.target.id}`), "");
  lines.push(
    `Motivo: ${REASON_LABELS[report.reason] ?? report.reason}`,
    `Denunció: ${describePerson(report.reporter)}`,
    `Denunciado: ${describePerson(report.target)}`,
  );
  if (report.trip) lines.push(`Rollo: ${report.trip.name}`);
  if (report.media) {
    lines.push(
      `${report.media.type === "video" ? "Video" : "Foto"}: ${report.media.url}`,
      `Epígrafe: ${report.media.caption === null ? "(sin epígrafe)" : JSON.stringify(report.media.caption)}`,
      `Sacada: ${new Date(report.media.takenAt).toISOString()}`,
    );
  }
  const text = lines.join("\n");

  if (!env.RESEND_API_KEY) {
    console.log(`[report] ${subject}\n${text}`);
    devSentReports.push(report);
    return;
  }
  await deliverToSupport(env, subject, text);
}

/** Emails support about a new block (App Store guideline 1.2). Same dev/Resend behavior as `sendReportEmail`. */
export async function sendBlockEmail(env: Env, block: BlockEmail): Promise<void> {
  const subject = `Bloqueo en Rollo: ${handle(block.blocker)} bloqueó a ${handle(block.blocked)}`;
  const text = [
    "Borrar la cuenta del bloqueado:",
    adminCurlFor(block.adminBase, `/admin/users/${block.blocked.id}`),
    "",
    `Bloqueó: ${describePerson(block.blocker)}`,
    `Bloqueado: ${describePerson(block.blocked)}`,
  ].join("\n");

  if (!env.RESEND_API_KEY) {
    console.log(`[block] ${subject}\n${text}`);
    devSentBlocks.push(block);
    return;
  }
  await deliverToSupport(env, subject, text);
}
