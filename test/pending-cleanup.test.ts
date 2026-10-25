import { env } from "cloudflare:workers";
import { buildDeps } from "../src/container";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import { S3Presigner } from "../src/infra/r2/s3-presigner";
import { cleanupStalePending } from "../src/lib/pending-cleanup";
import { api, DAY, newTrip, photoBody, putFiles, uploadMedia } from "./helpers";

async function pending(tripId: string, token: string, ageMs: number) {
  const body = photoBody();
  expect((await api("POST", `/trips/${tripId}/media`, { token, body })).status).toBe(201);
  await putFiles(tripId, body.id);
  await env.DB.prepare("UPDATE media SET created_at = ? WHERE id = ?").bind(Date.now() - ageMs, body.id).run();
  return body.id;
}

const exists = async (id: string) => !!(await env.DB.prepare("SELECT 1 FROM media WHERE id = ?").bind(id).first());

describe("presignPut (R2)", () => {
  const presigner = new S3Presigner({ endpoint: "https://acc.r2.cloudflarestorage.com", bucket: "b", region: "auto", accessKeyId: "AK", secretAccessKey: "SK" });
  const presignPut = (key: string, origin: string, size?: number | null) => presigner.putUrl(key, { origin, size: size ?? null, expiresIn: 900 });

  it("signs content-length when given a size", async () => {
    const url = new URL(await presignPut("k/a.jpg", "https://x", 1234));
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;host");
  });

  it("does not sign content-length without a size", async () => {
    for (const size of [undefined, null]) {
      const url = new URL(await presignPut("k/a.jpg", "https://x", size));
      expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    }
  });

  it("different sizes produce different signatures", async () => {
    const a = new URL(await presignPut("k/a.jpg", "https://x", 10)).searchParams.get("X-Amz-Signature");
    const b = new URL(await presignPut("k/a.jpg", "https://x", 11)).searchParams.get("X-Amz-Signature");
    expect(a).not.toBe(b);
  });
});

describe("cleanupStalePending", () => {
  it("deletes pending media older than 7 days with its files, keeping recent and uploaded ones", async () => {
    const { tripId, adminToken } = await newTrip({ dailyPhotoLimit: 10 });
    const old = await pending(tripId, adminToken, 8 * DAY);
    const recent = await pending(tripId, adminToken, 6 * DAY);
    const uploaded = await uploadMedia(tripId, adminToken);
    await env.DB.prepare("UPDATE media SET created_at = ? WHERE id = ?").bind(Date.now() - 30 * DAY, uploaded).run();

    await cleanupStalePending(buildDeps(env));

    expect(await exists(old)).toBe(false);
    expect(await env.MEDIA.head(`trips/${tripId}/${old}/original.jpg`)).toBeNull();
    expect(await env.MEDIA.head(`trips/${tripId}/${old}/thumb.jpg`)).toBeNull();
    expect(await exists(recent)).toBe(true);
    expect(await env.MEDIA.head(`trips/${tripId}/${recent}/original.jpg`)).not.toBeNull();
    expect(await exists(uploaded)).toBe(true);
  });

  it("also cleans rows whose files were never uploaded", async () => {
    const { tripId, adminToken } = await newTrip();
    const body = photoBody();
    await api("POST", `/trips/${tripId}/media`, { token: adminToken, body });
    await env.DB.prepare("UPDATE media SET created_at = ? WHERE id = ?").bind(Date.now() - 9 * DAY, body.id).run();
    await cleanupStalePending(buildDeps(env));
    expect(await exists(body.id)).toBe(false);
  });

  it("clears several rows across runs", async () => {
    const { tripId, adminToken } = await newTrip({ dailyPhotoLimit: 10 });
    const ids = [] as string[];
    for (let i = 0; i < 3; i++) ids.push(await pending(tripId, adminToken, 8 * DAY));
    await cleanupStalePending(buildDeps(env));
    await cleanupStalePending(buildDeps(env));
    for (const id of ids) expect(await exists(id)).toBe(false);
  });

  it("the cron runs it", async () => {
    const { tripId, adminToken } = await newTrip();
    const old = await pending(tripId, adminToken, 8 * DAY);
    const ctx = createExecutionContext();
    await (app as any).scheduled(createScheduledController({ scheduledTime: new Date() }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await exists(old)).toBe(false);
  });
});
