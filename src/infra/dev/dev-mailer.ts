import type { BlockEmail, LoginCodeData, ReportEmail, StorageAlert } from "../../lib/email";
import type { Mailer, OutgoingEmail } from "../../ports/mailer";

/**
 * Login codes "sent" without a Resend key (local dev and tests), by email.
 * Test-visible: tests read the code from here instead of an inbox.
 */
export const devSentCodes = new Map<string, string>();

/** Magic-link URLs "sent" without a Resend key (local dev and tests), by email. */
export const devSentLinks = new Map<string, string>();

/** Reports "sent" without a Resend key (local dev and tests). */
export const devSentReports: ReportEmail[] = [];

/** Block emails to support "sent" without a Resend key (local dev and tests). */
export const devSentBlocks: BlockEmail[] = [];

/** Storage alerts "sent" without a Resend key (local dev and tests). */
export const devSentStorageAlerts: StorageAlert[] = [];

/** Alerts and daily summaries "sent" to support without a Resend key (local dev and tests). */
export const devSentNotices: { subject: string; text: string }[] = [];

/** Sends nothing: logs the email to the console and records it in the `devSent*` collections, by `tag` and `data`. */
export class DevMailer implements Mailer {
  async send(email: OutgoingEmail): Promise<void> {
    switch (email.tag) {
      case "login-code": {
        const { email: address, code, url } = email.data as LoginCodeData;
        console.log(`[auth] código para ${address}: ${code}${url ? ` · link: ${url}` : ""}`);
        devSentCodes.set(address, code);
        if (url) devSentLinks.set(address, url);
        else devSentLinks.delete(address);
        return;
      }
      case "report":
        console.log(`[report] ${email.subject}\n${email.text}`);
        devSentReports.push(email.data as ReportEmail);
        return;
      case "block":
        console.log(`[block] ${email.subject}\n${email.text}`);
        devSentBlocks.push(email.data as BlockEmail);
        return;
      case "storage-alert":
        console.log(`[storage] ${email.subject}\n${email.text}`);
        devSentStorageAlerts.push(email.data as StorageAlert);
        return;
      case "support-notice":
        console.log(`[support] ${email.subject}\n${email.text}`);
        devSentNotices.push({ subject: email.subject, text: email.text });
        return;
    }
  }
}
