import { ensureUser } from "./seed/lib";
import { runScenario, resetScenarios, SCENARIOS, type Row } from "./seed/scenarios";

/**
 * Test trips with real photos against the local server: `npm run seed`.
 * Needs `npm run dev:lan` running with DEV_LOCAL_UPLOADS=1 in `.dev.vars`
 * (otherwise the upload URLs point at the real R2).
 *
 * Idempotent: if a scenario's trip already exists in local D1, it is not recreated.
 * `npm run seed -- --reset` deletes those trips and the @rollo.test users (media, members, trips, sessions, users) and recreates them.
 * Users: <name>@rollo.test created straight in D1 with a session each; Juani is a member of every trip.
 * Videos are placeholders: there is no ffmpeg, the original is a jpeg uploaded as video/mp4.
 */

async function main() {
  if (process.argv.includes("--reset")) {
    console.log("--reset: deleting the scenario trips from local D1...");
    resetScenarios();
  }

  const rows: Row[] = [];
  for (const s of SCENARIOS) rows.push(await runScenario(s));

  const pad = (v: string | number, n: number) => String(v).padEnd(n);
  console.log("\n" + [pad("Trip", 28), pad("Code", 8), pad("Photos", 6), pad("Videos", 7), "What it tests"].join(" "));
  for (const r of rows) console.log([pad(r.name, 28), pad(r.code, 8), pad(r.photos, 6), pad(r.videos, 7), r.tests].join(" "));

  console.log("\nLogin: juani@rollo.test — el código aparece en la consola de wrangler (npm run dev:lan).");
  console.log(`Seed session token for Juani (curl): ${await ensureUser("Juani")}`);
  console.log("\nNote: videos are placeholders (original = jpeg bytes as video/mp4; thumb and thumbhash from picsum).");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
