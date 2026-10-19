import { AwsClient } from "aws4fetch";
import type { Env, MediaType } from "../types";

export const DEV_UPLOAD_PREFIX = "/dev/upload/";

export const devUploadsEnabled = (env: Env) => env.DEV_LOCAL_UPLOADS === "1";

/**
 * URL prefirmada (API S3 de R2) para que el celular suba directo al bucket,
 * sin pasar el archivo por el Worker.
 *
 * En `wrangler dev` con DEV_LOCAL_UPLOADS=1 la URL apunta al propio worker (con el
 * `origin` del request, así el celular entra por la IP de la red) y termina en el R2 local.
 */
export async function presignPut(env: Env, key: string, origin: string, expiresIn = 900): Promise<string> {
  if (devUploadsEnabled(env)) {
    const exp = Date.now() + expiresIn * 1000;
    const url = new URL(`${DEV_UPLOAD_PREFIX}${key}`, origin);
    url.searchParams.set("exp", String(exp));
    url.searchParams.set("sig", await devSignature(env, key, exp));
    return url.toString();
  }

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

async function devSignature(env: Env, key: string, exp: number): Promise<string> {
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.R2_SECRET_ACCESS_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(`${key}\n${exp}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Valida una URL de subida local generada por `presignPut`. */
export async function verifyDevUpload(env: Env, key: string, exp: string | undefined, sig: string | undefined) {
  const expMs = Number(exp);
  if (!sig || !Number.isFinite(expMs) || expMs < Date.now()) return false;
  return sig === (await devSignature(env, key, expMs));
}
