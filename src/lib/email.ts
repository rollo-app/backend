import type { Deps } from "../container";
import type { OutgoingEmail } from "../ports/mailer";
import { renderLoginEmail } from "./login-email";

/** What the dev mailer records of a login email (`tag: "login-code"`): the code and the magic link, if any. */
export type LoginCodeData = { email: string; code: string; url: string | null };

/**
 * The magic-link URL. Token and email go in the fragment, which browsers never send to a server,
 * so mail scanners and link previewers that open it can't see (or burn) the token.
 */
export function loginLinkUrl(config: Deps["config"], email: string, token: string): string {
  return `${config.loginLinkUrl}#t=${token}&e=${encodeURIComponent(email)}`;
}

/**
 * Sends the login code and, when there is a link token, the magic link (without one, only the code: old app builds).
 * Delivery is up to the mailer (without a Resend key the dev mailer only logs them). Throws if delivery fails.
 */
export async function sendLoginCode(deps: Pick<Deps, "mailer" | "config">, email: string, code: string, linkToken: string | null): Promise<void> {
  const url = linkToken ? loginLinkUrl(deps.config, email, linkToken) : null;
  await deps.mailer.send({ to: email, ...renderLoginEmail({ code, url }), tag: "login-code", data: { email, code, url } satisfies LoginCodeData });
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

const REASON_LABELS: Record<string, string> = {
  offensive: "Es ofensivo",
  abuse: "Es acoso o abuso",
  other: "Otro motivo",
};

const handle = (p: Person) => (p.username ? `@${p.username}` : (p.name ?? p.email));
const describePerson = (p: Person) => `${p.name ?? "(sin nombre)"} (${p.username ? `@${p.username}` : "sin usuario"}), ${p.email}, id ${p.id}`;

export type BlockEmail = { blocker: Person; blocked: Person; adminBase: string };

const deliverToSupport = (deps: Pick<Deps, "mailer" | "config">, email: Omit<OutgoingEmail, "to">) =>
  deps.mailer.send({ to: deps.config.reportsEmail, ...email });

export const adminCurlFor = (adminBase: string, path: string) => `curl -X DELETE -H "Authorization: Bearer $ROLLO_ADMIN_TOKEN" ${adminBase}${path}`;

/**
 * Emails a report to support. Throws if delivery fails.
 * The admin commands come first and user-provided text (names, caption) last and quoted, so it cannot imitate a command.
 */
export async function sendReportEmail(deps: Pick<Deps, "mailer" | "config">, report: ReportEmail): Promise<void> {
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

  await deliverToSupport(deps, { subject, text, tag: "report", data: report });
}

/** Emails support about a new block (App Store guideline 1.2). Same delivery as `sendReportEmail`. */
export async function sendBlockEmail(deps: Pick<Deps, "mailer" | "config">, block: BlockEmail): Promise<void> {
  const subject = `Bloqueo en Rollo: ${handle(block.blocker)} bloqueó a ${handle(block.blocked)}`;
  const text = [
    "Borrar la cuenta del bloqueado:",
    adminCurlFor(block.adminBase, `/admin/users/${block.blocked.id}`),
    "",
    `Bloqueó: ${describePerson(block.blocker)}`,
    `Bloqueado: ${describePerson(block.blocked)}`,
  ].join("\n");

  await deliverToSupport(deps, { subject, text, tag: "block", data: block });
}

export type StorageAlert = { usedBytes: number; limitBytes: number; threshold: number };

const formatGB = (bytes: number) => (Math.round(bytes / 1e8) / 10).toString().replace(".", ",");

/** Emails support that the bucket crossed a share of the storage limit. Same delivery as `sendReportEmail`. */
export async function sendStorageAlert(deps: Pick<Deps, "mailer" | "config">, alert: StorageAlert): Promise<void> {
  const subject = `Rollo: almacenamiento al ${alert.threshold}% (${formatGB(alert.usedBytes)} de ${formatGB(alert.limitBytes)} GB)`;
  const text = [
    `El almacenamiento de Rollo está en ${formatGB(alert.usedBytes)} GB de ${formatGB(alert.limitBytes)} GB (superó el ${alert.threshold}%).`,
    "",
    "Al llegar al 95% se frenan las subidas nuevas (fotos, videos y avatares); ver y descargar sigue funcionando.",
    "Pasado el límite gratis de Cloudflare R2 se empieza a cobrar.",
  ].join("\n");

  await deliverToSupport(deps, { subject, text, tag: "storage-alert", data: alert });
}

/** Plain notice to support (cap alerts, the daily summary). Same delivery as the report email. Throws if delivery fails. */
export async function sendSupportNotice(deps: Pick<Deps, "mailer" | "config">, subject: string, text: string): Promise<void> {
  await deliverToSupport(deps, { subject, text, tag: "support-notice" });
}
