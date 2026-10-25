import type { PushGateway, PushMessage, PushReceipt, PushTicket } from "../../ports/push";

const EXPO_SEND_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";

/** Expo accepts up to 100 messages per request and 1000 receipt ids. */
const SEND_BATCH = 100;
const RECEIPTS_BATCH = 1000;

type ExpoTicket = { status: "ok"; id: string } | { status: "error"; message?: string; details?: { error?: string } };
type ExpoReceipt = { status: "ok" } | { status: "error"; message?: string; details?: { error?: string } };

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function postExpo<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Expo ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

function toResult(r: ExpoTicket | ExpoReceipt): PushTicket | PushReceipt {
  if (r.status === "ok") return "id" in r ? { status: "ok", id: r.id } : { status: "ok" };
  return { status: "error", ...(r.message !== undefined && { message: r.message }), tokenInvalid: r.details?.error === "DeviceNotRegistered" };
}

/** `PushGateway` on the Expo Push Service (no access token). */
export class ExpoPushGateway implements PushGateway {
  async send(messages: PushMessage[]): Promise<PushTicket[]> {
    const tickets: PushTicket[] = [];
    for (const batch of chunks(messages, SEND_BATCH)) {
      try {
        const { data } = await postExpo<{ data: ExpoTicket[] }>(
          EXPO_SEND_URL,
          batch.map((m) => ({
            to: m.token,
            ...(m.title !== undefined && { title: m.title }),
            body: m.body,
            sound: "default",
            data: { url: m.url },
          })),
        );
        // One ticket per message even if Expo answered fewer, so the caller can match them by position.
        const answered = (data ?? []).map((t) => toResult(t) as PushTicket);
        while (answered.length < batch.length) answered.push({ status: "error", tokenInvalid: false });
        tickets.push(...answered);
      } catch (err) {
        console.error("push: send failed", err);
        tickets.push(...batch.map((): PushTicket => ({ status: "error", tokenInvalid: false })));
      }
    }
    return tickets;
  }

  async getReceipts(ids: string[]): Promise<Record<string, PushReceipt>> {
    const receipts: Record<string, PushReceipt> = {};
    for (const batch of chunks(ids, RECEIPTS_BATCH)) {
      const { data } = await postExpo<{ data: Record<string, ExpoReceipt> }>(EXPO_RECEIPTS_URL, { ids: batch });
      for (const [id, receipt] of Object.entries(data ?? {})) receipts[id] = toResult(receipt) as PushReceipt;
    }
    return receipts;
  }
}
