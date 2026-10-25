import type { Mailer, OutgoingEmail } from "../../ports/mailer";

/** Sends through the Resend HTTP API. Throws if Resend does not answer 2xx. */
export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(email: OutgoingEmail): Promise<void> {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: this.from,
        to: [email.to],
        subject: email.subject,
        text: email.text,
        ...(email.html !== undefined && { html: email.html }),
      }),
    });
    if (!res.ok) throw new Error(`Resend responded ${res.status}`);
  }
}
