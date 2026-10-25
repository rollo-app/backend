import type { ListedObject, ObjectStorage, StoredObject } from "../../ports/storage";
import type { Presigner } from "./presigner";

/** R2 deletes accept at most 1000 keys per call. */
const DELETE_CHUNK = 1000;

/** `ObjectStorage` on a Cloudflare R2 bucket binding. URL signing is delegated to a `Presigner`. */
export class R2Storage implements ObjectStorage {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly presigner: Presigner,
  ) {}

  async put(key: string, body: ArrayBuffer | Uint8Array | string, opts?: { contentType?: string }): Promise<void> {
    await this.bucket.put(key, body, opts?.contentType ? { httpMetadata: { contentType: opts.contentType } } : undefined);
  }

  async get(key: string): Promise<StoredObject | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;
    return {
      size: object.size,
      etag: object.etag,
      httpEtag: object.httpEtag,
      contentType: object.httpMetadata?.contentType,
      body: object.body,
      arrayBuffer: () => object.arrayBuffer(),
      applyHttpMetadata: (headers) => object.writeHttpMetadata(headers),
    };
  }

  async head(key: string): Promise<{ size: number } | null> {
    const object = await this.bucket.head(key);
    return object ? { size: object.size } : null;
  }

  async delete(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += DELETE_CHUNK) await this.bucket.delete(keys.slice(i, i + DELETE_CHUNK));
  }

  async list(opts: { prefix?: string; cursor?: string; startAfter?: string; limit?: number }): Promise<{ objects: ListedObject[]; cursor: string | null }> {
    const page = await this.bucket.list({
      ...(opts.prefix !== undefined && { prefix: opts.prefix }),
      ...(opts.cursor !== undefined && { cursor: opts.cursor }),
      ...(opts.startAfter !== undefined && { startAfter: opts.startAfter }),
      ...(opts.limit !== undefined && { limit: opts.limit }),
    });
    return {
      objects: page.objects.map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded })),
      cursor: page.truncated ? page.cursor : null,
    };
  }

  presignPut(key: string, opts: { origin: string; size: number | null; expiresIn: number }): Promise<string> {
    return this.presigner.putUrl(key, opts);
  }

  presignGet(key: string, expiresIn: number): Promise<string> {
    return this.presigner.getUrl(key, expiresIn);
  }
}
