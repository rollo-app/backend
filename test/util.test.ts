import { describe, expect, it } from "vitest";
import { generateToken, hashToken } from "../src/lib/auth";
import { mediaKeys, presignPut } from "../src/lib/r2";
import { generateJoinCode, isRevealed, isValidTimeZone, localDate, publicTrip } from "../src/lib/util";
import type { Env, TripRow } from "../src/types";
import { TZ } from "./helpers";

const baseTrip: TripRow = {
  id: "t1",
  name: "Viaje",
  join_code: "ABC234",
  timezone: TZ,
  starts_at: 1_000,
  ends_at: 2_000,
  reveal_at: 3_000,
  revealed_at: null,
  daily_photo_limit: 10,
  daily_video_limit: 3,
  created_at: 0,
};

describe("localDate", () => {
  it("usa la zona horaria del viaje, no UTC", () => {
    // 02:00 UTC del 10 de enero = 23:00 del 9 de enero en Buenos Aires (UTC-3)
    const ms = Date.UTC(2027, 0, 10, 2, 0);
    expect(localDate(ms, TZ)).toBe("2027-01-09");
    expect(localDate(ms, "UTC")).toBe("2027-01-10");
  });

  it("devuelve formato YYYY-MM-DD", () => {
    expect(localDate(Date.UTC(2027, 0, 5, 15), TZ)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("isValidTimeZone", () => {
  it("acepta zonas IANA", () => {
    expect(isValidTimeZone(TZ)).toBe(true);
    expect(isValidTimeZone("America/Montevideo")).toBe(true);
  });

  it("rechaza zonas inventadas", () => {
    expect(isValidTimeZone("Mars/Base")).toBe(false);
  });
});

describe("isRevealed", () => {
  it("no está revelado antes de reveal_at", () => {
    expect(isRevealed(baseTrip, 2_999)).toBe(false);
  });

  it("se revela solo al llegar reveal_at", () => {
    expect(isRevealed(baseTrip, 3_000)).toBe(true);
  });

  it("el revelado manual del admin gana aunque no haya llegado la fecha", () => {
    expect(isRevealed({ ...baseTrip, revealed_at: 1_500 }, 1_600)).toBe(true);
  });
});

describe("generateJoinCode", () => {
  it("genera 6 caracteres sin letras ni números ambiguos", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateJoinCode();
      expect(code).toHaveLength(6);
      expect(code).toMatch(/^[A-HJKMNP-Z2-9]+$/);
      expect(code).not.toMatch(/[01ILO]/);
    }
  });
});

describe("publicTrip", () => {
  it("expone camelCase y si está revelado", () => {
    expect(publicTrip(baseTrip, 0)).toEqual({
      id: "t1",
      name: "Viaje",
      joinCode: "ABC234",
      timezone: TZ,
      startsAt: 1_000,
      endsAt: 2_000,
      revealAt: 3_000,
      revealed: false,
      dailyPhotoLimit: 10,
      dailyVideoLimit: 3,
    });
  });
});

describe("tokens", () => {
  it("son únicos y url-safe", () => {
    const tokens = new Set(Array.from({ length: 100 }, generateToken));
    expect(tokens.size).toBe(100);
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("el hash es SHA-256 en hex y determinístico", async () => {
    const h1 = await hashToken("abc");
    expect(h1).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await hashToken("abc")).toBe(h1);
  });
});

describe("R2", () => {
  it("arma las keys por viaje y media", () => {
    expect(mediaKeys("t1", "m1", "photo")).toEqual({
      original: "trips/t1/m1/original.jpg",
      thumb: "trips/t1/m1/thumb.jpg",
    });
    expect(mediaKeys("t1", "m1", "video").original).toBe("trips/t1/m1/original.mp4");
  });

  it("firma URLs de subida contra el endpoint S3 de R2", async () => {
    const env = {
      R2_ACCOUNT_ID: "acc",
      R2_ACCESS_KEY_ID: "key",
      R2_SECRET_ACCESS_KEY: "secret",
      R2_BUCKET_NAME: "rollo-media",
    } as Env;
    const url = new URL(await presignPut(env, "trips/t1/m1/original.jpg", "https://rollo.test"));
    expect(url.host).toBe("acc.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/rollo-media/trips/t1/m1/original.jpg");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });
});

