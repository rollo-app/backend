import type { Env } from "../types";
import { sendUsageAlert } from "./email";
import { releaseEmailSlot, reserveEmailSlot, SUPPORT_EMAILS_PER_DAY } from "./email-caps";

/** Cloudflare free-tier limits we watch (workers/D1 per UTC day, R2 operations per UTC month). */
export const USAGE_LIMITS = {
  workers_requests: 100_000,
  d1_rows_read: 5_000_000,
  d1_rows_written: 100_000,
  r2_class_a: 1_000_000,
  r2_class_b: 10_000_000,
} as const;
export type UsageMetric = keyof typeof USAGE_LIMITS;
export const ALERT_RATIO = 0.8;
export type Usage = { fetchedAt: number; values: Record<UsageMetric, number> };

const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const SCRIPT_NAME = "rollo-api";
const USAGE_KEY = "cf_usage";
const ALERTED_PREFIX = "cf_usage_alerted:";
const METRICS = Object.keys(USAGE_LIMITS) as UsageMetric[];

// R2 billing classes by action type. Anything else (deletes, aborts) is free and ignored.
const R2_CLASS_A = new Set([
  "ListBuckets", "PutBucket", "ListObjects", "PutObject", "CopyObject", "CompleteMultipartUpload", "CreateMultipartUpload",
  "ListMultipartUploads", "UploadPart", "UploadPartCopy", "ListParts", "PutBucketEncryption", "PutBucketCors", "PutBucketLifecycleConfiguration",
]);
const R2_CLASS_B = new Set(["HeadBucket", "HeadObject", "GetObject", "UsageSummary", "GetBucketEncryption", "GetBucketLocation", "GetBucketCors", "GetBucketLifecycleConfiguration"]);

/**
 * One request, three datasets under the account. Field names follow the public GraphQL Analytics schema
 * (workersInvocationsAdaptive, d1AnalyticsAdaptiveGroups, r2OperationsAdaptiveGroups); the mapping below is tolerant:
 * a missing dataset or group counts as 0.
 */
export const USAGE_QUERY = `query Usage($accountTag: string!, $script: string!, $databaseId: string!, $bucket: string!, $dayStart: Time!, $dayEnd: Time!, $monthStart: Time!, $monthEnd: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workers: workersInvocationsAdaptive(limit: 1, filter: { scriptName: $script, datetime_geq: $dayStart, datetime_lt: $dayEnd }) {
        sum { requests }
      }
      d1: d1AnalyticsAdaptiveGroups(limit: 1, filter: { databaseId: $databaseId, datetime_geq: $dayStart, datetime_lt: $dayEnd }) {
        sum { rowsRead rowsWritten }
      }
      r2: r2OperationsAdaptiveGroups(limit: 10000, filter: { bucketName: $bucket, datetime_geq: $monthStart, datetime_lt: $monthEnd }) {
        dimensions { actionType }
        sum { requests }
      }
    }
  }
}`;

/** UTC day as YYYY-MM-DD. */
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

type Group = { sum?: Record<string, number | undefined>; dimensions?: { actionType?: string } };
type Account = { workers?: Group[]; d1?: Group[]; r2?: Group[] };

function mapAccount(a: Account | undefined): Usage["values"] {
  const sum = (groups: Group[] | undefined, field: string) => (groups ?? []).reduce((t, g) => t + (g.sum?.[field] ?? 0), 0);
  const r2 = (classes: Set<string>) => sum((a?.r2 ?? []).filter((g) => classes.has(g.dimensions?.actionType ?? "")), "requests");
  return {
    workers_requests: sum(a?.workers, "requests"),
    d1_rows_read: sum(a?.d1, "rowsRead"),
    d1_rows_written: sum(a?.d1, "rowsWritten"),
    r2_class_a: r2(R2_CLASS_A),
    r2_class_b: r2(R2_CLASS_B),
  };
}

/** Reads today's (UTC) workers/D1 usage and this month's R2 operations. Throws on HTTP or GraphQL errors. */
export async function fetchUsage(
  env: Pick<Env, "CF_ANALYTICS_TOKEN" | "R2_ACCOUNT_ID" | "R2_BUCKET_NAME" | "D1_DATABASE_ID">,
  now: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Usage["values"]> {
  const d = new Date(now);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const monthEnd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  const iso = (ms: number) => new Date(ms).toISOString();
  const res = await fetchImpl(GRAPHQL_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      query: USAGE_QUERY,
      variables: {
        accountTag: env.R2_ACCOUNT_ID,
        script: SCRIPT_NAME,
        databaseId: env.D1_DATABASE_ID ?? "",
        bucket: env.R2_BUCKET_NAME,
        dayStart: iso(dayStart),
        dayEnd: iso(dayStart + 86_400_000),
        monthStart: iso(monthStart),
        monthEnd: iso(monthEnd),
      },
    }),
  });
  if (!res.ok) throw new Error(`Cloudflare GraphQL ${res.status}`);
  const body = (await res.json()) as { data?: { viewer?: { accounts?: Account[] } }; errors?: { message: string }[] | null };
  if (body.errors?.length) throw new Error(`Cloudflare GraphQL: ${body.errors.map((e) => e.message).join("; ")}`);
  const account = body.data?.viewer?.accounts?.[0];
  // No account means a wrong token or accountTag: a misconfiguration, not a reading of zeros.
  if (!account) throw new Error("Cloudflare GraphQL: no account in the response (check token and account id)");
  return mapAccount(account);
}

const setState = (db: D1Database, key: string, value: string) =>
  db.prepare("INSERT INTO cron_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value);

/**
 * Cron: stores the latest usage in `cron_state` and emails support once per metric per UTC day when it reaches 80% of
 * the free limit. Without CF_ANALYTICS_TOKEN it does nothing. It never throws: if the API or the DB fails it logs and
 * keeps the previous values; if an alert email fails its day key is released so the next tick retries.
 */
export async function pollUsage(env: Env, now: number, fetchImpl?: typeof fetch): Promise<void> {
  if (!env.CF_ANALYTICS_TOKEN) return;
  try {
    let values: Usage["values"];
    try {
      values = await fetchUsage(env, now, fetchImpl);
    } catch (e) {
      console.error("cf usage fetch failed", e);
      return;
    }
    await setState(env.DB, USAGE_KEY, JSON.stringify({ fetchedAt: now, values } satisfies Usage)).run();

    const day = utcDay(now);
    for (const metric of METRICS) {
      const limit = USAGE_LIMITS[metric];
      if (values[metric] < limit * ALERT_RATIO) continue;
      const key = `${ALERTED_PREFIX}${metric}:${day}`;
      // The insert decides the winner, so overlapping runs do not alert twice.
      const claimed = await env.DB.prepare("INSERT INTO cron_state (key, value) VALUES (?, '1') ON CONFLICT(key) DO NOTHING").bind(key).run();
      if (claimed.meta.changes === 0) continue;
      // The alert takes a support slot. Without one it is only logged: the key stays claimed, so it is skipped for the day.
      if (!(await reserveEmailSlot(env.DB, "support", SUPPORT_EMAILS_PER_DAY))) {
        console.warn(`[cf-usage] no support email slot left, skipping the ${metric} alert`);
        continue;
      }
      try {
        await sendUsageAlert(env, { metric, value: values[metric], limit });
      } catch (e) {
        console.error("cf usage alert failed", e);
        // Give the slot back and release the claim so the next tick retries instead of losing the day's alert.
        await releaseEmailSlot(env.DB, "support");
        await env.DB.prepare("DELETE FROM cron_state WHERE key = ?").bind(key).run();
      }
    }

    // Alert keys only matter for their own UTC day: drop the ones older than 2 days.
    const oldest = utcDay(now - 2 * 86_400_000);
    await env.DB.prepare("DELETE FROM cron_state WHERE key LIKE ? AND substr(key, -10) < ?").bind(`${ALERTED_PREFIX}%`, oldest).run();
  } catch (e) {
    console.error("cf usage poll failed", e);
  }
}

/** Last stored usage with the limits, or null if the cron never fetched it. */
export async function getUsage(db: D1Database): Promise<(Usage & { limits: typeof USAGE_LIMITS }) | null> {
  const row = await db.prepare("SELECT value FROM cron_state WHERE key = ?").bind(USAGE_KEY).first<{ value: string }>();
  if (!row) return null;
  return { ...(JSON.parse(row.value) as Usage), limits: USAGE_LIMITS };
}
