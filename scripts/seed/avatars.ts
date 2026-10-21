import sharp from "sharp";

/**
 * Seed avatars: 256x256 JPEGs rendered from generated SVG (no downloads). Each user gets a gradient
 * background plus a geometric motif, with no initial, so they never look like the app's placeholder.
 */

/** Seed users that deliberately have no photo, to keep testing the initial + color fallback. */
export const NO_AVATAR = new Set(["Lu", "Mateo"]);

const SIZE = 256;
const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);

type Motif = (a: string, b: string) => string;
const MOTIFS: Motif[] = [
  (a, b) => `<circle cx="128" cy="128" r="84" fill="${a}" opacity=".55"/><circle cx="128" cy="128" r="52" fill="${b}" opacity=".8"/><circle cx="128" cy="128" r="20" fill="#fff"/>`,
  (a, b) => `<polygon points="128,36 226,210 30,210" fill="${a}" opacity=".7"/><polygon points="128,92 186,196 70,196" fill="${b}" opacity=".85"/>`,
  (a, b) => `<rect x="40" y="40" width="112" height="112" rx="16" fill="${a}" opacity=".7"/><rect x="104" y="104" width="112" height="112" rx="16" fill="${b}" opacity=".8"/>`,
  (a, b) => [0, 1, 2, 3].map((i) => `<rect x="0" y="${40 + i * 46}" width="256" height="24" fill="${i % 2 ? a : b}" opacity=".65" transform="rotate(-18 128 128)"/>`).join(""),
  (a, b) => `<circle cx="84" cy="96" r="44" fill="${a}" opacity=".75"/><circle cx="172" cy="96" r="44" fill="${b}" opacity=".75"/><path d="M52 176 Q128 236 204 176" stroke="#fff" stroke-width="14" fill="none" stroke-linecap="round"/>`,
  (a, b) => Array.from({ length: 5 }, (_, i) => `<circle cx="128" cy="128" r="${110 - i * 22}" fill="none" stroke="${i % 2 ? a : b}" stroke-width="12" opacity=".8"/>`).join(""),
  (a, b) => `<path d="M0 190 Q64 120 128 190 T256 190 V256 H0Z" fill="${a}" opacity=".7"/><path d="M0 220 Q64 160 128 220 T256 220 V256 H0Z" fill="${b}" opacity=".8"/><circle cx="188" cy="76" r="30" fill="#fff" opacity=".9"/>`,
  (a, b) => `<polygon points="128,28 156,100 232,100 170,146 194,220 128,174 62,220 86,146 24,100 100,100" fill="${a}" opacity=".8"/><circle cx="128" cy="128" r="26" fill="${b}"/>`,
  (a, b) => Array.from({ length: 16 }, (_, i) => `<rect x="${(i % 4) * 64 + 8}" y="${Math.floor(i / 4) * 64 + 8}" width="48" height="48" rx="${i % 2 ? 24 : 6}" fill="${(i + Math.floor(i / 4)) % 2 ? a : b}" opacity=".7"/>`).join(""),
  (a, b) => `<circle cx="128" cy="128" r="90" fill="${a}" opacity=".7"/><rect x="38" y="112" width="180" height="32" fill="${b}" opacity=".85" transform="rotate(45 128 128)"/><rect x="38" y="112" width="180" height="32" fill="${b}" opacity=".85" transform="rotate(-45 128 128)"/>`,
];

/** Deterministic avatar for a seed user: valid JPEG, 256x256, a few KB. `index` picks a distinct motif per user. */
export async function renderAvatar(name: string, index: number): Promise<Buffer> {
  const h = hash(name);
  const hue = (h * 47) % 360;
  const c1 = `hsl(${hue} 78% 58%)`;
  const c2 = `hsl(${(hue + 150) % 360} 70% 38%)`;
  const accent = `hsl(${(hue + 60) % 360} 90% 72%)`;
  const motif = MOTIFS[index % MOTIFS.length]!(accent, "#ffffff");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 256 256">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>` +
    `<rect width="256" height="256" fill="url(#g)"/>${motif}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
}
