import { AwsClient } from "aws4fetch";
import type { Env, MediaType } from "../types";

/**
 * URL prefirmada (API S3 de R2) para que el celular suba directo al bucket,
 * sin pasar el archivo por el Worker.
 */
export async function presignPut(env: Env, key: string, expiresIn = 900): Promise<string> {
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
  const url = new URL(
    `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${key}`,
  );
  url.searchParams.set("X-Amz-Expires", String(expiresIn));
  const signed = await client.sign(new Request(url, { method: "PUT" }), {
    aws: { signQuery: true },
  });
  return signed.url;
}

export function mediaKeys(tripId: string, mediaId: string, type: MediaType) {
  const base = `trips/${tripId}/${mediaId}`;
  return {
    original: `${base}/original.${type === "video" ? "mp4" : "jpg"}`,
    thumb: `${base}/thumb.jpg`,
  };
}
