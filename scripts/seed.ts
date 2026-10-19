import { runScenario, resetScenarios, SCENARIOS, type Row } from "./seed/scenarios";

/**
 * Test trips with real photos against the local server: `npm run seed`.
 * Needs `npm run dev:lan` running with DEV_LOCAL_UPLOADS=1 in `.dev.vars`
 * (otherwise the upload URLs point at the real R2).
 *
 * Idempotent: if a scenario's trip already exists in local D1, it is not recreated.
 * `npm run seed -- --reset` deletes those trips (media, members, trips) and recreates them.
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

  console.log("\nTokens (only for trips created in this run):");
  for (const r of rows) {
    if (r.adminToken) console.log(`  admin (Cami) @ ${r.name}: ${r.adminToken}`);
    for (const [k, v] of Object.entries(r.extra)) console.log(`  ${k}: ${v}`);
  }
  if (rows.some((r) => !r.adminToken)) console.log("  (trips that already existed show no token: use --reset to recreate them)");
  console.log("\nNote: videos are placeholders (original = jpeg bytes as video/mp4; thumb and thumbhash from picsum).");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
