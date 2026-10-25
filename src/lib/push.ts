import type { Context } from "hono";
import type { Deps } from "../container";
import type { PushTicket } from "../ports/push";
import { getNotificationSettings, type NotificationKind } from "./settings";

/**
 * Push notifications through the `PushGateway` port. The single place that sends pushes:
 * filters the actor, blocks and preferences and finds the tokens; the gateway delivers (batching included).
 * Never throws: a push that fails must not break the action that triggered it.
 */

/** Receipt ids asked per cron run. */
const RECEIPTS_BATCH = 1000;
/** Receipts are ready ~15 min after sending and the provider keeps them for a day. */
export const RECEIPT_DELAY_MS = 15 * 60_000;
const RECEIPT_TTL_MS = 24 * 60 * 60_000;
// D1 caps bound parameters per statement at 100.
const CHUNK = 90;

/** How a push names whoever did the action. */
export function actorName(user: { name: string | null; username: string | null }): string {
  return user.name || (user.username ? `@${user.username}` : "Alguien");
}

/** `url` is the app's deep link (expo-router path) opened when the push is tapped. */
export type PushContent = { title?: string; body: string; url: string };

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
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
 * Tokens the provider says are not registered anymore are deleted; ok tickets are kept for the receipts check.
 */
export async function sendPush(
  deps: Pick<Deps, "db" | "push">,
  recipients: string[],
  kind: NotificationKind,
  message: PushContent,
  opts: { actorId?: string } = {},
): Promise<void> {
  try {
    const { db } = deps;
    let ids = [...new Set(recipients)].filter((id) => id !== opts.actorId);
    if (opts.actorId && ids.length) {
      const blocked = await blockedWith(db, opts.actorId);
      ids = ids.filter((id) => !blocked.has(id));
    }
    if (!ids.length) return;
    const settings = await getNotificationSettings(db, ids);
    ids = ids.filter((id) => settings.get(id)?.[kind] !== false);
    if (!ids.length) return;

    // Only tokens of a live session (the same validity requireUser checks): a phone that logged out or whose
    // session expired never gets pushes, even if the app could not unregister its token.
    const tokens: string[] = [];
    const now = Date.now();
    for (const chunk of chunks(ids, CHUNK)) {
      const { results } = await db
        .prepare(
          `SELECT t.token FROM push_tokens t JOIN sessions s ON s.id = t.session_id AND s.user_id = t.user_id
           WHERE s.expires_at > ? AND t.user_id IN (${chunk.map(() => "?").join(", ")})`,
        )
        .bind(now, ...chunk)
        .all<{ token: string }>();
      tokens.push(...results.map((r) => r.token));
    }
    if (!tokens.length) return;

    const tickets = await deps.push.send(tokens.map((token) => ({ token, ...(message.title !== undefined && { title: message.title }), body: message.body, url: message.url })));
    await handleTickets(db, tokens, tickets);
  } catch (err) {
    console.error("push: failed", err);
  }
}

/** Tickets come back in the same order as the messages. */
async function handleTickets(db: D1Database, tokens: string[], tickets: PushTicket[]) {
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  tickets.forEach((ticket, i) => {
    const token = tokens[i];
    if (!token) return;
    if (ticket.status === "ok") {
      statements.push(db.prepare("INSERT OR IGNORE INTO push_receipts (id, token, created_at) VALUES (?, ?, ?)").bind(ticket.id, token, now));
    } else if (ticket.tokenInvalid) {
      statements.push(db.prepare("DELETE FROM push_tokens WHERE token = ?").bind(token));
    }
  });
  if (statements.length) await db.batch(statements);
}

/**
 * Cron: asks the provider for the receipts of tickets older than ~15 min, deletes the tokens that are not
 * registered anymore and forgets the answered receipts (and the ones older than a day, which the provider dropped).
 */
export async function checkPushReceipts(deps: Pick<Deps, "db" | "push">, now = Date.now()): Promise<void> {
  try {
    const { db } = deps;
    await db.prepare("DELETE FROM push_receipts WHERE created_at <= ?").bind(now - RECEIPT_TTL_MS).run();
    const { results } = await db
      .prepare("SELECT id, token FROM push_receipts WHERE created_at <= ? ORDER BY id LIMIT ?")
      .bind(now - RECEIPT_DELAY_MS, RECEIPTS_BATCH)
      .all<{ id: string; token: string }>();
    if (!results.length) return;

    const data = await deps.push.getReceipts(results.map((r) => r.id));
    const statements: D1PreparedStatement[] = [];
    for (const r of results) {
      const receipt = data[r.id];
      if (!receipt) continue; // not ready yet: next run
      if (receipt.status === "error" && receipt.tokenInvalid) {
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
