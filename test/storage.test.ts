import { env } from "cloudflare:workers";
import { buildDeps } from "../src/container";
import { beforeEach, describe, expect, it } from "vitest";
import { devSentStorageAlerts } from "../src/infra/dev/dev-mailer";
import { checkStorage, storageUsage } from "../src/lib/storage";
import { HOUR, api, newTrip, photoBody, signUp, uploadMedia } from "./helpers";

const MB2 = 2 * 1024 * 1024;
const setState = (key: string, value: string) =>
  env.DB.prepare("INSERT INTO cron_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value).run();
const withLimit = (limit: number) => ({ ...env, STORAGE_LIMIT_BYTES: String(limit) });
const putBytes = (key: string, n: number) => env.MEDIA.put(key, new Uint8Array(n));

beforeEach(() => {
  devSentStorageAlerts.length = 0;
});

describe("storageUsage", () => {
  it("sums pending and uploaded media (original + thumb), skipping deleted ones", async () => {
    const { tripId, adminToken } = await newTrip({ dailyPhotoLimit: 10 });
    const a = await uploadMedia(tripId, adminToken);
    const b = photoBody();
    await api("POST", `/trips/${tripId}/media`, { body: b, token: adminToken }); // pending
    const c = await uploadMedia(tripId, adminToken);
    await env.DB.prepare("UPDATE media SET deleted_at = 1 WHERE id = ?").bind(c).run();

    const size = (id: string) => `original-${id}`.length + `thumb-${id}`.length;
    expect(await storageUsage(env.DB)).toBe(size(a) + size(b.id));
  });

  it("reserves 2 MB per user with an avatar", async () => {
    const { userId } = await signUp();
    await signUp();
    await env.DB.prepare("UPDATE users SET avatar_key = 'avatars/x/y.jpg' WHERE id = ?").bind(userId).run();
    expect(await storageUsage(env.DB)).toBe(MB2);
  });

  it("uses the measured bucket size when it is larger", async () => {
    await setState("storage_measured_bytes", "5000");
    expect(await storageUsage(env.DB)).toBe(5000);
  });
});

describe("hard stop", () => {
  it("rejects a new registration over 95% of the limit with 503, but not the retry of an existing id", async () => {
    const { tripId, adminToken } = await newTrip();
    const first = photoBody();
    expect((await api("POST", `/trips/${tripId}/media`, { body: first, token: adminToken })).status).toBe(201);
    await setState("storage_measured_bytes", "9500000000");

    const blocked = await api("POST", `/trips/${tripId}/media`, { body: photoBody(), token: adminToken });
    expect(blocked.status).toBe(503);
    expect(blocked.body.error).toBe("Rollo llegó al límite de espacio por ahora. Avisale a Juani.");

    const retry = await api("POST", `/trips/${tripId}/media`, { body: first, token: adminToken });
    expect(retry.status).toBe(200);
  });

  it("counts the new file's size and honors STORAGE_LIMIT_BYTES", async () => {
    const { tripId, adminToken } = await newTrip();
    const body = photoBody({ sizeBytes: 600, thumbSizeBytes: 100 });
    const tight = await api("POST", `/trips/${tripId}/media`, { body, token: adminToken, env: { STORAGE_LIMIT_BYTES: "700" } });
    expect(tight.status).toBe(503); // 700 > 665
    const roomy = await api("POST", `/trips/${tripId}/media`, { body, token: adminToken, env: { STORAGE_LIMIT_BYTES: "800" } });
    expect(roomy.status).toBe(201); // 700 <= 760
  });

  it("rejects the avatar upload over the limit", async () => {
    const { token } = await signUp();
    await setState("storage_measured_bytes", "9500000000");
    const res = await api("POST", "/me/avatar", { body: { sizeBytes: 100 }, token });
    expect(res.status).toBe(503);
  });

  it("never blocks reading", async () => {
    const { tripId, adminToken } = await newTrip();
    await setState("storage_measured_bytes", "99000000000");
    expect((await api("GET", `/trips/${tripId}/feed`, { token: adminToken })).status).toBe(200);
  });
});

describe("checkStorage", () => {
  const T0 = Date.now();

  it("measures the bucket at most once per hour", async () => {
    await putBytes("a", 100);
    await checkStorage(buildDeps(env), T0);
    expect(await storageUsage(env.DB)).toBe(100);

    await putBytes("b", 50);
    await checkStorage(buildDeps(env), T0 + HOUR - 1000);
    expect(await storageUsage(env.DB)).toBe(100);

    await checkStorage(buildDeps(env), T0 + HOUR);
    expect(await storageUsage(env.DB)).toBe(150);
  });

  it("alerts once per threshold and again after dropping under 70%", async () => {
    const e = withLimit(1000);
    await putBytes("a", 750);
    await checkStorage(buildDeps(e), T0);
    expect(devSentStorageAlerts.map((a) => a.threshold)).toEqual([70]);

    await checkStorage(buildDeps(e), T0 + HOUR);
    expect(devSentStorageAlerts).toHaveLength(1);

    await putBytes("b", 120); // 87%
    await checkStorage(buildDeps(e), T0 + 2 * HOUR);
    expect(devSentStorageAlerts.map((a) => a.threshold)).toEqual([70, 85]);

    await putBytes("c", 100); // 97%
    await checkStorage(buildDeps(e), T0 + 3 * HOUR);
    expect(devSentStorageAlerts.map((a) => a.threshold)).toEqual([70, 85, 95]);
    expect(devSentStorageAlerts[2]).toMatchObject({ usedBytes: 970, limitBytes: 1000 });

    await env.MEDIA.delete(["a", "b", "c"]);
    await checkStorage(buildDeps(e), T0 + 4 * HOUR); // 0%: resets
    await putBytes("a", 750);
    await checkStorage(buildDeps(e), T0 + 5 * HOUR);
    expect(devSentStorageAlerts.map((a) => a.threshold)).toEqual([70, 85, 95, 70]);
  });

  it("does not alert under 70%", async () => {
    await putBytes("a", 600);
    await checkStorage(buildDeps(withLimit(1000)), T0);
    expect(devSentStorageAlerts).toHaveLength(0);
  });

  it("lists every page of the bucket", async () => {
    for (let i = 0; i < 1001; i++) await putBytes(`k${i}`, 1);
    await checkStorage(buildDeps(env), T0);
    expect(await storageUsage(env.DB)).toBe(1001);
  });
});
