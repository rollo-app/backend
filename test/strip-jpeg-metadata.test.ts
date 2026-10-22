import { describe, expect, it } from "vitest";
import { InvalidJpegError, stripJpegMetadata } from "../src/lib/strip-jpeg-metadata";
import {
  BASELINE_JPEG,
  PROGRESSIVE_JPEG,
  adobeApp14,
  comment,
  concatBytes,
  fromFirstSos,
  iccApp2,
  indexOfBytes,
  jfifApp0,
  photoWithMetadata,
  segment,
  withSegments,
} from "./jpeg-fixture";

const CAPTION = "secreto en el cerro";

/** Marker bytes of every segment before the first SOS, in order. */
function headerMarkers(jpeg: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 2; i < jpeg.length; ) {
    const marker = jpeg[i + 1]!;
    out.push(marker);
    if (marker === 0xda) break;
    i += 2 + ((jpeg[i + 2]! << 8) | jpeg[i + 3]!);
  }
  return out;
}

describe("stripJpegMetadata", () => {
  it("drops EXIF (GPS, caption, author), XMP, MPF, Photoshop and COM, keeping JFIF and ICC", () => {
    const input = photoWithMetadata(CAPTION);
    // The fixture really carries what the app writes.
    expect(indexOfBytes(input, "Exif\0\0")).toBeGreaterThan(0);
    expect(indexOfBytes(input, "http://ns.adobe.com/xap/1.0/")).toBeGreaterThan(0);
    expect(indexOfBytes(input, CAPTION)).toBeGreaterThan(0);

    const out = stripJpegMetadata(input);

    expect(indexOfBytes(out, "Exif\0\0")).toBe(-1);
    expect(indexOfBytes(out, "http://ns.adobe.com/xap/1.0/")).toBe(-1);
    expect(indexOfBytes(out, CAPTION)).toBe(-1);
    expect(indexOfBytes(out, "Fede")).toBe(-1);
    expect(indexOfBytes(out, "Ñandú")).toBe(-1);
    expect(indexOfBytes(out, "MPF\0")).toBe(-1);
    expect(indexOfBytes(out, "Photoshop")).toBe(-1);
    expect(headerMarkers(out)).not.toContain(0xfe); // COM
    expect(headerMarkers(out)).not.toContain(0xe1); // APP1

    expect(indexOfBytes(out, "JFIF\0")).toBe(6); // right after SOI + FFE0 + length
    expect(indexOfBytes(out, "ICC_PROFILE\0")).toBeGreaterThan(0);
  });

  it("starts with SOI, ends with EOI and leaves the image data after SOS byte-identical", () => {
    const out = stripJpegMetadata(photoWithMetadata(CAPTION));
    expect([...out.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    expect([...out.subarray(-2)]).toEqual([0xff, 0xd9]);
    expect(fromFirstSos(out)).toEqual(fromFirstSos(BASELINE_JPEG));
  });

  it("leaves a JPEG without metadata exactly as it was (tables, SOF, scans)", () => {
    expect(stripJpegMetadata(BASELINE_JPEG)).toEqual(BASELINE_JPEG);
    expect(stripJpegMetadata(PROGRESSIVE_JPEG)).toEqual(PROGRESSIVE_JPEG);
  });

  it("handles progressive JPEGs: keeps every scan and table, drops metadata between scans", () => {
    const input = photoWithMetadata(CAPTION, "Fede", PROGRESSIVE_JPEG);
    expect(stripJpegMetadata(input)).toEqual(withSegments(PROGRESSIVE_JPEG, jfifApp0(), iccApp2()));

    // A COM segment between two scans goes away too; the scans stay identical.
    const sos = indexOfBytes(PROGRESSIVE_JPEG, new Uint8Array([0xff, 0xda]));
    const secondDht = indexOfBytes(PROGRESSIVE_JPEG.subarray(sos), new Uint8Array([0xff, 0xc4])) + sos;
    const withComBetweenScans = concatBytes(
      PROGRESSIVE_JPEG.subarray(0, secondDht),
      comment(CAPTION),
      PROGRESSIVE_JPEG.subarray(secondDht),
    );
    expect(stripJpegMetadata(withComBetweenScans)).toEqual(PROGRESSIVE_JPEG);
  });

  it("keeps the Adobe APP14 segment (color transform flag, no personal data)", () => {
    const input = withSegments(BASELINE_JPEG, adobeApp14());
    expect(stripJpegMetadata(input)).toEqual(input);
  });

  it("drops anything after EOI (appended images can carry their own metadata)", () => {
    const appended = withSegments(BASELINE_JPEG, segment(0xe1, new TextEncoder().encode(`Exif\0\0${CAPTION}`)));
    const out = stripJpegMetadata(concatBytes(BASELINE_JPEG, appended));
    expect(out).toEqual(BASELINE_JPEG);
  });

  it("fails closed on bytes that are not a well-formed JPEG", () => {
    const bad = [
      new TextEncoder().encode("original-1234"), // not a JPEG at all
      new Uint8Array([0xff, 0xd8]), // SOI only
      photoWithMetadata(CAPTION).subarray(0, 40), // cut inside the EXIF segment
      BASELINE_JPEG.subarray(0, BASELINE_JPEG.length - 2), // no EOI
      concatBytes(BASELINE_JPEG.subarray(0, 2), new Uint8Array([0x00, 0x11]), BASELINE_JPEG.subarray(2)), // garbage where a marker should be
      concatBytes(BASELINE_JPEG.subarray(0, 2), new Uint8Array([0xff, 0xe1, 0x00, 0x01]), BASELINE_JPEG.subarray(2)), // length < 2
    ];
    for (const bytes of bad) expect(() => stripJpegMetadata(bytes)).toThrow(InvalidJpegError);
  });
});
