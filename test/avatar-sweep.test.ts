import { env } from "cloudflare:workers";
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

    await sweepOrphanAvatars(env, Date.now() + 2 * HOUR);
    expect(await exists(avatar)).toBe(true);
    expect(await exists(pending)).toBe(true);
    expect(await exists(orphan)).toBe(false);
  });

  it("keeps a fresh unreferenced object until it is older than 1 hour", async () => {
    const { userId } = await signUp();
    const fresh = key(userId);
    await put(fresh);
    await sweepOrphanAvatars(env, Date.now() + 30 * 60 * 1000);
    expect(await exists(fresh)).toBe(true);
    await sweepOrphanAvatars(env, Date.now() + 2 * HOUR);
    expect(await exists(fresh)).toBe(false);
  });

  it("deletes objects of users that no longer exist", async () => {
    const ghost = key("deleted-user");
    await put(ghost);
    await sweepOrphanAvatars(env, Date.now() + 2 * HOUR);
    expect(await exists(ghost)).toBe(false);
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
