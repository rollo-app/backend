import { seedFeatured, verifyFeatured } from "./seed/featured";
import { seedLikes, verifyLikes } from "./seed/likes";
import { api, befriendSeed, clearFriendsSeed, ensureUser, seedEmail, seedUserId, unfriendSeed } from "./seed/lib";
import { EXPECTED_COMMON, SEED_FRIENDSHIPS, commonTripsProblem, tripPhase } from "./seed/people";
import { runScenario, resetScenarios, SCENARIOS, type Row } from "./seed/scenarios";

/**
 * Test trips with real photos against the local server: `npm run seed`.
 * `npm run seed` starts its own throwaway server from a dev-only config without the rate limits (scripts/seed-with-server.ts)
 * and needs DEV_LOCAL_UPLOADS=1 in `.dev.vars`; `npm run seed:only` runs this file against a server you started (`SEED_API_URL`).
 *
 * Idempotent: if a scenario's trip already exists in local D1, it is not recreated.
 * `npm run seed -- --reset` deletes those trips and the @rollo.test users (media, members, trips, friendships, friend
 * links, sessions, users) and recreates them.
 * Users: <name>@rollo.test created straight in D1 with a session each; bios set through PATCH /me (scripts/seed/people.ts).
 * Friends and the "rollos en común" each friend of Juani must have: scripts/seed/people.ts (checked at the end of every run).
 * Avatars: generated JPEGs (scripts/seed/avatars.ts) uploaded through the real /me/avatar flow; Lu, Mateo, Nuevo and Rocío have none.
 * Featured photos (scripts/seed/featured.ts): from Bariloche, Juani 5 (2 by others), Tomi 3 with a public profile, and one of
 * Cami's photos blocked from being featured by others. Redone and checked on every run.
 * Likes (scripts/seed/likes.ts): a few on Bariloche (Juani's first photo from 5 people, Tomi's first from Juani and Cami,
 * Fede's first from Juani). Redone and checked on every run.
 * Every run: Lu gets a fresh friend link (1 h) and is un-friended from Juani, and Nuevo loses any friends, so both can be retested.
 * Videos are placeholders: there is no ffmpeg, the original is a jpeg uploaded as video/mp4.
 */

const JUANI = "Juani";
const LINK_OWNER = "Lu";

async function main() {
  if (process.argv.includes("--reset")) {
    console.log("--reset: deleting the scenario trips and the seed users from local D1...");
    resetScenarios();
  }

  const rows: Row[] = [];
  for (const s of SCENARIOS) rows.push(await runScenario(s));

  // Accounts that are in no trip.
  for (const name of ["Pilar", "Nuevo", "Rocío"]) await ensureUser(name);

  for (const [a, b] of SEED_FRIENDSHIPS) befriendSeed(a, b);
  // Undo what testing on the phone may have left, so these cases work again on every run.
  unfriendSeed(JUANI, LINK_OWNER);
  clearFriendsSeed("Nuevo");

  const link = await api<{ code: string; expiresAt: number }>("POST", "/friends/link", undefined, await ensureUser(LINK_OWNER));
  await verifyFriends();
  await verifyFeatured(await seedFeatured());
  await verifyLikes(await seedLikes());

  const pad = (v: string | number, n: number) => String(v).padEnd(n);
  const juaniRole = { member: "miembro", admin: "ADMIN", absent: "no está" } as const;
  console.log("\n=== Rollos ===");
  console.log([pad("Rollo", 27), pad("Código", 7), pad("Etapa", 23), pad("Juani", 8), pad("Fotos", 6), pad("Videos", 7), "Qué prueba"].join(" "));
  for (const r of rows) {
    console.log(
      [pad(r.name, 27), pad(r.code, 7), pad(tripPhase(r.times), 23), pad(juaniRole[r.juani], 8), pad(r.photos, 6), pad(r.videos, 7), r.tests].join(" "),
    );
  }

  console.log("\n=== Cuentas (el código de login aparece en la consola de wrangler) ===");
  const accounts: [string, string][] = [
    [JUANI, "La principal: está en todos los rollos menos \"Escapada sin Juani\"; admin y creadora de \"Finde en Tandil\"; tiene archivado \"Bariloche 2025\" (solo en su vista). Descripción corta. Perfil privado con 5 destacadas de Bariloche (2 de otros). Su primera foto de Bariloche tiene 5 me gusta. Insignia Founder."],
    ["Cami", "Creó \"Rollo con admins\" (Tomi y Fede son admins ahí, Juani miembro). Amiga con varios rollos en común; descripción corta (\"Mate, montaña y fotos movidas\"). No deja destacar su primera foto de Bariloche. Insignia First Edition."],
    ["Tomi", "Amigo con varios rollos en común; descripción de 150 caracteres justos (el tope). Perfil PÚBLICO con 3 destacadas."],
    ["Fede", "Amigo con varios rollos en común; descripción de 3 renglones."],
    ["Bruno", "Amigo: 1 rollo en común (Tandil) y otro sin Juani (Escapada) que NO tiene que aparecer; descripción de 2 renglones."],
    ["Pilar", "Amiga sin ningún rollo: perfil sin rollos en común; \"Sumar a un rollo\" ofrece los de Juani sin revelar."],
    ["Rama", "Amigo que se salió de Tandil (left_at): sin rollos en común. Juani lo puede volver a sumar."],
    ["Vicky", "Amiga que Juani (admin) sacó de Tandil (removed_at): sin rollos en común; solo el admin la vuelve a sumar."],
    ["Lu", "NO es amiga de Juani pero comparte rollos; sin foto. Insignia First Edition. Su link de amistad está abajo (se rehace en cada corrida)."],
    ["Nuevo", "Cuenta nueva sin rollos ni amigos, sin foto: estados vacíos (Rollo, Amigos, Perfil)."],
    ["Rocío", "Tiene nombre pero NO @usuario (cuenta de antes de los usernames): la app la manda a \"Completá tu perfil\"."],
  ];
  for (const [name, what] of accounts) console.log(`${pad(seedEmail(name), 22)} ${what}`);
  console.log(`${pad("<cualquier otro>", 22)} Un email que no existe crea una cuenta nueva desde cero (sin nombre).`);

  const until = new Date(link.expiresAt).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "America/Argentina/Buenos_Aires" });
  console.log(`\n=== Link de amistad de ${LINK_OWNER} (${seedEmail(LINK_OWNER)}) ===`);
  console.log(`Código: ${link.code}   Link: rollo://friends/${link.code}   Vence: ${until} (1 hora; correr el seed de nuevo lo renueva)`);
  console.log("Canjealo con juani@rollo.test (Lu pasa a ser amiga, con rollos en común) o con nuevo@rollo.test.");

  console.log(`\nSeed session token for Juani (curl): ${await ensureUser(JUANI)}`);
  console.log("Note: videos are placeholders (original = jpeg bytes as video/mp4; thumb and thumbhash from picsum).");
}

/** Checks GET /friends/{id} from Juani's side against EXPECTED_COMMON, and that Nuevo is empty. Throws on any mismatch. */
async function verifyFriends() {
  const juani = await ensureUser(JUANI);
  const problems: string[] = [];
  for (const [name, expected] of Object.entries(EXPECTED_COMMON)) {
    const profile = await api<{ commonTrips: { name: string }[] }>("GET", `/friends/${seedUserId(name)}`, undefined, juani);
    const problem = commonTripsProblem(expected, profile.commonTrips.map((t) => t.name));
    if (problem) problems.push(`${name}: ${problem}`);
  }
  const nuevo = await ensureUser("Nuevo");
  const [friends, trips] = await Promise.all([
    api<{ friends: unknown[] }>("GET", "/friends", undefined, nuevo),
    api<{ trips: unknown[] }>("GET", "/me/trips", undefined, nuevo),
  ]);
  if (friends.friends.length || trips.trips.length) problems.push(`Nuevo: ${friends.friends.length} friends, ${trips.trips.length} trips (expected 0)`);
  if (problems.length) throw new Error(`Seed check failed:\n  ${problems.join("\n  ")}`);
  console.log(`✓ commonTrips checked for ${Object.keys(EXPECTED_COMMON).join(", ")}; Nuevo is empty`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
