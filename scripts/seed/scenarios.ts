import { DAY, HOUR, Planner, type Shot, type Spot, api, d1, ensureUser, seedUserId, fixedMidnight, jitter, localMidnight, pick, pool, rand, resetUsers, uploadShot, POOL_SIZE } from "./lib";
import { TZ } from "./lib";

/** Test scenarios. Each has a fixed trip name (that's what makes the seed idempotent). */

const CAPTIONS = [
  "no puedo creer este viento",
  "el Fitz se dejó ver, ni una nube",
  "última subida, me muero",
  "mate con vista, no se negocia",
  "Tomi se comió tres alfajores antes de las 10",
  "la laguna está más celeste que en las fotos",
  "acá nos perdimos (un poco)",
  "cerveza artesanal en el pueblo, merecida",
  "amanecer rojo, valió el despertador",
  "las piernas ya no responden",
  "guanaco a dos metros, ni se inmutó",
  "picada de campeones",
  "nadie me avisó que hacía tanto frío",
  "el glaciar cruje y da miedo",
  "selfie grupal fallida número 4",
];

// ~140 characters, to test long captions in the feed.
const LONG_CAPTIONS = [
  "Veníamos recontra cansados pero cuando se abrió la nube y apareció el Fitz Roy entero, nos olvidamos de todo y nos quedamos mudos un rato largo",
  "Dato para el fotolibro: esta fue la vez que Tomi juró que sabía leer el mapa y terminamos dando una vuelta de dos horas por el mismo sendero",
  "Paramos a comer unos sándwiches de miga que sobraron de ayer y terminaron siendo el mejor almuerzo del viaje, con viento y todo, boludo",
  "Mirá la cara de Fede: acaba de enterarse de que faltan tres kilómetros más de subida y que el termo con el agua caliente quedó en la mochila de otro",
  "Esta noche hicimos un guiso en el refugio y alguien se olvidó la sal, así que cenamos algo muy raro pero igual repetimos dos veces porque había hambre",
  "Cuando le dije al guía que no tenía miedo a las alturas todavía no sabía que el puentecito colgante se movía tanto, vamos a dejarlo ahí nomás",
  "Si alguna vez dudo de volver al sur, que alguien me muestre esta foto: el lago, las montañas con nieve y nosotros con la cara toda quemada por el sol",
  "Primer mate de la mañana frente al lago, con las manos heladas y el pelo hecho un desastre, pero con una paz que no encuentro en toda la semana en Buenos Aires",
  "Llegamos al mirador justo cuando se iba el último grupo y nos quedamos solos con la laguna, un silencio increíble y alguien que no paraba de sacar fotos",
  "El colectivo se retrasó una hora, el pan se endureció y nos tocó caminar bajo la llovizna, pero esta parada con vista al glaciar compensó todo, lo juro",
];

const PLACES: Spot[] = [
  { lat: -49.3315, lng: -72.8863 }, // El Chaltén
  { lat: -49.2714, lng: -73.0431 }, // Fitz Roy
  { lat: -49.2721, lng: -73.0045 }, // Laguna de los Tres
  { lat: -49.2937, lng: -72.959 }, // Laguna Capri
  { lat: -49.327, lng: -73.096 }, // Laguna Torre
];

const cap = (p: number) => (Math.random() < p ? pick(CAPTIONS) : null);
const near = (c: { lat: number; lng: number }, d: number): Spot => ({ lat: jitter(c.lat, d), lng: jitter(c.lng, d) });
const lerp = (a: { lat: number; lng: number }, b: { lat: number; lng: number }, t: number) => ({
  lat: a.lat + (b.lat - a.lat) * t,
  lng: a.lng + (b.lng - a.lng) * t,
});
const lastDays = (n: number) => Array.from({ length: n }, (_, i) => localMidnight(n - 1 - i)); // n days, today included

type Ctx = { tripId: string; tokens: string[]; names: string[] };
type Scenario = {
  name: string;
  tests: string;
  /** Members who take photos (index = `Shot.member`). The admin is the first one. Juani is added on top (see `juani`). */
  members: string[];
  /** Juani's place: "member" (default, added last), "admin" (creates the trip; index 0) or "absent" (not in the trip). */
  juani?: "member" | "admin" | "absent";
  trip: () => { startsAt: number; endsAt: number; revealAt: number; dailyPhotoLimit?: number; dailyVideoLimit?: number };
  /** Daily moment mode sent when creating the trip (default band 9:00-23:00). */
  momentMode?: "off" | "photo" | "photo_selfie";
  shots?: () => Shot[];
  /** Extra steps after uploading (`ids` is aligned with `shots`). */
  after?: (ctx: Ctx, shots: Shot[], ids: string[]) => Promise<void>;
};

const JUANI = "Juani";
const SOUTH = ["Cami", "Tomi", "Fede"];

export const SCENARIOS: Scenario[] = [
  {
    name: "Sur (prueba)",
    tests: "Base case: 3 people, 5 days, ~5-8 photos per day",
    members: SOUTH,
    trip: () => ({ startsAt: localMidnight(4), endsAt: Date.now() + 8 * DAY, revealAt: Date.now() + 8 * DAY }),
    shots() {
      const p = new Planner(lastDays(5));
      for (let d = 0; d < 5; d++)
        for (let m = 0; m < 3; m++)
          for (let i = Math.floor(rand(5, 9)); i > 0; i--) {
            const c = pick(PLACES)!;
            p.add(m, d, "photo", near(c, 0.005), cap(0.5));
          }
      return p.shots;
    },
  },
  {
    name: "Mismo lugar",
    tests: "Clustered photos: 15 at the exact same point and 10 within <20 m (Laguna de los Tres viewpoint)",
    members: ["Cami", "Tomi", "Fede", "Lu"],
    trip: () => ({ startsAt: localMidnight(2), endsAt: Date.now() + 5 * DAY, revealAt: Date.now() + 5 * DAY }),
    shots() {
      const VIEWPOINT = { lat: -49.2717, lng: -73.0045 };
      const p = new Planner(lastDays(3));
      for (let i = 0; i < 25; i++) {
        // ±0.0001° ≈ 11 m of latitude and 7 m of longitude: comfortably within 20 m
        const spot = i < 15 ? { ...VIEWPOINT } : near(VIEWPOINT, 0.0001);
        p.add(i % 4, i % 3, "photo", spot, cap(0.5));
      }
      return p.shots;
    },
  },
  {
    name: "Grupo grande",
    tests: "10 members, 6 days, videos, long captions (~140) and ~20% of photos without GPS",
    members: ["Cami", "Tomi", "Fede", "María Florencia", "Juan Cruz", "Sofi", "Nacho", "Agus", "Valentina", "Mateo"],
    trip: () => ({ startsAt: localMidnight(5), endsAt: Date.now() + 6 * DAY, revealAt: Date.now() + 6 * DAY, dailyVideoLimit: 3 }),
    shots() {
      const p = new Planner(lastDays(6));
      const spot = (): Spot => (Math.random() < 0.2 ? null : near(pick(PLACES)!, 0.005));
      const caption = () => {
        const r = Math.random();
        return r < 0.3 ? pick(LONG_CAPTIONS) : r < 0.55 ? pick(CAPTIONS) : null;
      };
      for (let d = 0; d < 6; d++)
        for (let m = 0; m < 10; m++) {
          for (let i = Math.floor(rand(2, 5)); i > 0; i--) p.add(m, d, "photo", spot(), caption());
          if (Math.random() < 0.3) p.add(m, d, "video", spot(), caption());
        }
      return p.shots;
    },
  },
  {
    name: "Cruce a Chile",
    tests: "Day-by-day route: El Calafate → Ruta 40 → border → Torres del Paine → Puerto Natales",
    members: ["Cami", "Tomi", "Fede", "Lu"],
    trip: () => ({ startsAt: localMidnight(4), endsAt: Date.now() + 3 * DAY, revealAt: Date.now() + 3 * DAY }),
    shots() {
      const CALAFATE = { lat: -50.3379, lng: -72.2648 };
      const BORDER = { lat: -51.5833, lng: -72.3333 }; // Cerro Castillo / border crossing, Ruta 40 towards Chile
      const TORRES = { lat: -50.9423, lng: -73.4068 };
      const NATALES = { lat: -51.7236, lng: -72.4875 };
      const byDay = (d: number): Spot => {
        if (d === 0) return near(CALAFATE, 0.01);
        if (d === 1) return near(lerp(CALAFATE, BORDER, rand(0, 0.5)), 0.003); // Ruta 40, first half
        if (d === 2) return near(lerp(CALAFATE, BORDER, rand(0.5, 1)), 0.003); // Ruta 40 up to the border
        if (d === 3) return near(TORRES, 0.03);
        return near(NATALES, 0.01);
      };
      const p = new Planner(lastDays(5));
      for (let d = 0; d < 5; d++)
        for (let m = 0; m < 4; m++)
          for (let i = Math.floor(rand(3, 5)); i > 0; i--) p.add(m, d, "photo", (idx) => byDay(idx), cap(0.5));
      return p.shots;
    },
  },
  {
    name: "Bariloche 2025 (revelado)",
    tests: "Already revealed trip (Jan 2025): feed with files, download. Juani is a member and has it ARCHIVED (her own view only); featured photos come from here",
    members: ["Cami", "Tomi", "Fede", "Lu", "Nacho"],
    // Backdated to Jan 2025 right after creating (the API rejects dates in the past). The reveal stays in
    // the future so media can be registered; `after` moves it into the past and reveals it.
    trip: () => ({
      startsAt: fixedMidnight(2025, 1, 10),
      endsAt: fixedMidnight(2025, 1, 17) - 60_000,
      revealAt: Date.now() + 30 * DAY,
    }),
    shots() {
      const SPOTS: Spot[] = [
        { lat: -41.0806, lng: -71.495 }, // Cerro Campanario
        { lat: -41.0545, lng: -71.53 }, // Llao Llao
        { lat: -41.17, lng: -71.44 }, // Cerro Catedral
        { lat: -41.1335, lng: -71.3103 }, // downtown
      ];
      const days = Array.from({ length: 7 }, (_, i) => fixedMidnight(2025, 1, 10 + i));
      const p = new Planner(days);
      for (let i = 0; i < 60; i++) {
        const day = Math.floor((i / 60) * 7);
        p.add(i % 5, day, "photo", near(SPOTS[(day + i) % 4]!, 0.004), cap(0.5));
      }
      // Juani (index 5, added after the members) takes a few too, so she can feature her own.
      for (let d = 0; d < 4; d++) p.add(5, d, "photo", near(SPOTS[d]!, 0.004), cap(0.5));
      return p.shots;
    },
    async after(ctx) {
      const admin = ctx.tokens[0]!;
      // As if the trip had happened in 2025: the reveal date goes straight to D1 (the API rejects the past) and the admin reveals it.
      d1(`UPDATE trips SET reveal_at = ${fixedMidnight(2025, 1, 17) + 12 * HOUR} WHERE id = '${ctx.tripId}'`);
      await api("POST", `/trips/${ctx.tripId}/reveal`, undefined, admin);
      const feed = await api("GET", `/trips/${ctx.tripId}/feed`, undefined, admin);
      if (!feed.revealed || !feed.items.length || !feed.items.every((i: any) => i.files)) {
        throw new Error("Bariloche: the feed was not left revealed with files");
      }
      // Juani archives it for herself only (PATCH /trips/{id}/members/me): /me/trips must flag it.
      const juani = ctx.tokens[ctx.names.indexOf("Juani")]!;
      await api("PATCH", `/trips/${ctx.tripId}/members/me`, { archived: true }, juani);
      const mine = await api("GET", "/me/trips", undefined, juani);
      if (!mine.trips.find((t: any) => t.id === ctx.tripId)?.archived) throw new Error("Bariloche: Juani's archive did not show in /me/trips");
    },
  },
  {
    name: "Mendoza (por empezar)",
    tests: "Future trip without photos (starts in 10 days, lasts 7)",
    members: SOUTH,
    trip: () => ({ startsAt: localMidnight(-10), endsAt: localMidnight(-17), revealAt: localMidnight(-17) }),
  },
  {
    name: "Borradas por el admin",
    tests: "12 photos, the admin deletes 3 from others: feed and totalUploaded give 9",
    members: SOUTH,
    trip: () => ({ startsAt: localMidnight(1), endsAt: Date.now() + 5 * DAY, revealAt: Date.now() + 5 * DAY }),
    shots() {
      const p = new Planner(lastDays(2));
      for (let i = 0; i < 12; i++) p.add(i % 3, i % 2, "photo", near(pick(PLACES)!, 0.005), cap(0.5));
      return p.shots;
    },
    async after(ctx, shots, ids) {
      const admin = ctx.tokens[0]!;
      const victims = ids.filter((_, i) => shots[i]!.member !== 0).slice(0, 3);
      for (const id of victims) await api("DELETE", `/media/${id}`, undefined, admin);
      const feed = await api("GET", `/trips/${ctx.tripId}/feed`, undefined, admin);
      const detail = await api("GET", `/trips/${ctx.tripId}`, undefined, admin);
      if (feed.items.length !== 9 || detail.totalUploaded !== 9) {
        throw new Error(`Deleted: feed=${feed.items.length}, totalUploaded=${detail.totalUploaded} (expected 9)`);
      }
    },
  },
  {
    name: "Finde en Tandil",
    tests: "Juani is the ADMIN; starts tomorrow. Rama left (left_at), Juani removed Vicky (removed_at): neither counts as a common rollo",
    juani: "admin",
    members: ["Cami", "Sofi", "Bruno", "Rama", "Vicky"],
    trip: () => ({ startsAt: localMidnight(-1) + 10 * HOUR, endsAt: localMidnight(-3) + 18 * HOUR, revealAt: localMidnight(-4) + 20 * HOUR }),
    async after(ctx) {
      const tokenOf = (name: string) => ctx.tokens[ctx.names.indexOf(name)]!;
      await api("DELETE", `/trips/${ctx.tripId}/members/me`, undefined, tokenOf("Rama"));
      const [vicky] = d1<{ id: string }>(`SELECT id FROM members WHERE trip_id = '${ctx.tripId}' AND user_id = '${seedUserId("Vicky")}'`);
      await api("DELETE", `/trips/${ctx.tripId}/members/${vicky!.id}`, undefined, tokenOf("Juani"));
    },
  },
  {
    name: "Rollo con admins",
    tests: "Cami CREATED it; Tomi and Fede are admins (role admin, isCreator false); Juani is a plain member. Try the creator-only actions as each",
    members: ["Cami", "Tomi", "Fede"],
    trip: () => ({ startsAt: localMidnight(1), endsAt: Date.now() + 4 * DAY, revealAt: Date.now() + 4 * DAY }),
    async after(ctx) {
      const creator = ctx.tokens[ctx.names.indexOf("Cami")]!;
      for (const name of ["Tomi", "Fede"]) {
        const [m] = d1<{ id: string }>(`SELECT id FROM members WHERE trip_id = '${ctx.tripId}' AND user_id = '${seedUserId(name)}'`);
        await api("POST", `/trips/${ctx.tripId}/members/${m!.id}/admin`, undefined, creator);
      }
      const detail = await api("GET", `/trips/${ctx.tripId}`, undefined, creator);
      const admins = detail.members.filter((m: any) => m.role === "admin").length;
      if (admins !== 3) throw new Error(`Rollo con admins: ${admins} admins (expected 3: creator + 2)`);
    },
  },
  {
    name: "Momento del día",
    tests: "In progress, momentMode photo_selfie, default band 9:00-23:00: GET /trips/{id}/moments draws today's and the next days' moments for Juani (photo and selfie are taken from the app)",
    members: ["Lu", "Nacho"],
    momentMode: "photo_selfie",
    trip: () => ({ startsAt: localMidnight(1), endsAt: Date.now() + 6 * DAY, revealAt: Date.now() + 6 * DAY }),
  },
  {
    name: "Escapada sin Juani",
    tests: "Juani is NOT a member: must not show up as common with Cami or Bruno (privacy)",
    juani: "absent",
    members: ["Cami", "Bruno"],
    trip: () => ({ startsAt: localMidnight(1), endsAt: Date.now() + 2 * DAY, revealAt: Date.now() + 2 * DAY }),
  },
];

// ---------- Execution ----------

export type Row = {
  name: string;
  code: string;
  photos: number;
  videos: number;
  tests: string;
  juani: "member" | "admin" | "absent";
  times: { startsAt: number; endsAt: number; revealAt: number; revealedAt: number | null };
};

const sqlNames = () => SCENARIOS.map((s) => `'${s.name.replace(/'/g, "''")}'`).join(",");

/**
 * Deletes the scenario trips (by name, so orphan trips from older schemas go too) and the seed users from
 * local D1: featured → media → members → trips, then sessions → users. R2 objects are left behind.
 */
export function resetScenarios() {
  const ids = `SELECT id FROM trips WHERE name IN (${sqlNames()})`;
  d1(`DELETE FROM featured WHERE media_id IN (SELECT id FROM media WHERE trip_id IN (${ids}))`);
  d1(`DELETE FROM media WHERE trip_id IN (${ids})`);
  d1(`DELETE FROM members WHERE trip_id IN (${ids})`);
  d1(`DELETE FROM trips WHERE name IN (${sqlNames()})`);
  resetUsers();
}

function stats(name: string) {
  const [t] = d1<{ id: string; join_code: string; starts_at: number; ends_at: number; reveal_at: number; revealed_at: number | null }>(
    `SELECT id, join_code, starts_at, ends_at, reveal_at, revealed_at FROM trips WHERE name = '${name.replace(/'/g, "''")}'`,
  );
  if (!t) throw new Error(`Trip "${name}" not found in D1`);
  const rows = d1<{ type: string; n: number }>(
    `SELECT type, COUNT(*) AS n FROM media WHERE trip_id = '${t.id}' AND status = 'uploaded' AND deleted_at IS NULL GROUP BY type`,
  );
  const n = (type: string) => rows.find((r) => r.type === type)?.n ?? 0;
  return {
    code: t.join_code,
    photos: n("photo"),
    videos: n("video"),
    times: { startsAt: t.starts_at, endsAt: t.ends_at, revealAt: t.reveal_at, revealedAt: t.revealed_at },
  };
}

export async function runScenario(s: Scenario): Promise<Row> {
  const exists = d1(`SELECT id FROM trips WHERE name = '${s.name.replace(/'/g, "''")}'`).length > 0;
  if (exists) {
    console.log(`= ${s.name}: already exists, not recreated`);
    return { name: s.name, ...stats(s.name), tests: s.tests, juani: s.juani ?? "member" };
  }

  console.log(`+ ${s.name}`);
  // The API rejects dates in the past: create with valid future dates, then write the scenario's dates to D1
  // (before uploading, since `takenAt` can be at most 24 h before `starts_at`).
  const dates = s.trip();
  const now = Date.now();
  const body = {
    name: s.name,
    timezone: TZ,
    startsAt: now + HOUR,
    endsAt: now + 2 * HOUR,
    revealAt: now + 3 * HOUR,
    dailyPhotoLimit: dates.dailyPhotoLimit,
    dailyVideoLimit: dates.dailyVideoLimit,
    ...(s.momentMode ? { momentMode: s.momentMode } : {}),
  };
  const juani = s.juani ?? "member";
  const names = juani === "admin" ? [JUANI, ...s.members] : juani === "absent" ? s.members : [...s.members, JUANI];
  const tokens = await Promise.all(names.map(ensureUser));
  const created = await api("POST", "/trips", body, tokens[0]);
  const tripId: string = created.trip.id;
  d1(`UPDATE trips SET starts_at=${dates.startsAt}, ends_at=${dates.endsAt}, reveal_at=${dates.revealAt} WHERE id='${tripId}'`);
  for (let i = 1; i < names.length; i++) await api("POST", "/trips/join", { code: created.trip.joinCode }, tokens[i]);

  const shots = s.shots?.() ?? [];
  let ids: string[] = [];
  if (shots.length) {
    console.log(`  uploading ${shots.length} shots (${shots.filter((x) => x.type === "video").length} videos)...`);
    ids = await pool(
      shots.map((shot, i) => () => uploadShot(tripId, tokens[shot.member]!, shot, Math.floor(Math.random() * POOL_SIZE) + i)),
      6,
      (done) => done % 25 === 0 && console.log(`    ${done}/${shots.length}`),
    );
  }
  await s.after?.({ tripId, tokens, names }, shots, ids);
  return { name: s.name, ...stats(s.name), tests: s.tests, juani: s.juani ?? "member" };
}
