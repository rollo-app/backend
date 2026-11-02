import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { purgeIncompleteAccounts } from "../src/lib/incomplete-accounts";
import { befriend, DAY, join, newTrip, signUp } from "./helpers";

const exists = async (id: string) => !!(await env.DB.prepare("SELECT 1 FROM users WHERE id = ?").bind(id).first());
const age = (id: string, days: number) => env.DB.prepare("UPDATE users SET created_at = ? WHERE id = ?").bind(Date.now() - days * DAY, id).run();
const sessionAge = (id: string, days: number) => env.DB.prepare("UPDATE sessions SET last_used_at = ? WHERE user_id = ?").bind(Date.now() - days * DAY, id).run();
const blank = (id: string) => env.DB.prepare("UPDATE users SET username = NULL WHERE id = ?").bind(id).run();

/** An account without @username, 30 days old with a stale session. */
async function abandoned() {
  const u = await signUp();
  await blank(u.userId);
  await age(u.userId, 30);
  await sessionAge(u.userId, 30);
  return u;
}

describe("purgeIncompleteAccounts", () => {
  it("deletes an incomplete account older than 7 days with no recent session", async () => {
    const u = await abandoned();
    await purgeIncompleteAccounts(env);
    expect(await exists(u.userId)).toBe(false);
  });

  it("deletes an account with no name either", async () => {
    const u = await signUp(undefined, null, null);
    await age(u.userId, 8);
    await sessionAge(u.userId, 8);
    await purgeIncompleteAccounts(env);
    expect(await exists(u.userId)).toBe(false);
  });

  it("keeps an incomplete account younger than 7 days", async () => {
    const u = await abandoned();
    await age(u.userId, 6);
    await purgeIncompleteAccounts(env);
    expect(await exists(u.userId)).toBe(true);
  });

  it("keeps an incomplete account whose session was used recently", async () => {
    const u = await abandoned();
    await age(u.userId, 8);
    await sessionAge(u.userId, 1);
    await purgeIncompleteAccounts(env);
    expect(await exists(u.userId)).toBe(true);
  });

  it("keeps accounts with any membership", async () => {
    const { code } = await newTrip();
    const u = await signUp();
    await join(code, u.token);
    await env.DB.prepare("UPDATE members SET left_at = ? WHERE user_id = ?").bind(Date.now(), u.userId).run();
    await blank(u.userId);
    await age(u.userId, 30);
    await sessionAge(u.userId, 30);
    await purgeIncompleteAccounts(env);
    expect(await exists(u.userId)).toBe(true);
  });

  it("keeps accounts with a friendship or a friend request", async () => {
    const friend = await signUp();
    const a = await signUp();
    await befriend(a.token, friend.token);
    await blank(a.userId);
    const b = await abandoned();
    await env.DB.prepare("INSERT INTO friend_requests (from_user_id, to_user_id, created_at) VALUES (?, ?, ?)").bind(friend.userId, b.userId, Date.now()).run();
    const c = await abandoned();
    await env.DB.prepare("INSERT INTO friend_requests (from_user_id, to_user_id, created_at) VALUES (?, ?, ?)").bind(c.userId, friend.userId, Date.now()).run();
    for (const u of [a]) { await age(u.userId, 30); await sessionAge(u.userId, 30); }
    await purgeIncompleteAccounts(env);
    expect(await exists(a.userId)).toBe(true);
    expect(await exists(b.userId)).toBe(true);
    expect(await exists(c.userId)).toBe(true);
  });

  it("never touches complete accounts", async () => {
    const u = await signUp();
    await age(u.userId, 30);
    await sessionAge(u.userId, 30);
    await purgeIncompleteAccounts(env);
    expect(await exists(u.userId)).toBe(true);
  });
});
