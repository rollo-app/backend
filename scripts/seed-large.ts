import { createHash, randomBytes, randomUUID } from "node:crypto";
import { nameSearchColumn } from "../src/lib/search-text";
import { DAY, HOUR, getImage, POOL_SIZE, TZ, api, d1, ensureUser, localMidnight, pool, seedUsername, slug, uploadShot } from "./seed/lib";
import { GUEST_COUNT, GUEST_EMAIL_LIKE, LARGE_ROLLOS, guestName, planPartyShots } from "./seed/large";

/**
 * Two big rollos in LOCAL D1/R2 to test the paginated feed on a phone: `npm run seed:large`
 * (starts the same throwaway no-rate-limit server as `npm run seed`; needs DEV_LOCAL_UPLOADS=1 in `.dev.vars`).
 *
 * - "Fiesta grande": revealed, Juani (creator) + 100 guests, 2000 photos.
 * - "Fiesta en curso": ongoing (not revealed), same guests, 300 photos (Mapa → Feed).
 * Guests are "Invitado 1".."Invitado 100" (invitado.N@rollo.test), created straight in D1 with a session each.
 *
 * Idempotent: a rollo that already exists is skipped. `-- --reset` deletes ONLY these two rollos and the guests
 * (never the normal seed's rollos or users; their R2 files stay behind, like in the normal seed's reset).
 * Juani comes from the normal seed's people (juani@rollo.test, created here if missing).
 */

const JUANI = "Juani";
const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
const NAMES = Object.values(LARGE_ROLLOS).map((r) => q(r.name)).join(",");
const GUESTS = `SELECT id FROM users WHERE email LIKE '${GUEST_EMAIL_LIKE}'`;

function deleteTrips(names: string) {
  const trips = `SELECT id FROM trips WHERE name IN (${names})`;
  d1(`DELETE FROM featured WHERE media_id IN (SELECT id FROM media WHERE trip_id IN (${trips}))`);
  d1(`DELETE FROM media WHERE trip_id IN (${trips})`);
  d1(`DELETE FROM members WHERE trip_id IN (${trips})`);
  d1(`DELETE FROM trips WHERE name IN (${names})`);
}

function reset() {
  console.log("--reset: deleting only the large rollos and their guests from local D1...");
  deleteTrips(NAMES);
  d1(`DELETE FROM members WHERE user_id IN (${GUESTS})`);
  d1(`DELETE FROM sessions WHERE user_id IN (${GUESTS})`);
  d1(`DELETE FROM users WHERE email LIKE '${GUEST_EMAIL_LIKE}'`);
}

/** Creates the guests (if missing) in one D1 call and gives each a fresh session. Returns the tokens, by guest number - 1. */
function guestTokens(): string[] {
  const now = Date.now();
  const stmts: string[] = [];
  const tokens: string[] = [];
  for (let i = 1; i <= GUEST_COUNT; i++) {
    const name = guestName(i);
    const email = `${slug(name)}@rollo.test`;
    const ns = nameSearchColumn(name);
    stmts.push(
      `INSERT OR IGNORE INTO users (id, email, name, name_search, username, created_at) VALUES (${q(randomUUID())}, ${q(email)}, ${q(name)}, ${ns === null ? "NULL" : q(ns)}, ${q(seedUsername(name))}, ${now})`,
    );
    const token = randomBytes(32).toString("base64url");
    tokens.push(token);
    const hash = createHash("sha256").update(token).digest("hex");
    stmts.push(
      `INSERT INTO sessions (id, user_id, token_hash, created_at, last_used_at, expires_at) SELECT ${q(randomUUID())}, id, ${q(hash)}, ${now}, ${now}, ${now + 365 * DAY} FROM users WHERE email = ${q(email)}`,
    );
  }
  d1(stmts.join(";\n"));
  return tokens;
}

type Info = { name: string; code: string; members: number; photos: number; revealed: boolean; startsAt: number; endsAt: number; revealAt: number };

function info(name: string): Info {
  const [t] = d1<any>(`SELECT id, join_code, starts_at, ends_at, reveal_at, revealed_at FROM trips WHERE name = ${q(name)}`);
  if (!t) throw new Error(`Trip "${name}" not found in D1`);
  const [m] = d1<{ n: number }>(`SELECT COUNT(*) AS n FROM members WHERE trip_id = ${q(t.id)} AND left_at IS NULL AND removed_at IS NULL`);
  const [p] = d1<{ n: number }>(`SELECT COUNT(*) AS n FROM media WHERE trip_id = ${q(t.id)} AND status = 'uploaded' AND deleted_at IS NULL`);
  const revealed = t.revealed_at !== null || t.reveal_at <= Date.now();
  return { name, code: t.join_code, members: m!.n, photos: p!.n, revealed, startsAt: t.starts_at, endsAt: t.ends_at, revealAt: t.reveal_at };
}

/** Downloads the image pool up front (picsum sometimes answers 5xx), so a flaky download doesn't kill a 2000-photo run. */
async function warmImages() {
  for (let n = 0; n < POOL_SIZE; n++) {
    for (let attempt = 1; ; attempt++) {
      try {
        await getImage(n);
        break;
      } catch (err) {
        if (attempt >= 6) throw err;
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  }
}

/** A rollo that fails halfway is deleted, so the next run recreates it instead of skipping a partial one. */
async function build(name: string, photos: number, kind: "revealed" | "ongoing", tokens: { juani: string; guests: string[] }) {
  try {
    await buildRollo(name, photos, kind, tokens);
  } catch (err) {
    console.error(`${name}: failed, deleting the partial rollo`);
    deleteTrips(q(name));
    throw err;
  }
}

async function buildRollo(name: string, photos: number, kind: "revealed" | "ongoing", tokens: { juani: string; guests: string[] }) {
  if (d1(`SELECT id FROM trips WHERE name = ${q(name)}`).length) {
    console.log(`= ${name}: already exists, not recreated`);
    return;
  }
  console.log(`+ ${name}`);
  const now = Date.now();
  // The API rejects dates in the past: create with valid future dates, then write the real ones to D1 (before uploading:
  // `takenAt` has to fall inside the dates and not in the future).
  const created = await api(
    "POST",
    "/trips",
    { name, timezone: TZ, startsAt: now + HOUR, endsAt: now + 2 * HOUR, revealAt: now + 3 * HOUR, photoLimitMode: "total", totalPhotoLimit: 100 },
    tokens.juani,
  );
  const tripId: string = created.trip.id;
  // A new rollo is capped at 15 members; these are party-sized, so lift the cap in local D1 before the guests join.
  d1(`UPDATE trips SET max_members = 1000 WHERE id = ${q(tripId)}`);
  // Guests join first: joining is rejected once the rollo is revealed.
  console.log(`  joining ${GUEST_COUNT} guests...`);
  await pool(tokens.guests.map((t) => () => api("POST", "/trips/join", { code: created.trip.joinCode }, t)), 8);

  // Party from 21:00 to 06:00 (local), three nights ago; or an ongoing one that started 6 h ago.
  const dates =
    kind === "revealed"
      ? { startsAt: localMidnight(3) + 21 * HOUR, endsAt: localMidnight(2) + 6 * HOUR, revealAt: now + 30 * DAY }
      : { startsAt: now - 6 * HOUR, endsAt: now + 12 * HOUR, revealAt: now + 2 * DAY };
  // The create endpoint caps the per-person total at 200; the seed raises it so a single rollo can hold all the photos.
  d1(`UPDATE trips SET starts_at=${dates.startsAt}, ends_at=${dates.endsAt}, reveal_at=${dates.revealAt}, total_photo_limit=${photos} WHERE id=${q(tripId)}`);

  const tokenOf = [tokens.juani, ...tokens.guests];
  const shots = planPartyShots(photos, tokenOf.length, dates.startsAt, Math.min(dates.endsAt, now - 60_000));
  console.log(`  uploading ${shots.length} photos...`);
  const t0 = Date.now();
  await pool(
    shots.map((s, i) => () => uploadShot(tripId, tokenOf[s.member]!, s, (i * 7) % POOL_SIZE)),
    8,
    (done) => {
      if (done % 100 === 0 || done === shots.length) {
        const eta = Math.round(((Date.now() - t0) / done) * (shots.length - done) / 1000);
        console.log(`    ${done}/${shots.length} (~${eta} s left)`);
      }
    },
  );

  if (kind === "revealed") {
    // As in the Bariloche scenario: the reveal date (in the future until now, so uploads are accepted) goes to the past in D1 and the creator reveals.
    d1(`UPDATE trips SET reveal_at = ${dates.endsAt + HOUR} WHERE id=${q(tripId)}`);
    await api("POST", `/trips/${tripId}/reveal`, undefined, tokens.juani);
    const feed = await api("GET", `/trips/${tripId}/feed?limit=50`, undefined, tokens.juani);
    if (!feed.revealed || !feed.items.length) throw new Error(`${name}: the feed was not left revealed`);
  }
}

async function main() {
  if (process.argv.includes("--reset")) reset();
  const juani = await ensureUser(JUANI);
  const t0 = Date.now();
  const needsGuests = Object.values(LARGE_ROLLOS).some((r) => !d1(`SELECT id FROM trips WHERE name = ${q(r.name)}`).length);
  if (needsGuests) await warmImages();
  const guests = needsGuests ? guestTokens() : [];
  const tokens = { juani, guests };
  // The ongoing one first: it is the quick one.
  await build(LARGE_ROLLOS.ongoing.name, LARGE_ROLLOS.ongoing.photos, "ongoing", tokens);
  await build(LARGE_ROLLOS.revealed.name, LARGE_ROLLOS.revealed.photos, "revealed", tokens);

  const rows = [info(LARGE_ROLLOS.revealed.name), info(LARGE_ROLLOS.ongoing.name)];
  const stage = (r: Info) => (r.revealed ? "revelado" : Date.now() < r.startsAt ? "por empezar" : Date.now() <= r.endsAt ? "en curso (sin revelar)" : "terminado, sin revelar");
  console.log("\n=== Rollos grandes ===");
  console.log(["Rollo".padEnd(17), "Código".padEnd(7), "Etapa".padEnd(24), "Miembros".padEnd(9), "Fotos"].join(" "));
  for (const r of rows) console.log([r.name.padEnd(17), r.code.padEnd(7), stage(r).padEnd(24), String(r.members).padEnd(9), r.photos].join(" "));

  console.log(`\nJuani (${"juani@rollo.test"}) es el creador y admin de los dos. Invitados: invitado.1@rollo.test .. invitado.${GUEST_COUNT}@rollo.test.`);
  console.log("Qué probar en el iPhone:");
  console.log(`- "${LARGE_ROLLOS.revealed.name}": scrolleá la galería hasta el final (carga por páginas); abrí una foto de una página tardía y deslizá para los lados; probá "Guardar todo" con las 2000 fotos.`);
  console.log(`- "${LARGE_ROLLOS.ongoing.name}": Mapa → Feed (solo existe antes del revelado): scrolleá el feed de actividad, 300 fotos de a páginas; el mapa tiene que agrupar los puntos de la fiesta.`);
  console.log(`\nSeed session token for Juani (curl): ${juani}`);
  console.log(`Total: ${Math.round((Date.now() - t0) / 1000)} s`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
