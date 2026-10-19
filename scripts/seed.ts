import { runScenario, resetScenarios, SCENARIOS, type Row } from "./seed/scenarios";

/**
 * Viajes de prueba con fotos reales contra el server local: `npm run seed`.
 * Necesita `npm run dev:lan` corriendo con DEV_LOCAL_UPLOADS=1 en `.dev.vars`
 * (si no, las URLs de subida apuntan al R2 real).
 *
 * Es idempotente: si el viaje de un escenario ya existe en D1 local, no se recrea.
 * `npm run seed -- --reset` borra esos viajes (media, members, trips) y los recrea.
 * Los videos son placeholders: no hay ffmpeg, el original es un jpeg subido como video/mp4.
 */

async function main() {
  if (process.argv.includes("--reset")) {
    console.log("--reset: borrando los viajes de los escenarios de D1 local...");
    resetScenarios();
  }

  const rows: Row[] = [];
  for (const s of SCENARIOS) rows.push(await runScenario(s));

  const pad = (v: string | number, n: number) => String(v).padEnd(n);
  console.log("\n" + [pad("Viaje", 28), pad("Código", 8), pad("Fotos", 6), pad("Videos", 7), "Qué se prueba"].join(" "));
  for (const r of rows) console.log([pad(r.name, 28), pad(r.code, 8), pad(r.photos, 6), pad(r.videos, 7), r.tests].join(" "));

  console.log("\nTokens (solo de los viajes creados en esta corrida):");
  for (const r of rows) {
    if (r.adminToken) console.log(`  admin (Cami) @ ${r.name}: ${r.adminToken}`);
    for (const [k, v] of Object.entries(r.extra)) console.log(`  ${k}: ${v}`);
  }
  if (rows.some((r) => !r.adminToken)) console.log("  (los viajes que ya existían no muestran token: usá --reset para recrearlos)");
  console.log("\nNota: los videos son placeholders (original = bytes de un jpeg como video/mp4; thumb y thumbhash de picsum).");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
