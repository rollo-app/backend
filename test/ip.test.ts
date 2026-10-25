import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ipKey } from "../src/lib/ip";
import { LOGIN_NEW_USER_EMAILS_PER_IP_PER_DAY, purgeOldEmailCounters } from "../src/lib/email-caps";
import { api } from "./helpers";

describe("ipKey", () => {
  it("keeps IPv4 as is", () => {
    expect(ipKey("203.0.113.7")).toBe("203.0.113.7");
  });

  it("turns an IPv4-mapped IPv6 address into the IPv4", () => {
    expect(ipKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(ipKey("::FFFF:203.0.113.7")).toBe("203.0.113.7");
  });

  it("reduces a full IPv6 address to its /64", () => {
    expect(ipKey("2001:0db8:85a3:0001:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:85a3:1::/64");
  });

  it("expands :: before cutting, lowercases, and puts addresses of one /64 on one key", () => {
    expect(ipKey("2001:DB8:85A3:1::1")).toBe("2001:db8:85a3:1::/64");
    expect(ipKey("2001:db8:85a3:1:ffff:ffff:ffff:ffff")).toBe("2001:db8:85a3:1::/64");
    expect(ipKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipKey("::1")).toBe("0:0:0:0::/64");
    expect(ipKey("2001:db8:1:2:3::")).toBe("2001:db8:1:2::/64");
  });

  it("different /64s get different keys", () => {
    expect(ipKey("2001:db8:85a3:1::1")).not.toBe(ipKey("2001:db8:85a3:2::1"));
  });

  it("returns garbage as is", () => {
    for (const bad of ["unknown", "", "1:2:3", "gggg::1", "1::2::3", "1:2:3:4:5:6:7:8:9", "12345::1"]) expect(ipKey(bad)).toBe(bad);
  });
});

describe("IPv6 per-IP limits", () => {
  it("addresses inside one /64 share the new-signup budget", async () => {
    const start = (email: string, ip: string) => api("POST", "/auth/email/start", { body: { email }, headers: { "cf-connecting-ip": ip } });
    const { devSentCodes } = await import("../src/infra/dev/dev-mailer");
    for (let i = 0; i < LOGIN_NEW_USER_EMAILS_PER_IP_PER_DAY; i++) await start(`v6-${i}@rollo.test`, `2001:db8:aaaa:bbbb::${i + 1}`);
    expect(devSentCodes.has("v6-19@rollo.test")).toBe(true);
    // Past the hourly per-IP code limit, so the new-signup cap is the one answering.
    await env.DB.prepare("UPDATE auth_codes SET created_at = created_at - 7200000").run();
    expect((await start("v6-x@rollo.test", "2001:db8:aaaa:bbbb:1:2:3:4")).status).toBe(204);
    expect(devSentCodes.has("v6-x@rollo.test")).toBe(false);
  });
});

describe("email counters purge", () => {
  it("deletes rows older than 2 days and keeps the rest", async () => {
    const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);
    for (const [kind, d] of [["login", day(3)], ["login", day(2)], ["support", day(0)], ["x", day(10)]] as const) {
      await env.DB.prepare("INSERT INTO email_counters (kind, day, count) VALUES (?, ?, 1)").bind(kind, d).run();
    }
    await purgeOldEmailCounters(env.DB, Date.now());
    const { results } = await env.DB.prepare("SELECT kind, day FROM email_counters ORDER BY day").all<{ kind: string; day: string }>();
    expect(results.map((r) => r.day)).toEqual([day(2), day(0)]);
  });
});
