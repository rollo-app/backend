import { env } from "cloudflare:workers";
import { buildDeps } from "../src/container";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import { sweepOrphanAvatars } from "../src/lib/avatar-sweep";
import { signUp } from "./helpers";

const HOUR = 60 * 60 * 1000;
const key = (userId: string) => `avatars/${userId}/${crypto.randomUUID()}.jpg`;
const exists = async (k: string) => (await env.MEDIA.head(k)) !== null;
const put = (k: string) => env.MEDIA.put(k, new Uint8Array([0xff, 0xd8, 0xff]));

// The local R2 stamps `uploaded` with the real clock, so the tests move `now` forward instead.
describe("sweepOrphanAvatars", () => {
  it("deletes unreferenced objects older than 1 hour, keeping the avatar and the pending one", async () => {
    const { userId } = await signUp();
    const [avatar, pending, orphan] = [key(userId), key(userId), key(userId)];
    for (const k of [avatar, pending, orphan]) await put(k);
    await env.DB.prepare("UPDATE users SET avatar_key = ?, pending_avatar_key = ? WHERE id = ?").bind(avatar, pending, userId).run();

    await sweepOrphanAvatars(buildDeps(env), Date.now() + 2 * HOUR);
    expect(await exists(avatar)).toBe(true);
    expect(await exists(pending)).toBe(true);
    expect(await exists(orphan)).toBe(false);
  });

  it("keeps a fresh unreferenced object until it is older than 1 hour", async () => {
    const { userId } = await signUp();
    const fresh = key(userId);
    await put(fresh);
    await sweepOrphanAvatars(buildDeps(env), Date.now() + 30 * 60 * 1000);
    expect(await exists(fresh)).toBe(true);
    await sweepOrphanAvatars(buildDeps(env), Date.now() + 2 * HOUR);
    expect(await exists(fresh)).toBe(false);
  });

  it("deletes objects of users that no longer exist", async () => {
    const ghost = key("deleted-user");
    await put(ghost);
    await sweepOrphanAvatars(buildDeps(env), Date.now() + 2 * HOUR);
    expect(await exists(ghost)).toBe(false);
  });

  it("handles more than 100 distinct users in one page (D1 bound-parameter limit)", async () => {
    const referenced: string[] = [];
    const orphans: string[] = [];
    for (let i = 0; i < 120; i++) {
      const userId = `bulk-${i}`;
      const k = key(userId);
      await put(k);
      if (i % 2 === 0) {
        await env.DB
          .prepare("INSERT INTO users (id, email, avatar_key, created_at) VALUES (?, ?, ?, ?)")
          .bind(userId, `${userId}@rollo.test`, k, new Date().toISOString())
          .run();
        referenced.push(k);
      } else orphans.push(k);
    }
    await sweepOrphanAvatars(buildDeps(env), Date.now() + 2 * HOUR);
    for (const k of referenced) expect(await exists(k)).toBe(true);
    for (const k of orphans) expect(await exists(k)).toBe(false);
    for (let i = 0; i < 120; i += 2) await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(`bulk-${i}`).run();
  });

  it("resumes where the previous run stopped and starts over after reaching the end", async () => {
    const tag = crypto.randomUUID();
    const keys = [`avatars/zz-${tag}/a.jpg`, `avatars/zz-${tag}/b.jpg`, `avatars/zz-${tag}/c.jpg`, `avatars/zz-${tag}/d.jpg`];
    for (const k of keys) await put(k);
    const total = (await env.MEDIA.list({ prefix: "avatars/" })).objects.length;
    const later = Date.now() + 2 * HOUR;
    const state = () => env.DB.prepare("SELECT value FROM cron_state WHERE key = 'avatar_sweep_after'").first<{ value: string }>();

    // Cap smaller than the listing: the first run leaves the tail untouched and saves its position.
    const opts = { maxObjects: total - 2, pageSize: total - 2 };
    await sweepOrphanAvatars(buildDeps(env), later, opts);
    expect(await exists(keys[3]!)).toBe(true);
    expect((await state())?.value).toBeDefined();

    // The second run resumes after that key, reaches the end and resets.
    await sweepOrphanAvatars(buildDeps(env), later, opts);
    expect(await exists(keys[3]!)).toBe(false);
    expect(await state()).toBeNull();
  });

  it("the cron runs it", async () => {
    const { userId } = await signUp();
    const orphan = key(userId);
    await put(orphan);
    const ctx = createExecutionContext();
    await (app as any).scheduled(createScheduledController({ scheduledTime: new Date(Date.now() + 2 * HOUR) }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await exists(orphan)).toBe(false);
  });
});
