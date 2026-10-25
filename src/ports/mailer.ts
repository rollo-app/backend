/** What an email is about. Real providers ignore it; the dev mailer uses it to record what "was sent". */
export type EmailTag = "login-code" | "report" | "block" | "storage-alert" | "support-notice";

export type OutgoingEmail = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  tag: EmailTag;
  /** Structured payload for the dev mailer (see `src/infra/dev/dev-mailer.ts`); real providers ignore it. */
  data?: unknown;
};

export interface Mailer {
  /** Throws if the email could not be delivered. */
  send(email: OutgoingEmail): Promise<void>;
}
