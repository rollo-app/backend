import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nameSearchColumn } from "../src/lib/search-text";

/**
 * Fills `users.name_search` for existing accounts. Idempotent.
 * Usage: npm run db:backfill-name-search [-- --local | --remote]   (default: --local)
 */
const target = process.argv.includes("--remote") ? "--remote" : "--local";
const WRANGLER = "./node_modules/.bin/wrangler";
const sqlStr = (v: string) => `'${v.replace(/'/g, "''")}'`;

const out = execFileSync(WRANGLER, ["d1", "execute", "rollo", target, "--json", "--command", "SELECT id, name FROM users WHERE name IS NOT NULL"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
  maxBuffer: 50 * 1024 * 1024,
});
const rows = (JSON.parse(out)[0]?.results ?? []) as { id: string; name: string }[];

const lines = rows.map((r) => {
  const value = nameSearchColumn(r.name);
  return `UPDATE users SET name_search = ${value === null ? "NULL" : sqlStr(value)} WHERE id = ${sqlStr(r.id)};`;
});

if (lines.length > 0) {
  const dir = mkdtempSync(join(tmpdir(), "name-search-"));
  const file = join(dir, "backfill.sql");
  try {
    writeFileSync(file, lines.join("\n") + "\n");
    execFileSync(WRANGLER, ["d1", "execute", "rollo", target, "--file", file], { stdio: ["ignore", "ignore", "inherit"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(`name_search written for ${lines.length} users (${target.slice(2)})`);
