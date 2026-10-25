import { AwsClient } from "aws4fetch";
import type { Presigner } from "./presigner";

export type S3PresignerConfig = {
  /** Base URL of the S3 API, e.g. `https://<account>.r2.cloudflarestorage.com`. */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
};

/** Presigned URLs for any S3-compatible API (R2 today; the same class would serve AWS S3). */
export class S3Presigner implements Presigner {
  private awsClient: AwsClient | undefined;

  constructor(private readonly config: S3PresignerConfig) {}

  /** Created on first use: building the dependencies must not need credentials (e.g. when only the contract is exported). */
  private get client(): AwsClient {
    return (this.awsClient ??= new AwsClient({
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      service: "s3",
      region: this.config.region,
    }));
  }

  private objectUrl(key: string): URL {
    return new URL(`${this.config.endpoint}/${this.config.bucket}/${key}`);
  }

  async putUrl(key: string, { size, expiresIn }: { origin: string; size: number | null; expiresIn: number }): Promise<string> {
    const url = this.objectUrl(key);
    url.searchParams.set("X-Amz-Expires", String(expiresIn));
    // aws4fetch leaves content-length out of the signature by default; `allHeaders` signs it, so the storage rejects
    // a PUT whose Content-Length differs.
    const headers = size != null ? { "content-length": String(size) } : undefined;
    const signed = await this.client.sign(new Request(url, { method: "PUT", headers }), {
      aws: { signQuery: true, allHeaders: size != null },
    });
    return signed.url;
  }

  async getUrl(key: string, expiresIn: number): Promise<string> {
    const url = this.objectUrl(key);
    url.searchParams.set("X-Amz-Expires", String(expiresIn));
    const signed = await this.client.sign(new Request(url, { method: "GET" }), { aws: { signQuery: true } });
    return signed.url;
  }
}
