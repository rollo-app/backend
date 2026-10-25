/** One push to one device. `url` is the app's deep link opened when it is tapped. */
export type PushMessage = { token: string; title?: string; body: string; url: string };

/** `tokenInvalid`: the provider says the device token is not registered anymore and should be forgotten. */
export type PushTicket = { status: "ok"; id: string } | { status: "error"; message?: string; tokenInvalid: boolean };
export type PushReceipt = { status: "ok" } | { status: "error"; message?: string; tokenInvalid: boolean };

export interface PushGateway {
  /**
   * Sends the messages (batching as the provider requires). Returns one ticket per message, in the same order;
   * a batch that fails comes back as error tickets (logged), so one bad batch does not lose the others.
   */
  send(messages: PushMessage[]): Promise<PushTicket[]>;
  /** Delivery receipts by ticket id; ids that are not ready yet are left out. Throws if the provider fails. */
  getReceipts(ids: string[]): Promise<Record<string, PushReceipt>>;
}
