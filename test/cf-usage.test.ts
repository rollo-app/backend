import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getUsage, pollUsage } from "../src/lib/cf-usage";
import { devSentUsageAlerts } from "../src/lib/email";
import { api, makeSuperadmin } from "./helpers";

const withToken = { ...env, CF_ANALYTICS_TOKEN: "t" } as typeof env;

/** The GraphQL response shape `fetchUsage` maps: one account with workers, d1 and r2 (grouped by actionType) datasets. */
function graphqlPayload(values: Record<string, number>) {
  return {
    data: {
      viewer: {
        accounts: [
          {
            workers: [{ sum: { requests: values.workers_requests } }],
            d1: [{ sum: { rowsRead: values.d1_rows_read, rowsWritten: values.d1_rows_written } }],
            r2: [
              { dimensions: { actionType: "PutObject" }, sum: { requests: values.r2_class_a } },
              { dimensions: { actionType: "GetObject" }, sum: { requests: values.r2_class_b } },
              { dimensions: { actionType: "DeleteObject" }, sum: { requests: 999_999_999 } },
            ],
          },
        ],
      },
    },
  };
}

const fakeFetch = (values: Record<string, number>) => {
  const calls: Request[] = [];
  const f = (async (input: any, init: any) => {
    calls.push(new Request(input, init));
    return new Response(JSON.stringify(graphqlPayload(values)), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, calls };
};

beforeEach(() => {
  devSentUsageAlerts.length = 0;
});

describe("cf usage", () => {
  it("does nothing without CF_ANALYTICS_TOKEN", async () => {
    await pollUsage(env, Date.now());
    expect(await getUsage(env.DB)).toBeNull();
  });

  it("stores the fetched values with fetchedAt", async () => {
    const { f, calls } = fakeFetch({ workers_requests: 41_200, d1_rows_read: 3_900_000, d1_rows_written: 12_000, r2_class_a: 10, r2_class_b: 20 });
    await pollUsage(withToken, 1_700_000_000_000, f);
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer t");
    expect(await getUsage(env.DB)).toMatchObject({
      fetchedAt: 1_700_000_000_000,
      values: { workers_requests: 41_200, d1_rows_read: 3_900_000, d1_rows_written: 12_000, r2_class_a: 10, r2_class_b: 20 },
    });
  });

  it("treats missing datasets as 0", async () => {
    const f = (async () => new Response(JSON.stringify({ data: { viewer: { accounts: [{}] } } }))) as typeof fetch;
    await pollUsage(withToken, 5, f);
    expect((await getUsage(env.DB))!.values).toEqual({ workers_requests: 0, d1_rows_read: 0, d1_rows_written: 0, r2_class_a: 0, r2_class_b: 0 });
  });

  it("alerts once per metric per UTC day when over 80%", async () => {
    const { f } = fakeFetch({ workers_requests: 81_000, d1_rows_read: 100, d1_rows_written: 0, r2_class_a: 0, r2_class_b: 0 });
    const now = Date.UTC(2026, 9, 28, 12);
    await pollUsage(withToken, now, f);
    await pollUsage(withToken, now + 300_000, f);
    expect(devSentUsageAlerts).toHaveLength(1);
    expect(devSentUsageAlerts[0]).toMatchObject({ metric: "workers_requests", value: 81_000, limit: 100_000 });
    await pollUsage(withToken, now + 86_400_000, f);
    expect(devSentUsageAlerts).toHaveLength(2);
  });

  it("purges alert keys older than 2 days", async () => {
    const { f } = fakeFetch({ workers_requests: 81_000, d1_rows_read: 0, d1_rows_written: 0, r2_class_a: 0, r2_class_b: 0 });
    const now = Date.UTC(2026, 9, 28, 12);
    await pollUsage(withToken, now, f);
    await pollUsage(withToken, now + 3 * 86_400_000, f);
    const keys = (await env.DB.prepare("SELECT key FROM cron_state WHERE key LIKE 'cf_usage_alerted:%'").all<{ key: string }>()).results.map((r) => r.key);
    expect(keys).toEqual(["cf_usage_alerted:workers_requests:2026-10-31"]);
  });

  it("keeps the last value when the API fails", async () => {
    const { f } = fakeFetch({ workers_requests: 1, d1_rows_read: 1, d1_rows_written: 1, r2_class_a: 1, r2_class_b: 1 });
    await pollUsage(withToken, 1000, f);
    const failing = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    await pollUsage(withToken, 2000, failing);
    expect((await getUsage(env.DB))!.fetchedAt).toBe(1000);
  });

  it("keeps the last value on GraphQL errors", async () => {
    const { f } = fakeFetch({ workers_requests: 1, d1_rows_read: 1, d1_rows_written: 1, r2_class_a: 1, r2_class_b: 1 });
    await pollUsage(withToken, 1000, f);
    const gqlError = (async () => new Response(JSON.stringify({ errors: [{ message: "bad" }] }))) as typeof fetch;
    await pollUsage(withToken, 2000, gqlError);
    expect((await getUsage(env.DB))!.fetchedAt).toBe(1000);
  });

  it("treats a response without an account as an error and keeps the last value", async () => {
    const { f } = fakeFetch({ workers_requests: 1, d1_rows_read: 1, d1_rows_written: 1, r2_class_a: 1, r2_class_b: 1 });
    await pollUsage(withToken, 1000, f);
    for (const body of [{ data: { viewer: { accounts: [] } } }, { data: null }]) {
      const bad = (async () => new Response(JSON.stringify(body))) as typeof fetch;
      await pollUsage(withToken, 2000, bad);
      expect((await getUsage(env.DB))!.fetchedAt).toBe(1000);
    }
  });

  it("retries the alert on the next tick when Resend fails, and never throws", async () => {
    const { f } = fakeFetch({ workers_requests: 81_000, d1_rows_read: 0, d1_rows_written: 0, r2_class_a: 0, r2_class_b: 0 });
    const withResend = { ...withToken, RESEND_API_KEY: "re_test" } as typeof env;
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    const now = Date.UTC(2026, 9, 28, 12);
    await expect(pollUsage(withResend, now, f)).resolves.toBeUndefined();
    const keys = () => env.DB.prepare("SELECT key FROM cron_state WHERE key LIKE 'cf_usage_alerted:%'").all();
    expect((await keys()).results).toHaveLength(0);
    expect(await getUsage(env.DB)).not.toBeNull();
    spy.mockResolvedValue(new Response("{}", { status: 200 }));
    await pollUsage(withResend, now + 300_000, f);
    expect(spy).toHaveBeenCalledTimes(2);
    expect((await keys()).results).toHaveLength(1);
  });

  it("GET /admin/usage returns usage and storage", async () => {
    const su = await makeSuperadmin();
    const r = await api("GET", "/admin/usage", { token: su.token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ usage: null, storage: { usedBytes: 0, limitBytes: 10_000_000_000 } });
  });
});
