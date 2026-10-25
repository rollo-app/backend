/**
 * Dependency injection: the only place that decides which implementation backs each external service.
 * Services and helpers receive `Deps` (or a `Pick` of it) and only know the ports in `src/ports/`.
 * To switch provider, write a class that implements the port and change it here.
 */
import { CloudflareRateLimiter } from "./infra/cloudflare/cloudflare-rate-limiter";
import { DevMailer } from "./infra/dev/dev-mailer";
import { ExpoPushGateway } from "./infra/expo/expo-push-gateway";
import { DevUploadPresigner } from "./infra/r2/dev-upload-presigner";
import type { Presigner } from "./infra/r2/presigner";
import { R2Storage } from "./infra/r2/r2-storage";
import { S3Presigner } from "./infra/r2/s3-presigner";
import { ResendMailer } from "./infra/resend/resend-mailer";
import type { Mailer } from "./ports/mailer";
import type { PushGateway } from "./ports/push";
import type { RateLimiter } from "./ports/rate-limiter";
import type { ObjectStorage } from "./ports/storage";
import type { Env } from "./types";

/** R2's free tier is 10 GB (decimal, to stay on the safe side). */
export const DEFAULT_STORAGE_LIMIT_BYTES = 10_000_000_000;
export const DEFAULT_LOGIN_LINK_URL = "https://rollo.juanifraga.com/entrar";
const DEFAULT_EMAIL_FROM = "Rollo <rollo@juanifraga.com>";
const DEFAULT_REPORTS_EMAIL = "soporte@juanifraga.com";

/** Settings read from the environment, typed and with defaults applied. */
export type AppConfig = {
  /** Sender of every email. */
  emailFrom: string;
  /** Where support emails (reports, blocks, alerts) go. */
  reportsEmail: string;
  /** Base URL of the login magic link; token and email go in its fragment. */
  loginLinkUrl: string;
  /** App Review account: for this email no email is sent and `reviewCode` is accepted as the code. */
  reviewEmail: string | undefined;
  reviewCode: string | undefined;
  /** Storage limit in bytes; uploads stop at 95% of it. */
  storageLimitBytes: number;
  /** Bearer token of the `/admin/*` routes; without it those routes are disabled. */
  adminToken: string | undefined;
};

/** Checks the signature of the dev-only upload URLs (`DEV_LOCAL_UPLOADS`). Null in production. */
export type DevUploads = Pick<DevUploadPresigner, "verify">;

export type Deps = {
  db: D1Database;
  storage: ObjectStorage;
  mailer: Mailer;
  push: PushGateway;
  rateLimiter: RateLimiter;
  config: AppConfig;
  devUploads: DevUploads | null;
};

function buildConfig(env: Env): AppConfig {
  const limit = Number(env.STORAGE_LIMIT_BYTES);
  return {
    emailFrom: env.EMAIL_FROM ?? DEFAULT_EMAIL_FROM,
    reportsEmail: env.REPORTS_EMAIL ?? DEFAULT_REPORTS_EMAIL,
    loginLinkUrl: env.LOGIN_LINK_URL || DEFAULT_LOGIN_LINK_URL,
    reviewEmail: env.REVIEW_EMAIL,
    reviewCode: env.REVIEW_CODE,
    storageLimitBytes: Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_STORAGE_LIMIT_BYTES,
    adminToken: env.ADMIN_TOKEN,
  };
}

export function buildDeps(env: Env): Deps {
  const config = buildConfig(env);

  const devUploads = env.DEV_LOCAL_UPLOADS === "1" ? new DevUploadPresigner(env.R2_SECRET_ACCESS_KEY) : null;
  const presigner: Presigner =
    devUploads ??
    new S3Presigner({
      endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      bucket: env.R2_BUCKET_NAME,
      region: "auto",
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    });

  return {
    db: env.DB,
    storage: new R2Storage(env.MEDIA, presigner),
    mailer: env.RESEND_API_KEY ? new ResendMailer(env.RESEND_API_KEY, config.emailFrom) : new DevMailer(),
    push: new ExpoPushGateway(),
    rateLimiter: new CloudflareRateLimiter({
      global: env.RL_GLOBAL,
      ip: env.RL_IP,
      expensive: env.RL_EXPENSIVE,
      files: env.RL_FILES,
    }),
    config,
    devUploads,
  };
}

const cache = new WeakMap<Env, Deps>();

/** `buildDeps` memoized by env object (a request may carry its own env override, e.g. in tests). */
export function depsFor(env: Env): Deps {
  let deps = cache.get(env);
  if (!deps) cache.set(env, (deps = buildDeps(env)));
  return deps;
}
