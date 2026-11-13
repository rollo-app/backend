const JPEG_MAGIC = [0xff, 0xd8, 0xff];

/** The stored content type is client-controlled, so the magic bytes are the source of truth. */
export function hasJpegMagic(bytes: Uint8Array): boolean {
  return bytes.length >= JPEG_MAGIC.length && JPEG_MAGIC.every((b, i) => bytes[i] === b);
}
