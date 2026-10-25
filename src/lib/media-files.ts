import { HTTPException } from "hono/http-exception";
import type { ObjectStorage } from "../ports/storage";
import type { MediaType } from "../types";
import { InvalidJpegError, stripJpegMetadata } from "./strip-jpeg-metadata";

export function mediaKeys(tripId: string, mediaId: string, type: MediaType) {
  const base = `trips/${tripId}/${mediaId}`;
  return {
    original: `${base}/original.${type === "video" ? "mp4" : "jpg"}`,
    thumb: `${base}/thumb.jpg`,
  };
}

/**
 * Streams a stored media file with long private caching (keys never change content).
 * Throws 404 if the object is missing.
 */
export async function serveMediaFile(storage: ObjectStorage, key: string): Promise<Response> {
  const object = await storage.get(key);
  if (!object) throw new HTTPException(404, { message: "Archivo no encontrado" });

  const headers = new Headers();
  object.applyHttpMetadata(headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", key.endsWith(".mp4") ? "video/mp4" : "image/jpeg");
  }
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, max-age=31536000, immutable");
  return new Response(object.body, { headers });
}

/**
 * Like serveMediaFile, but for files that leave under a profile's permission (featured photos): the JPEG is
 * buffered and served without metadata (EXIF GPS/date/caption/author, XMP, comments). Fails closed: anything
 * that isn't a well-formed JPEG is a 404, never the stored bytes.
 */
export async function serveStrippedJpeg(storage: ObjectStorage, key: string): Promise<Response> {
  const notFound = () => new HTTPException(404, { message: "Archivo no encontrado" });
  const object = await storage.get(key);
  if (!object) throw notFound();
  const contentType = object.contentType;
  if (key.endsWith(".mp4") || (contentType && contentType !== "image/jpeg")) throw notFound();

  let bytes: Uint8Array;
  try {
    bytes = stripJpegMetadata(new Uint8Array(await object.arrayBuffer()));
  } catch (err) {
    if (err instanceof InvalidJpegError) throw notFound();
    throw err;
  }

  return new Response(bytes, {
    headers: {
      "content-type": "image/jpeg",
      "content-length": String(bytes.length),
      // Stripping is deterministic, so the stored object's etag plus a suffix identifies these bytes.
      etag: `"${object.etag}-stripped"`,
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}
