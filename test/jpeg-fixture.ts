/**
 * Real, tiny JPEGs (made with sharp) plus builders for the metadata segments the app writes into originals
 * (see the app's src/features/exif/build-exif.ts): an EXIF APP1 with caption, author and GPS, an XMP APP1
 * with the caption in Unicode, and the extra segments other cameras/editors add (ICC, MPF, Photoshop, COM).
 */

const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));

/** 8×8 baseline JPEG: SOI, DQT×2, SOF0, DHT×4, SOS, scan data, EOI (no APP segments). */
export const BASELINE_JPEG = fromBase64(
  "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAIAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCQAIqQ/9k=",
);

/** 16×16 progressive JPEG: several scans with DHT segments between them. */
export const PROGRESSIVE_JPEG = fromBase64(
  "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wgARCAAQABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAVAQEBAAAAAAAAAAAAAAAAAAAFBv/aAAwDAQACEAMQAAABnxZjf//EABQQAQAAAAAAAAAAAAAAAAAAACD/2gAIAQEAAQUCH//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//EABQQAQAAAAAAAAAAAAAAAAAAACD/2gAIAQEABj8CH//EABQQAQAAAAAAAAAAAAAAAAAAACD/2gAIAQEAAT8hH//aAAwDAQACAAMAAAAQD//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Qf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Qf//EABQQAQAAAAAAAAAAAAAAAAAAACD/2gAIAQEAAT8QH//Z",
);

const ascii = (s: string) => new TextEncoder().encode(s);

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A marker segment: FF <marker> <length incl. itself> <payload>. */
export function segment(marker: number, payload: Uint8Array): Uint8Array {
  const len = payload.length + 2;
  return concatBytes(new Uint8Array([0xff, marker, len >> 8, len & 0xff]), payload);
}

type Entry = { tag: number; type: number; count: number; data: Uint8Array };

const u16 = (n: number) => new Uint8Array([n >> 8, n & 0xff]);
const u32 = (n: number) => new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
const asciiEntry = (tag: number, s: string): Entry => {
  const data = ascii(`${s}\0`);
  return { tag, type: 2, count: data.length, data };
};
const rationals = (tag: number, pairs: [number, number][]): Entry => ({
  tag,
  type: 5,
  count: pairs.length,
  data: concatBytes(...pairs.flatMap(([n, d]) => [u32(n), u32(d)])),
});

/** A big-endian TIFF IFD at `start` (offset within the TIFF), followed by the values that don't fit inline. */
function ifd(entries: Entry[], start: number): Uint8Array {
  let dataAt = start + 2 + 12 * entries.length + 4;
  const head: Uint8Array[] = [u16(entries.length)];
  const data: Uint8Array[] = [];
  for (const e of entries) {
    head.push(u16(e.tag), u16(e.type), u32(e.count));
    if (e.data.length <= 4) {
      const inline = new Uint8Array(4);
      inline.set(e.data);
      head.push(inline);
    } else {
      head.push(u32(dataAt));
      data.push(e.data);
      dataAt += e.data.length;
    }
  }
  head.push(u32(0)); // no next IFD
  return concatBytes(...head, ...data);
}

/** DMS rationals for a decimal degree, like piexif's degToDmsRational. */
function dms(deg: number): [number, number][] {
  const d = Math.floor(deg);
  const m = Math.floor((deg - d) * 60);
  const s = Math.round(((deg - d) * 60 - m) * 60 * 100);
  return [[d, 1], [m, 1], [s, 100]];
}

/** APP1 "Exif\0\0" with a valid TIFF: IFD0 (Software, ImageDescription = caption, Artist, GPS pointer) and a GPS IFD. */
export function exifApp1(opts: { caption: string; author: string; lat: number; lng: number }): Uint8Array {
  const gpsEntries: Entry[] = [
    { tag: 0x0000, type: 1, count: 4, data: new Uint8Array([2, 3, 0, 0]) }, // GPSVersionID
    asciiEntry(0x0001, opts.lat < 0 ? "S" : "N"),
    rationals(0x0002, dms(Math.abs(opts.lat))),
    asciiEntry(0x0003, opts.lng < 0 ? "W" : "E"),
    rationals(0x0004, dms(Math.abs(opts.lng))),
    rationals(0x001f, [[120, 10]]), // GPSHPositioningError
  ];
  const ifd0Entries = (gpsAt: number): Entry[] => [
    asciiEntry(0x010e, opts.caption), // ImageDescription
    asciiEntry(0x0131, "Rollo"), // Software
    asciiEntry(0x013b, opts.author), // Artist
    { tag: 0x8825, type: 4, count: 1, data: u32(gpsAt) }, // GPSInfo
  ];
  const ifd0Size = ifd(ifd0Entries(0), 8).length;
  const gpsAt = 8 + ifd0Size;
  const tiff = concatBytes(ascii("MM"), u16(42), u32(8), ifd(ifd0Entries(gpsAt), 8), ifd(gpsEntries, gpsAt));
  return segment(0xe1, concatBytes(ascii("Exif\0\0"), tiff));
}

/** APP1 XMP packet with caption and author, like the app's xmpPacket. */
export function xmpApp1(caption: string, author: string): Uint8Array {
  const packet =
    `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/">` +
    `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${caption}</rdf:li></rdf:Alt></dc:description>` +
    `<dc:creator><rdf:Seq><rdf:li>${author}</rdf:li></rdf:Seq></dc:creator>` +
    `</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
  return segment(0xe1, concatBytes(ascii("http://ns.adobe.com/xap/1.0/\0"), new TextEncoder().encode(packet)));
}

export const jfifApp0 = () =>
  segment(0xe0, concatBytes(ascii("JFIF\0"), new Uint8Array([1, 1, 0, 0, 72, 0, 72, 0, 0])));
/** A (fake but well-framed) ICC profile chunk 1 of 1. */
export const iccApp2 = () => segment(0xe2, concatBytes(ascii("ICC_PROFILE\0"), new Uint8Array([1, 1]), ascii("fake-icc-profile-bytes")));
export const mpfApp2 = () => segment(0xe2, concatBytes(ascii("MPF\0"), ascii("MM\0*\0\0\0\x08")));
export const photoshopApp13 = (caption: string) => segment(0xed, concatBytes(ascii("Photoshop 3.0\0"), ascii(`8BIM caption ${caption}`)));
export const adobeApp14 = () => segment(0xee, concatBytes(ascii("Adobe"), new Uint8Array([0, 100, 0, 0, 0, 0, 1])));
export const comment = (text: string) => segment(0xfe, new TextEncoder().encode(text));

/** Inserts segments right after SOI. */
export function withSegments(jpeg: Uint8Array, ...segments: Uint8Array[]): Uint8Array {
  return concatBytes(jpeg.subarray(0, 2), ...segments, jpeg.subarray(2));
}

/** A photo as the app uploads it: JFIF + EXIF (caption, author, GPS) + XMP, plus ICC, MPF, Photoshop and COM segments. */
export function photoWithMetadata(caption: string, author = "Fede", jpeg = BASELINE_JPEG): Uint8Array {
  return withSegments(
    jpeg,
    jfifApp0(),
    exifApp1({ caption, author, lat: -41.080612, lng: -71.495031 }),
    xmpApp1(`${caption} — Ñandú`, author),
    iccApp2(),
    mpfApp2(),
    photoshopApp13(caption),
    comment(caption),
  );
}

/** Index of `needle` in `haystack`, or -1. */
export function indexOfBytes(haystack: Uint8Array, needle: Uint8Array | string): number {
  const n = typeof needle === "string" ? new TextEncoder().encode(needle) : needle;
  outer: for (let i = 0; i + n.length <= haystack.length; i++) {
    for (let j = 0; j < n.length; j++) if (haystack[i + j] !== n[j]) continue outer;
    return i;
  }
  return -1;
}

/** Bytes from the first SOS marker (FF DA) to the end. */
export function fromFirstSos(jpeg: Uint8Array): Uint8Array {
  const at = indexOfBytes(jpeg, new Uint8Array([0xff, 0xda]));
  if (at < 0) throw new Error("no SOS");
  return jpeg.subarray(at);
}
