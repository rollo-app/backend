import type { Env } from "../types";

/**
 * Login codes "sent" without a Resend key (local dev and tests), by email.
 * Test-visible: tests read the code from here instead of an inbox.
 */
export const devSentCodes = new Map<string, string>();

/** Sends the login code. Without `RESEND_API_KEY` it only logs it (and keeps it in `devSentCodes`). */
export async function sendLoginCode(env: Env, email: string, code: string): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.log(`[auth] código para ${email}: ${code}`);
    devSentCodes.set(email, code);
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: env.EMAIL_FROM ?? "Rollo <rollo@juanifraga.com>",
      to: [email],
      subject: `Tu código de Rollo: ${code}`,
      text: `Tu código de Rollo es ${code}. Vence en 5 minutos.\n\nSi no lo pediste, ignorá este mensaje.`,
      html:
        `<p>Tu código de Rollo es:</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px">${code}</p>` +
        `<p>Vence en 5 minutos. Si no lo pediste, ignorá este mensaje.</p>`,
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

/** Emails a report to support. Without `RESEND_API_KEY` it only logs it (and keeps it in `devSentReports`). Throws if Resend fails. */
export async function sendReportEmail(env: Env, report: ReportEmail): Promise<void> {
  const subject = report.media
    ? `Denuncia en Rollo: ${report.media.type === "video" ? "video" : "foto"} de ${handle(report.target)}`
    : `Denuncia en Rollo: ${handle(report.target)}`;
  const adminCurl = (path: string) => `curl -X DELETE -H "Authorization: Bearer $ROLLO_ADMIN_TOKEN" ${report.adminBase}${path}`;

  const lines = [
    `Motivo: ${REASON_LABELS[report.reason] ?? report.reason}`,
    `Denunció: ${describePerson(report.reporter)}`,
    `Denunciado: ${describePerson(report.target)}`,
  ];
  if (report.trip) lines.push(`Rollo: ${report.trip.name}`);
  if (report.media) {
    lines.push(
      `${report.media.type === "video" ? "Video" : "Foto"}: ${report.media.url}`,
      `Epígrafe: ${report.media.caption ?? "(sin epígrafe)"}`,
      `Sacada: ${new Date(report.media.takenAt).toISOString()}`,
      "",
      "Borrar el archivo:",
      adminCurl(`/admin/media/${report.media.id}`),
    );
  }
  lines.push("", "Borrar la cuenta:", adminCurl(`/admin/users/${report.target.id}`));
  const text = lines.join("\n");

  if (!env.RESEND_API_KEY) {
    console.log(`[report] ${subject}\n${text}`);
    devSentReports.push(report);
    return;
  }

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
