/**
 * Removes metadata from a JPEG without decoding it: walks the marker segments from SOI and drops
 * APP1 (EXIF: GPS, date, caption, author; XMP), APP2–APP15 (MPF, Photoshop/IPTC, ...) and COM.
 * Keeps APP0 (JFIF), APP2 ICC_PROFILE (color), APP14 "Adobe" (a color transform flag, no personal data),
 * the tables, SOF, every SOS and the entropy-coded data byte for byte. Anything after EOI is dropped
 * (appended images can carry their own metadata).
 *
 * Pure and dependency-free. Throws InvalidJpegError when the bytes aren't a well-formed JPEG, so callers
 * fail closed instead of serving them unstripped.
 */
export class InvalidJpegError extends Error {
  override name = "InvalidJpegError";
}

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const APP0 = 0xe0;
const APP2 = 0xe2;
const APP14 = 0xee;
const APP15 = 0xef;
const COM = 0xfe;

const ICC_PROFILE = new TextEncoder().encode("ICC_PROFILE\0");
const ADOBE = new TextEncoder().encode("Adobe");

const startsWith = (bytes: Uint8Array, prefix: Uint8Array) =>
  bytes.length >= prefix.length && prefix.every((b, i) => bytes[i] === b);

function keepSegment(marker: number, payload: Uint8Array): boolean {
  if (marker === COM) return false;
  if (marker === APP0) return true;
  if (marker === APP2) return startsWith(payload, ICC_PROFILE);
  if (marker === APP14) return startsWith(payload, ADOBE);
  if (marker > APP0 && marker <= APP15) return false; // APP1 (EXIF, XMP) and the rest
  return true;
}

/** Standalone markers carry no length: TEM and the restart markers. */
const isStandalone = (marker: number) => marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);

export function stripJpegMetadata(input: Uint8Array): Uint8Array {
  const fail = (why: string): never => {
    throw new InvalidJpegError(why);
  };
  if (input.length < 4 || input[0] !== 0xff || input[1] !== SOI) fail("missing SOI");

  const parts: Uint8Array[] = [input.subarray(0, 2)];
  let pos = 2;
  for (;;) {
    if (pos >= input.length) fail("missing EOI");
    if (input[pos] !== 0xff) fail(`expected a marker at ${pos}`);
    let at = pos + 1;
    while (at < input.length && input[at] === 0xff) at++; // fill bytes
    if (at >= input.length) fail("truncated marker");
    const marker = input[at]!;

    if (marker === EOI) {
      parts.push(new Uint8Array([0xff, EOI]));
      break;
    }
    if (marker === SOI || marker === 0x00) fail(`unexpected marker ${marker.toString(16)} at ${at}`);
    if (isStandalone(marker)) {
      parts.push(new Uint8Array([0xff, marker]));
      pos = at + 1;
      continue;
    }

    if (at + 2 >= input.length) fail("truncated segment length");
    const length = (input[at + 1]! << 8) | input[at + 2]!;
    const end = at + 1 + length;
    if (length < 2 || end > input.length) fail(`truncated segment ${marker.toString(16)} at ${at}`);
    if (keepSegment(marker, input.subarray(at + 3, end))) {
      parts.push(new Uint8Array([0xff, marker]), input.subarray(at + 1, end));
    }
    pos = end;

    if (marker === SOS) {
      // Entropy-coded data runs until a real marker: FF00 is a stuffed byte, FFD0–FFD7 are restarts.
      let i = pos;
      for (;;) {
        if (i + 1 >= input.length) fail("truncated scan");
        if (input[i] === 0xff) {
          const next = input[i + 1]!;
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
            i += 2;
            continue;
          }
          if (next !== 0xff) break;
        }
        i++;
      }
      parts.push(input.subarray(pos, i));
      pos = i;
    }
  }

  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
