/**
 * Work to run after the response is sent (a push). The service builds it; the controller defers it with
 * `deferPush(c, notify())`, so services never need the request context. `null` when there is nothing to send.
 */
export type AfterResponse = (() => Promise<unknown>) | null;
