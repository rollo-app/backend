/**
 * Object storage (photos, videos, avatars). Provider-neutral: the services only know this interface;
 * which implementation is used is decided in `src/container.ts`.
 */

/** A stored object ready to be read or served over HTTP. */
export type StoredObject = {
  size: number;
  /** Raw entity tag (no quotes). */
  etag: string;
  /** Entity tag as an HTTP header value (quoted). */
  httpEtag: string;
  /** Content type recorded when the object was stored, if any. */
  contentType: string | undefined;
  body: ReadableStream;
  /** Consumes the body. */
  arrayBuffer(): Promise<ArrayBuffer>;
  /** Copies the HTTP metadata stored with the object (content type, encoding, disposition, cache control...) into `headers`. */
  applyHttpMetadata(headers: Headers): void;
};

export type ListedObject = { key: string; size: number; uploaded: Date };

export interface ObjectStorage {
  put(key: string, body: ArrayBuffer | Uint8Array | string, opts?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  head(key: string): Promise<{ size: number } | null>;
  /** Deletes the keys (missing ones are fine). Any number of keys: the implementation chunks as the provider requires. */
  delete(keys: string[]): Promise<void>;
  /** One page of objects ordered by key. `cursor` continues a previous page; `startAfter` starts after a key. */
  list(opts: { prefix?: string; cursor?: string; startAfter?: string; limit?: number }): Promise<{ objects: ListedObject[]; cursor: string | null }>;
  /** Signed URL the phone PUTs to. With a `size` it only accepts a body of exactly that many bytes. */
  presignPut(key: string, opts: { origin: string; size: number | null; expiresIn: number }): Promise<string>;
  /** Signed URL to read a stored file (e.g. a link in a support email). */
  presignGet(key: string, expiresIn: number): Promise<string>;
}
