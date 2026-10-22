import type { Context } from "hono";
import { getNotificationSettings, type NotificationKind } from "./settings";
import type { Env } from "../types";

/**
 * Push notifications through the Expo Push Service. The single place that sends pushes:
 * filters the actor, blocks and preferences, finds the tokens and sends in batches.
 * Never throws: a push that fails must not break the action that triggered it.
 */

export const EXPO_SEND_URL = "https://exp.host/--/api/v2/push/send";
export const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";

/** Expo accepts up to 100 messages per request and 1000 receipt ids. */
const SEND_BATCH = 100;
const RECEIPTS_BATCH = 1000;
/** Receipts are ready ~15 min after sending and Expo keeps them for a day. */
export const RECEIPT_DELAY_MS = 15 * 60_000;
const RECEIPT_TTL_MS = 24 * 60 * 60_000;
// D1 caps bound parameters per statement at 100.
const CHUNK = 90;

/** How a push names whoever did the action. */
export function actorName(user: { name: string | null; username: string | null }): string {
  return user.name || (user.username ? `@${user.username}` : "Alguien");
}

/** `url` is the app's deep link (expo-router path) opened when the push is tapped. */
export type PushMessage = { title?: string; body: string; url: string };

type Ticket = { status: "ok"; id: string } | { status: "error"; message?: string; details?: { error?: string } };
type Receipt = { status: "ok" } | { status: "error"; message?: string; details?: { error?: string } };

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

/** Users (other than the actor) that the actor has blocked or that blocked the actor. */
async function blockedWith(db: D1Database, actorId: string): Promise<Set<string>> {
  const { results } = await db
    .prepare("SELECT blocked_id AS id FROM blocks WHERE blocker_id = ?1 UNION SELECT blocker_id AS id FROM blocks WHERE blocked_id = ?1")
    .bind(actorId)
    .all<{ id: string }>();
  return new Set(results.map((r) => r.id));
}

/**
 * Sends `message` to the recipients' phones. Leaves out the actor (nobody is notified of their own actions),
 * anyone with a block with the actor in either direction, and anyone who turned this kind off.
 * Tokens Expo says are not registered anymore are deleted; ok tickets are kept for the receipts check.
 */
export async function sendPush(
  env: Pick<Env, "DB">,
  recipients: string[],
  kind: NotificationKind,
  message: PushMessage,
  opts: { actorId?: string } = {},
): Promise<void> {
  try {
    const db = env.DB;
    let ids = [...new Set(recipients)].filter((id) => id !== opts.actorId);
    if (opts.actorId && ids.length) {
      const blocked = await blockedWith(db, opts.actorId);
      ids = ids.filter((id) => !blocked.has(id));
    }
    if (!ids.length) return;
    const settings = await getNotificationSettings(db, ids);
    ids = ids.filter((id) => settings.get(id)?.[kind] !== false);
    if (!ids.length) return;

    const tokens: string[] = [];
    for (const chunk of chunks(ids, CHUNK)) {
      const { results } = await db
        .prepare(`SELECT token FROM push_tokens WHERE user_id IN (${chunk.map(() => "?").join(", ")})`)
        .bind(...chunk)
        .all<{ token: string }>();
      tokens.push(...results.map((r) => r.token));
    }
    if (!tokens.length) return;

    for (const batch of chunks(tokens, SEND_BATCH)) {
      try {
        const messages = batch.map((to) => ({
          to,
          ...(message.title !== undefined && { title: message.title }),
          body: message.body,
          sound: "default",
          data: { url: message.url },
        }));
        const { data } = await postExpo<{ data: Ticket[] }>(EXPO_SEND_URL, messages);
        await handleTickets(db, batch, data ?? []);
      } catch (err) {
        console.error("push: send failed", err);
      }
    }
  } catch (err) {
    console.error("push: failed", err);
  }
}

/** Tickets come back in the same order as the messages. */
async function handleTickets(db: D1Database, tokens: string[], tickets: Ticket[]) {
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  tickets.forEach((ticket, i) => {
    const token = tokens[i];
    if (!token) return;
    if (ticket.status === "ok") {
      statements.push(db.prepare("INSERT OR IGNORE INTO push_receipts (id, token, created_at) VALUES (?, ?, ?)").bind(ticket.id, token, now));
    } else if (ticket.details?.error === "DeviceNotRegistered") {
      statements.push(db.prepare("DELETE FROM push_tokens WHERE token = ?").bind(token));
    }
  });
  if (statements.length) await db.batch(statements);
}

/**
 * Cron: asks Expo for the receipts of tickets older than ~15 min, deletes the tokens that are not
 * registered anymore and forgets the answered receipts (and the ones older than a day, which Expo dropped).
 */
export async function checkPushReceipts(env: Pick<Env, "DB">, now = Date.now()): Promise<void> {
  try {
    const db = env.DB;
    await db.prepare("DELETE FROM push_receipts WHERE created_at <= ?").bind(now - RECEIPT_TTL_MS).run();
    const { results } = await db
      .prepare("SELECT id, token FROM push_receipts WHERE created_at <= ? ORDER BY id LIMIT ?")
      .bind(now - RECEIPT_DELAY_MS, RECEIPTS_BATCH)
      .all<{ id: string; token: string }>();
    if (!results.length) return;

    const { data } = await postExpo<{ data: Record<string, Receipt> }>(EXPO_RECEIPTS_URL, { ids: results.map((r) => r.id) });
    const statements: D1PreparedStatement[] = [];
    for (const r of results) {
      const receipt = data?.[r.id];
      if (!receipt) continue; // not ready yet: next run
      if (receipt.status === "error" && receipt.details?.error === "DeviceNotRegistered") {
        statements.push(db.prepare("DELETE FROM push_tokens WHERE token = ?").bind(r.token));
      }
      statements.push(db.prepare("DELETE FROM push_receipts WHERE id = ?").bind(r.id));
    }
    if (statements.length) await db.batch(statements);
  } catch (err) {
    console.error("push: receipts failed", err);
  }
}

// ---------- After the response ----------

const pending = new Set<Promise<unknown>>();

/**
 * Runs a push after the action's writes without making the response wait (`waitUntil`).
 * Call it only once the action is saved.
 */
export function deferPush(c: Context, work: Promise<unknown>): void {
  const p: Promise<unknown> = work
    .catch((err) => console.error("push: deferred failed", err))
    .finally(() => pending.delete(p));
  pending.add(p);
  try {
    c.executionCtx.waitUntil(p);
  } catch {
    // No execution context (app.request in tests): the promise still runs on its own.
  }
}

/** Tests: waits for every deferred push started so far (and the ones those start). */
export async function flushPendingPushes(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}
