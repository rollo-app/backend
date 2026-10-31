/**
 * Creates an already revealed rollo for the App Review account, with photos authored by a real user,
 * so the reviewer sees content and can report it (photo and author) and block the author.
 *
 * Writes straight to D1 and R2 with wrangler (no API: the author can't log in from a script).
 * The trip is marked as notified so the cron doesn't push "Arrancó" / "Se reveló" to anyone.
 *
 *   npm run review:rollo -- --photos ~/Desktop/fotos-review --dry-run
 *   npm run review:rollo -- --photos ~/Desktop/fotos-review                        # local D1/R2
 *   npm run review:rollo -- --photos ~/Desktop/fotos-review --remote               # production
 *
 * Options: --name "Finde en la costa" --author <email> --reviewer <username> --tz <IANA>
 *          --near "lat,lng" (where photos without GPS go; default Punta del Este)
 *          --captions <file> (one caption per line, in the photos' order; empty line = no caption)
 * Photos: .jpg/.jpeg/.heic/.png, ordered by capture date (EXIF DateTimeOriginal read in --tz, and EXIF GPS).
 */
import { execFileSync } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { rgbaToThumbHash } from "thumbhash";
import { LOGIN_CODE_ALPHABET } from "../src/lib/login-code";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ORIGINAL_MAX_PX = 4000;
const THUMB_WIDTH = 800;

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const photosDir = arg("photos");
if (!photosDir) throw new Error("Falta --photos <carpeta>");
const remote = flag("remote");
const dryRun = flag("dry-run");
const tripName = arg("name", "Finde en la costa")!;
const authorEmail = arg("author", "jfraga.smc@gmail.com")!;
const reviewerUsername = arg("reviewer", "appreviewer")!;
const tz = arg("tz", "America/Montevideo")!;
const captionsFile = arg("captions");

const target = remote ? "--remote" : "--local";
const wrangler = resolve("node_modules/.bin/wrangler");
const sql = (v: string | number | null) =>
  v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v.replaceAll("'", "''")}'`;

function d1<T>(command: string): T[] {
  const out = execFileSync(wrangler, ["d1", "execute", "rollo", target, "--json", "--command", command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(out)[0].results as T[];
}

/** DateTimeOriginal ("YYYY:MM:DD HH:MM:SS", local wall time) and GPS from a JPEG's EXIF block (sharp's `metadata().exif`). */
function readExif(exif: Buffer | undefined): { dateTime: string | null; lat: number | null; lng: number | null } {
  const none = { dateTime: null, lat: null, lng: null };
  if (!exif || exif.toString("latin1", 0, 4) !== "Exif") return none;
  const tiff = exif.subarray(6);
  const le = tiff.toString("latin1", 0, 2) === "II";
  const u16 = (o: number) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o: number) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  // Tag → offset of its value (or of the value itself when it fits in 4 bytes).
  const ifd = (at: number) => {
    const tags = new Map<number, { count: number; at: number }>();
    for (let i = 0, n = u16(at); i < n; i++) {
      const e = at + 2 + i * 12;
      const [type, count] = [u16(e + 2), u32(e + 4)];
      const size = ({ 2: 1, 3: 2, 4: 4, 5: 8 } as Record<number, number>)[type] ?? 1;
      tags.set(u16(e), { count, at: size * count > 4 ? u32(e + 8) : e + 8 });
    }
    return tags;
  };
  const ascii = (t?: { count: number; at: number }) => (t ? tiff.toString("latin1", t.at, t.at + t.count).replace(/\0.*$/, "") : null);
  const dms = (t?: { at: number }) =>
    t ? [0, 1, 2].reduce((sum, i) => sum + u32(t.at + i * 8) / u32(t.at + i * 8 + 4) / 60 ** i, 0) : null;

  const root = ifd(u32(4));
  const exifIfd = root.has(0x8769) ? ifd(u32(root.get(0x8769)!.at)) : new Map();
  const gps = root.has(0x8825) ? ifd(u32(root.get(0x8825)!.at)) : new Map();
  const lat = dms(gps.get(2));
  const lng = dms(gps.get(4));
  return {
    dateTime: ascii(exifIfd.get(0x9003)),
    lat: lat === null ? null : ascii(gps.get(1)) === "S" ? -lat : lat,
    lng: lng === null ? null : ascii(gps.get(3)) === "W" ? -lng : lng,
  };
}

const localDate = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(ms); // YYYY-MM-DD

/** UTC minus local time in `tz` at `ms` (e.g. +3 h for Montevideo), so a local wall time can be turned into UTC. */
function tzOffsetMs(ms: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(ms)
      .map((p) => [p.type, p.value]),
  );
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((ms - wall) / 60_000) * 60_000;
}

type Photo = {
  file: string;
  jpeg: string;
  takenAt: number | null;
  lat: number | null;
  lng: number | null;
};

// ---------- Read the photos ----------

const files = readdirSync(photosDir)
  .filter((f) => /\.(jpe?g|heic|png)$/i.test(f))
  .sort()
  .map((f) => join(resolve(photosDir), f));
if (files.length === 0) throw new Error(`No hay fotos en ${photosDir}`);

const work = mkdtempSync(join(tmpdir(), "review-rollo-"));
const photos: Photo[] = [];
for (const [i, file] of files.entries()) {
  // HEIC isn't readable by sharp: sips (macOS) turns everything into a JPEG first, keeping the EXIF.
  const jpeg = join(work, `${i}.src.jpg`);
  execFileSync("sips", ["-s", "format", "jpeg", file, "--out", jpeg], { stdio: "ignore" });
  const { dateTime, lat, lng } = readExif((await sharp(jpeg).metadata()).exif);
  // DateTimeOriginal is the wall time where the photo was taken: read it in --tz.
  const wall = dateTime ? Date.parse(`${dateTime.replace(/^(\d+):(\d+):(\d+) /, "$1-$2-$3T")}Z`) : NaN;
  const takenAt = Number.isNaN(wall) ? null : wall + tzOffsetMs(wall);
  photos.push({ file, jpeg, takenAt, lat, lng });
}

// Photos without a date go after the dated ones, by name; with none dated, a weekend ten days ago, 10:00–20:00 local.
if (photos.every((p) => p.takenAt === null)) {
  const day1 = Date.parse(`${localDate(Date.now() - 11 * DAY)}T10:00:00Z`) + tzOffsetMs(Date.now());
  const perDay = Math.ceil(photos.length / 2);
  photos.forEach((p, i) => {
    const slot = i % perDay;
    p.takenAt = day1 + Math.floor(i / perDay) * DAY + Math.round((slot * 10 * HOUR) / Math.max(perDay - 1, 1));
  });
} else {
  const first = Math.min(...photos.filter((p) => p.takenAt !== null).map((p) => p.takenAt!));
  photos.forEach((p, i) => (p.takenAt ??= first + i * 20 * 60_000));
}
photos.sort((a, b) => a.takenAt! - b.takenAt!);

// Without GPS the map would be empty: scatter those photos within ~3 km of --near.
const [nearLat, nearLng] = arg("near", "-34.9614,-54.9447")!.split(",").map(Number); // Punta del Este
for (const p of photos) {
  if (p.lat !== null) continue;
  p.lat = nearLat + (Math.random() - 0.5) * 0.05;
  p.lng = nearLng + (Math.random() - 0.5) * 0.05;
}

const captions = captionsFile ? readFileSync(captionsFile, "utf8").split("\n") : [];

const startsAt = photos[0].takenAt! - 2 * HOUR;
const endsAt = photos.at(-1)!.takenAt! + 2 * HOUR;
if (endsAt > Date.now() - HOUR) throw new Error("La última foto es demasiado reciente: el rollo tiene que haber terminado.");

// ---------- Users ----------

const [author] = d1<{ id: string; name: string }>(`SELECT id, name FROM users WHERE email = ${sql(authorEmail)}`);
const [reviewer] = d1<{ id: string; name: string }>(`SELECT id, name FROM users WHERE username = ${sql(reviewerUsername)}`);
if (!author) throw new Error(`No existe el usuario ${authorEmail}`);
if (!reviewer) throw new Error(`No existe el usuario @${reviewerUsername}`);

const tripId = randomUUID();
const joinCode = Array.from({ length: 6 }, () => LOGIN_CODE_ALPHABET[randomInt(LOGIN_CODE_ALPHABET.length)]).join("");
const authorMemberId = randomUUID();
const reviewerMemberId = randomUUID();
const now = Date.now();

console.log(`${remote ? "PRODUCCIÓN" : "local"} · "${tripName}" (${joinCode}) · ${author.name} + ${reviewer.name}`);
console.log(`Del ${new Date(startsAt).toISOString()} al ${new Date(endsAt).toISOString()} (${tz})`);
photos.forEach((p, i) =>
  console.log(
    `  ${i + 1}. ${p.file.split("/").at(-1)} · ${new Date(p.takenAt!).toISOString()} · ${p.lat !== null ? `${p.lat.toFixed(3)},${p.lng!.toFixed(3)}` : "sin GPS"}${captions[i]?.trim() ? ` · "${captions[i].trim()}"` : ""}`,
  ),
);
if (dryRun) process.exit(0);

// ---------- Images → R2 ----------

const statements: string[] = [
  `INSERT INTO trips (id, name, join_code, timezone, starts_at, ends_at, reveal_at, revealed_at, daily_photo_limit,
     daily_video_limit, created_at, started_notified_at, revealed_notified_at, photo_limit_mode, total_photo_limit,
     moment_mode, created_by_user_id)
   VALUES (${sql(tripId)}, ${sql(tripName)}, ${sql(joinCode)}, ${sql(tz)}, ${startsAt}, ${endsAt}, ${endsAt}, NULL, 10,
     0, ${startsAt - DAY}, ${now}, ${now}, 'daily', NULL, 'off', ${sql(author.id)});`,
  `INSERT INTO members (id, trip_id, user_id, role, created_at) VALUES
     (${sql(authorMemberId)}, ${sql(tripId)}, ${sql(author.id)}, 'admin', ${startsAt - DAY});`,
  `INSERT INTO members (id, trip_id, user_id, role, created_at, added_by_user_id) VALUES
     (${sql(reviewerMemberId)}, ${sql(tripId)}, ${sql(reviewer.id)}, 'member', ${startsAt - DAY}, ${sql(author.id)});`,
];

for (const [i, p] of photos.entries()) {
  const mediaId = randomUUID();
  const base = sharp(p.jpeg).rotate(); // bakes the EXIF orientation in
  const original = await base
    .clone()
    .resize({ width: ORIGINAL_MAX_PX, height: ORIGINAL_MAX_PX, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer({ resolveWithObject: true });
  const thumb = await base.clone().resize({ width: THUMB_WIDTH }).jpeg({ quality: 80 }).toBuffer();
  const small = await base.clone().resize(100, 100, { fit: "inside" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const thumbhash = Buffer.from(rgbaToThumbHash(small.info.width, small.info.height, small.data)).toString("base64");

  const keys = { original: `trips/${tripId}/${mediaId}/original.jpg`, thumb: `trips/${tripId}/${mediaId}/thumb.jpg` };
  for (const [kind, data] of [["original", original.data], ["thumb", thumb]] as const) {
    const file = join(work, `${mediaId}.${kind}.jpg`);
    writeFileSync(file, data);
    execFileSync(wrangler, ["r2", "object", "put", `rollo-media/${keys[kind]}`, target, "--file", file, "--content-type", "image/jpeg"], {
      stdio: "ignore",
    });
  }
  console.log(`  subida ${i + 1}/${photos.length}`);

  statements.push(
    `INSERT INTO media (id, trip_id, member_id, type, taken_at, local_date, lat, lng, accuracy_m, caption, width, height,
       size_bytes, thumb_size_bytes, original_key, thumb_key, status, created_at, uploaded_at, thumbhash)
     VALUES (${sql(mediaId)}, ${sql(tripId)}, ${sql(authorMemberId)}, 'photo', ${p.takenAt}, ${sql(localDate(p.takenAt!))},
       ${sql(p.lat)}, ${sql(p.lng)}, ${p.lat !== null ? 10 : "NULL"}, ${sql(captions[i]?.trim() || null)},
       ${original.info.width}, ${original.info.height}, ${original.data.length}, ${thumb.length},
       ${sql(keys.original)}, ${sql(keys.thumb)}, 'uploaded', ${p.takenAt}, ${p.takenAt! + 60_000}, ${sql(thumbhash)});`,
  );
}

// ---------- Rows → D1 (one file: wrangler runs it as a single batch) ----------

const sqlFile = join(work, "review-rollo.sql");
writeFileSync(sqlFile, statements.join("\n"));
execFileSync(wrangler, ["d1", "execute", "rollo", target, "--file", sqlFile, "--yes"], { stdio: ["ignore", "ignore", "inherit"] });

console.log(`Listo: "${tripName}" revelado, ${photos.length} fotos de ${author.name}. Código ${joinCode}, id ${tripId}.`);
