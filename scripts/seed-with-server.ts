import { spawn, execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

/**
 * `npm run seed`: starts a throwaway local server from a dev-only wrangler config (the real one without the `ratelimits`
 * bindings, routes and cron: src/lib/rate-limit.ts lets everything through when a binding is missing), runs the seed
 * against it and stops it. Production config and `npm run deploy` are untouched.
 *
 * With `SEED_API_URL` set the seed runs against that server as is (its limits apply; the seed retries on 429).
 * `SEED_PERSIST_TO=<dir>` isolates the local state, like `wrangler dev --persist-to`.
 */

const CONFIG = "wrangler.seed.generated.jsonc";
const PORT = process.env.SEED_PORT ?? "8788";
const WRANGLER = "./node_modules/.bin/wrangler";
const persist = process.env.SEED_PERSIST_TO ? ["--persist-to", process.env.SEED_PERSIST_TO] : [];

/** The real config with the production-only parts removed. */
function seedConfig(): string {
  const raw = readFileSync("wrangler.jsonc", "utf8").replace(/^\s*\/\/.*$/gm, "");
  const config = JSON.parse(raw);
  delete config.ratelimits;
  delete config.routes;
  delete config.triggers;
  return JSON.stringify(config, null, 2);
}

async function waitReady(url: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    if (await fetch(url).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`The seed server did not start at ${url}`);
}

function runSeed(api: string): Promise<number> {
  return new Promise((resolve) => {
    const args = ["scripts/seed.ts", ...process.argv.slice(2)];
    const child = spawn("./node_modules/.bin/tsx", args, { stdio: "inherit", env: { ...process.env, SEED_API_URL: api } });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function main() {
  if (process.env.SEED_API_URL) process.exit(await runSeed(process.env.SEED_API_URL));

  writeFileSync(CONFIG, seedConfig());
  execFileSync(WRANGLER, ["d1", "migrations", "apply", "rollo", "--local", ...persist], { stdio: "ignore" });
  const server = spawn(WRANGLER, ["dev", "-c", CONFIG, "--port", PORT, ...persist], { detached: true, stdio: "ignore" });
  const stop = () => {
    try {
      process.kill(-server.pid!);
    } catch {}
    rmSync(CONFIG, { force: true });
  };
  process.on("SIGINT", () => {
    stop();
    process.exit(130);
  });
  let code = 1;
  try {
    const api = `http://localhost:${PORT}`;
    await waitReady(`${api}/openapi.json`);
    console.log(`Seed server (no rate limits) at ${api}`);
    code = await runSeed(api);
  } finally {
    stop();
  }
  process.exit(code);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
