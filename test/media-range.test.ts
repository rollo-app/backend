import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { serveMediaFile } from "../src/lib/r2";
import { api, newTrip, uploadMedia } from "./helpers";

const CONTENT = "0123456789";

/** A revealed rollo with one video whose original holds exactly CONTENT (10 bytes). */
async function revealedVideo() {
  const { tripId, adminToken } = await newTrip();
  const id = await uploadMedia(tripId, adminToken, { type: "video" });
  await env.MEDIA.put(`trips/${tripId}/${id}/original.mp4`, CONTENT);
  await api("POST", `/trips/${tripId}/reveal`, { token: adminToken });
  const get = (headers: Record<string, string> = {}) =>
    api("GET", `/trips/${tripId}/media/${id}/original`, { token: adminToken, headers });
  return { get };
}

describe("range requests on media downloads", () => {
  it("without Range it serves the whole file with 200 and advertises byte ranges", async () => {
    const { get } = await revealedVideo();
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toBe(CONTENT);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe("10");
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("etag")).toBeTruthy();
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
  });

  it("bytes=0-1 (AVPlayer's probe) returns exactly those 2 bytes with 206", async () => {
    const { get } = await revealedVideo();
    const res = await get({ range: "bytes=0-1" });
    expect(res.status).toBe(206);
    expect(res.body).toBe("01");
    expect(res.headers.get("content-range")).toBe("bytes 0-1/10");
    expect(res.headers.get("content-length")).toBe("2");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("etag")).toBeTruthy();
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
  });

  it("an open-ended range returns from the offset to the end", async () => {
    const { get } = await revealedVideo();
    const res = await get({ range: "bytes=4-" });
    expect(res.status).toBe(206);
    expect(res.body).toBe("456789");
    expect(res.headers.get("content-range")).toBe("bytes 4-9/10");
    expect(res.headers.get("content-length")).toBe("6");
  });

  it("a suffix range returns the last N bytes", async () => {
    const { get } = await revealedVideo();
    const res = await get({ range: "bytes=-3" });
    expect(res.status).toBe(206);
    expect(res.body).toBe("789");
    expect(res.headers.get("content-range")).toBe("bytes 7-9/10");
  });

  it("an end past the size is clamped to the last byte", async () => {
    const { get } = await revealedVideo();
    const res = await get({ range: "bytes=5-100" });
    expect(res.status).toBe(206);
    expect(res.body).toBe("56789");
    expect(res.headers.get("content-range")).toBe("bytes 5-9/10");
  });

  it("a start past the end is 416 with the total size", async () => {
    const { get } = await revealedVideo();
    for (const range of ["bytes=10-", "bytes=10-20", "bytes=-0"]) {
      const res = await get({ range });
      expect(res.status, range).toBe(416);
      expect(res.headers.get("content-range"), range).toBe("bytes */10");
    }
  });

  it("invalid, multi-range or non-byte ranges are ignored (200 with the whole file)", async () => {
    const { get } = await revealedVideo();
    for (const range of ["bytes=abc", "bytes=5-2", "bytes=0-1,4-5", "items=0-1", "bytes=", "bytes=-"]) {
      const res = await get({ range });
      expect(res.status, range).toBe(200);
      expect(res.body, range).toBe(CONTENT);
    }
  });

  it("If-Range: the range applies only while the etag matches", async () => {
    const { get } = await revealedVideo();
    const etag = (await get()).headers.get("etag")!;
    const match = await get({ range: "bytes=0-1", "if-range": etag });
    expect(match.status).toBe(206);
    expect(match.body).toBe("01");
    const stale = await get({ range: "bytes=0-1", "if-range": '"other"' });
    expect(stale.status).toBe(200);
    expect(stale.body).toBe(CONTENT);
  });

  it("ranges apply to the fallback file when the original is missing", async () => {
    const base = `range-fallback/${crypto.randomUUID()}`;
    await env.MEDIA.put(`${base}/display.jpg`, "abcdef");
    const res = await serveMediaFile(env.MEDIA, `${base}/original.jpg`, `${base}/display.jpg`, new Headers({ range: "bytes=2-3" }));
    expect(res.status).toBe(206);
    expect(await res.text()).toBe("cd");
    expect(res.headers.get("content-range")).toBe("bytes 2-3/6");
    expect(res.headers.get("content-type")).toBe("image/jpeg");
  });
});
