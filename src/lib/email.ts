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
      text: `Tu código de Rollo es ${code}. Vence en 10 minutos.\n\nSi no lo pediste, ignorá este mensaje.`,
      html:
        `<p>Tu código de Rollo es:</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px">${code}</p>` +
        `<p>Vence en 10 minutos. Si no lo pediste, ignorá este mensaje.</p>`,
    }),
  });
  if (!res.ok) throw new Error(`Resend responded ${res.status}`);
}
