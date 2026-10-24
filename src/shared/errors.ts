export type AppErrorKind = "bad_request" | "forbidden" | "not_found" | "conflict" | "rate_limited";

/** Domain error thrown by services; `onError` in `src/index.ts` maps it to an HTTP status. The message is user-facing. */
export class AppError extends Error {
  constructor(
    readonly kind: AppErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const STATUS_BY_KIND: Record<AppErrorKind, 400 | 403 | 404 | 409 | 429> = {
  bad_request: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
};

export const badRequest = (message: string) => new AppError("bad_request", message);
export const forbidden = (message: string) => new AppError("forbidden", message);
export const notFound = (message = "No encontrado") => new AppError("not_found", message);
export const conflict = (message: string) => new AppError("conflict", message);
export const rateLimited = (message: string) => new AppError("rate_limited", message);
