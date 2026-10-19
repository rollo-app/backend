import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  api,
  createTrip,
  DAY,
  HOUR,
  join,
  MINUTE,
  photoBody,
  putFiles,
  uploadMedia,
  videoBody,
} from "./helpers";

describe("POST /trips/:id/media (registrar)", () => {
  it("devuelve URLs firmadas para original y thumbnail", async () => {
    const { tripId, adminToken } = await createTrip();
    const body = photoBody();
    const res = await api("POST", `/trips/${tripId}/media`, { token: adminToken, body });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: body.id, status: "pending", expiresIn: 900 });
    expect(res.body.upload.original).toContain(`/trips/${tripId}/${body.id}/original.jpg`);
    expect(res.body.upload.thumb).toContain(`/trips/${tripId}/${body.id}/thumb.jpg`);
    expect(res.body.upload.original).toContain("X-Amz-Signature=");
  });

  it("es idempotente: reintentar con el mismo id no duplica ni gasta cupo", async () => {
    const { tripId, adminToken } = await createTrip({ dailyPhotoLimit: 1 });
    const body = photoBody();

    expect((await api("POST", `/trips/${tripId}/media`, { token: adminToken, body })).status).toBe(201);
    const retry = await api("POST", `/trips/${tripId}/media`, { token: adminToken, body });
    expect(retry.status).toBe(200);
    expect(retry.body.upload.original).toEqual(expect.any(String));

    const { results } = await env.DB.prepare("SELECT id FROM media").all();
    expect(results).toHaveLength(1);
  });

  it("si ya se subió, el reintento solo confirma", async () => {
    const { tripId, adminToken } = await createTrip();
    const body = photoBody();
    await api("POST", `/trips/${tripId}/media`, { token: adminToken, body });
    await putFiles(tripId, body.id);
    await api("POST", `/media/${body.id}/complete`, { token: adminToken });

    const retry = await api("POST", `/trips/${tripId}/media`, { token: adminToken, body });
    expect(retry.body).toEqual({ id: body.id, status: "uploaded" });
  });

  it("no deja usar el id de otra persona", async () => {
    const { tripId, code, adminToken } = await createTrip();
    const fede = await join(code, "Fede");
    const body = photoBody();
    await api("POST", `/trips/${tripId}/media`, { token: adminToken, body });
    expect((await api("POST", `/trips/${tripId}/media`, { token: fede.token, body })).status).toBe(409);
  });

  it("rechaza videos de más de 15 segundos", async () => {
    const { tripId, adminToken } = await createTrip();
    const res = await api("POST", `/trips/${tripId}/media`, {
      token: adminToken,
      body: videoBody({ durationS: 22 }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/15 segundos/);
  });

  it("acepta un video de 15 segundos justos", async () => {
    const { tripId, adminToken } = await createTrip();
    const res = await api("POST", `/trips/${tripId}/media`, {
      token: adminToken,
      body: videoBody({ durationS: 15 }),
    });
    expect(res.status).toBe(201);
    expect(res.body.upload.original).toContain("original.mp4");
  });

  it("rechaza archivos demasiado grandes", async () => {
    const { tripId, adminToken } = await createTrip();
    const res = await api("POST", `/trips/${tripId}/media`, {
      token: adminToken,
      body: photoBody({ sizeBytes: 30 * 1024 * 1024 }),
    });
    expect(res.status).toBe(400);
  });

  it("rechaza fotos con hora en el futuro", async () => {
    const { tripId, adminToken } = await createTrip();
    const res = await api("POST", `/trips/${tripId}/media`, {
      token: adminToken,
      body: photoBody({ takenAt: Date.now() + HOUR }),
    });
    expect(res.status).toBe(400);
  });

  it("rechaza fotos de antes del viaje", async () => {
    const { tripId, adminToken } = await createTrip();
    const res = await api("POST", `/trips/${tripId}/media`, {
      token: adminToken,
      body: photoBody({ takenAt: Date.now() - 5 * DAY }),
    });
    expect(res.status).toBe(400);
  });

  it("acepta fotos sin GPS", async () => {
    const { tripId, adminToken } = await createTrip();
    const res = await api("POST", `/trips/${tripId}/media`, {
      token: adminToken,
      body: photoBody({ lat: null, lng: null, accuracyM: null }),
    });
    expect(res.status).toBe(201);
  });

  it("no acepta nada después del revelado", async () => {
    const { tripId, adminToken } = await createTrip();
    await api("POST", `/trips/${tripId}/reveal`, { token: adminToken });
    const res = await api("POST", `/trips/${tripId}/media`, { token: adminToken, body: photoBody() });
    expect(res.status).toBe(409);
  });
});

describe("límite diario", () => {
  it("corta al llegar al límite de fotos del día", async () => {
    const { tripId, adminToken } = await createTrip({ dailyPhotoLimit: 2 });
    await uploadMedia(tripId, adminToken);
    await uploadMedia(tripId, adminToken);

    const res = await api("POST", `/trips/${tripId}/media`, { token: adminToken, body: photoBody() });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("Ya usaste tus 2 fotos de hoy");
  });

  it("las pendientes también cuentan", async () => {
    const { tripId, adminToken } = await createTrip({ dailyPhotoLimit: 1 });
    await api("POST", `/trips/${tripId}/media`, { token: adminToken, body: photoBody() });
    const res = await api("POST", `/trips/${tripId}/media`, { token: adminToken, body: photoBody() });
    expect(res.status).toBe(429);
  });

  it("fotos y videos tienen cupos separados", async () => {
    const { tripId, adminToken } = await createTrip({ dailyPhotoLimit: 1, dailyVideoLimit: 1 });
    await uploadMedia(tripId, adminToken);
    const res = await api("POST", `/trips/${tripId}/media`, { token: adminToken, body: videoBody() });
    expect(res.status).toBe(201);
  });

  it("el cupo es por persona", async () => {
    const { tripId, code, adminToken } = await createTrip({ dailyPhotoLimit: 1 });
    const fede = await join(code, "Fede");
    await uploadMedia(tripId, adminToken);
    const res = await api("POST", `/trips/${tripId}/media`, { token: fede.token, body: photoBody() });
    expect(res.status).toBe(201);
  });

  it("una foto sacada ayer (subida hoy) cuenta para el cupo de ayer", async () => {
    const { tripId, adminToken } = await createTrip({ dailyPhotoLimit: 1, startsAt: Date.now() - 3 * DAY });
    await uploadMedia(tripId, adminToken);
    const res = await api("POST", `/trips/${tripId}/media`, {
      token: adminToken,
      body: photoBody({ takenAt: Date.now() - DAY - HOUR }),
    });
    expect(res.status).toBe(201);
  });
});

describe("POST /media/:id/complete", () => {
  it("falla si los archivos no están en R2", async () => {
    const { tripId, adminToken } = await createTrip();
    const body = photoBody();
    await api("POST", `/trips/${tripId}/media`, { token: adminToken, body });
    const res = await api("POST", `/media/${body.id}/complete`, { token: adminToken });
    expect(res.status).toBe(400);
  });

  it("falla si falta solo el thumbnail", async () => {
    const { tripId, adminToken } = await createTrip();
    const body = photoBody();
    await api("POST", `/trips/${tripId}/media`, { token: adminToken, body });
    await env.MEDIA.put(`trips/${tripId}/${body.id}/original.jpg`, "x");
    expect((await api("POST", `/media/${body.id}/complete`, { token: adminToken })).status).toBe(400);
  });

  it("marca como subida y guarda el tamaño real", async () => {
    const { tripId, adminToken } = await createTrip();
    const body = photoBody();
    await api("POST", `/trips/${tripId}/media`, { token: adminToken, body });
    await putFiles(tripId, body.id);

    const res = await api("POST", `/media/${body.id}/complete`, { token: adminToken });
    expect(res.body).toEqual({ id: body.id, status: "uploaded" });

    const row = await env.DB.prepare("SELECT status, size_bytes FROM media WHERE id = ?").bind(body.id).first();
    expect(row).toEqual({ status: "uploaded", size_bytes: `original-${body.id}`.length });
  });

  it("nadie puede confirmar la foto de otro", async () => {
    const { tripId, code, adminToken } = await createTrip();
    const fede = await join(code, "Fede");
    const body = photoBody();
    await api("POST", `/trips/${tripId}/media`, { token: adminToken, body });
    await putFiles(tripId, body.id);
    expect((await api("POST", `/media/${body.id}/complete`, { token: fede.token })).status).toBe(404);
  });
});

describe("GET /trips/:id/feed", () => {
  it("antes del revelado: solo metadata, sin archivos (ni los propios)", async () => {
    const { tripId, code } = await createTrip();
    const fede = await join(code, "Fede");
    await uploadMedia(tripId, fede.token, { caption: "el viento" });

    const res = await api("GET", `/trips/${tripId}/feed`, { token: fede.token });
    expect(res.status).toBe(200);
    expect(res.body.revealed).toBe(false);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      type: "photo",
      caption: "el viento",
      lat: -49.33,
      lng: -72.88,
      author: { name: "Fede" },
    });
    expect(res.body.items[0]).not.toHaveProperty("files");
  });

  it("no muestra las que todavía no terminaron de subir", async () => {
    const { tripId, adminToken } = await createTrip();
    await api("POST", `/trips/${tripId}/media`, { token: adminToken, body: photoBody() });
    const res = await api("GET", `/trips/${tripId}/feed`, { token: adminToken });
    expect(res.body.items).toHaveLength(0);
  });

  it("ordena por hora en que se sacó, no por hora de subida", async () => {
    const { tripId, adminToken } = await createTrip({ dailyPhotoLimit: 5 });
    const later = await uploadMedia(tripId, adminToken, { takenAt: Date.now() - MINUTE });
    const earlier = await uploadMedia(tripId, adminToken, { takenAt: Date.now() - 2 * HOUR });

    const res = await api("GET", `/trips/${tripId}/feed`, { token: adminToken });
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([earlier, later]);
  });

  it("después del revelado incluye los archivos", async () => {
    const { tripId, adminToken } = await createTrip();
    const id = await uploadMedia(tripId, adminToken);
    await api("POST", `/trips/${tripId}/reveal`, { token: adminToken });

    const res = await api("GET", `/trips/${tripId}/feed`, { token: adminToken });
    expect(res.body.revealed).toBe(true);
    expect(res.body.items[0].files).toEqual({
      thumb: `/trips/${tripId}/media/${id}/thumb`,
      original: `/trips/${tripId}/media/${id}/original`,
    });
  });
});

describe("descargas", () => {
  it("bloqueadas antes del revelado", async () => {
    const { tripId, adminToken } = await createTrip();
    const id = await uploadMedia(tripId, adminToken);
    expect((await api("GET", `/trips/${tripId}/media/${id}/thumb`, { token: adminToken })).status).toBe(403);
  });

  it("después del revelado devuelve thumb y original", async () => {
    const { tripId, code, adminToken } = await createTrip();
    const fede = await join(code, "Fede");
    const id = await uploadMedia(tripId, adminToken);
    await api("POST", `/trips/${tripId}/reveal`, { token: adminToken });

    const thumb = await api("GET", `/trips/${tripId}/media/${id}/thumb`, { token: fede.token });
    expect(thumb.status).toBe(200);
    expect(thumb.body).toBe(`thumb-${id}`);
    expect(thumb.headers.get("content-type")).toBe("image/jpeg");

    const original = await api("GET", `/trips/${tripId}/media/${id}/original`, { token: fede.token });
    expect(original.body).toBe(`original-${id}`);
  });

  it("los videos se sirven como mp4", async () => {
    const { tripId, adminToken } = await createTrip();
    const id = await uploadMedia(tripId, adminToken, { type: "video" });
    await api("POST", `/trips/${tripId}/reveal`, { token: adminToken });
    const res = await api("GET", `/trips/${tripId}/media/${id}/original`, { token: adminToken });
    expect(res.headers.get("content-type")).toBe("video/mp4");
  });

  it("no se pueden pedir archivos de otro viaje", async () => {
    const a = await createTrip();
    const b = await createTrip();
    const id = await uploadMedia(a.tripId, a.adminToken);
    await api("POST", `/trips/${b.tripId}/reveal`, { token: b.adminToken });
    expect((await api("GET", `/trips/${b.tripId}/media/${id}/thumb`, { token: b.adminToken })).status).toBe(404);
  });
});

describe("DELETE /media/:id", () => {
  it("borra una foto propia y sus archivos antes del revelado", async () => {
    const { tripId, adminToken } = await createTrip();
    const id = await uploadMedia(tripId, adminToken);

    expect((await api("DELETE", `/media/${id}`, { token: adminToken })).status).toBe(204);
    expect(await env.MEDIA.head(`trips/${tripId}/${id}/original.jpg`)).toBeNull();
    expect(await env.MEDIA.head(`trips/${tripId}/${id}/thumb.jpg`)).toBeNull();
    expect((await api("GET", `/trips/${tripId}/feed`, { token: adminToken })).body.items).toHaveLength(0);
  });

  it("devuelve el cupo del día", async () => {
    const { tripId, adminToken } = await createTrip({ dailyPhotoLimit: 1 });
    const id = await uploadMedia(tripId, adminToken);
    await api("DELETE", `/media/${id}`, { token: adminToken });
    expect((await api("POST", `/trips/${tripId}/media`, { token: adminToken, body: photoBody() })).status).toBe(201);
  });

  it("no se puede borrar la foto de otro", async () => {
    const { tripId, code, adminToken } = await createTrip();
    const fede = await join(code, "Fede");
    const id = await uploadMedia(tripId, adminToken);
    expect((await api("DELETE", `/media/${id}`, { token: fede.token })).status).toBe(404);
  });

  it("no se puede borrar después del revelado", async () => {
    const { tripId, adminToken } = await createTrip();
    const id = await uploadMedia(tripId, adminToken);
    await api("POST", `/trips/${tripId}/reveal`, { token: adminToken });
    expect((await api("DELETE", `/media/${id}`, { token: adminToken })).status).toBe(409);
  });
});

describe("thumbhash", () => {
  // ThumbHash real de ~25 bytes en base64 estándar
  const HASH = "3OcRJYB4d3h/iIeHeEh3eIhw+j3A";

  it("se guarda al registrar y aparece en el feed antes del revelado", async () => {
    const { tripId, adminToken } = await createTrip();
    const id = await uploadMedia(tripId, adminToken, { thumbhash: HASH });
    const feed = await api("GET", `/trips/${tripId}/feed`, { token: adminToken });
    expect(feed.body.revealed).toBe(false);
    const item = feed.body.items.find((i: any) => i.id === id);
    expect(item.thumbhash).toBe(HASH);
    expect(item.files).toBeUndefined();
  });

  it("también sigue después del revelado", async () => {
    const { tripId, adminToken } = await createTrip();
    await uploadMedia(tripId, adminToken, { type: "video", thumbhash: HASH });
    await api("POST", `/trips/${tripId}/reveal`, { token: adminToken });
    const feed = await api("GET", `/trips/${tripId}/feed`, { token: adminToken });
    expect(feed.body.items[0].thumbhash).toBe(HASH);
  });

  it("es opcional: sin thumbhash el feed devuelve null", async () => {
    const { tripId, adminToken } = await createTrip();
    await uploadMedia(tripId, adminToken);
    const feed = await api("GET", `/trips/${tripId}/feed`, { token: adminToken });
    expect(feed.body.items[0].thumbhash).toBeNull();
  });

  it("rechaza algo que no es base64", async () => {
    const { tripId, adminToken } = await createTrip();
    const res = await api("POST", `/trips/${tripId}/media`, {
      token: adminToken,
      body: photoBody({ thumbhash: "no es base64!" }),
    });
    expect(res.status).toBe(400);
  });

  it("rechaza thumbhash de más de 64 caracteres", async () => {
    const { tripId, adminToken } = await createTrip();
    const res = await api("POST", `/trips/${tripId}/media`, {
      token: adminToken,
      body: photoBody({ thumbhash: "A".repeat(68) }),
    });
    expect(res.status).toBe(400);
  });

  it("un reintento con otro thumbhash no falla y se queda con el primero", async () => {
    const { tripId, adminToken } = await createTrip();
    const body = photoBody({ thumbhash: HASH });
    expect((await api("POST", `/trips/${tripId}/media`, { token: adminToken, body })).status).toBe(201);
    const retry = await api("POST", `/trips/${tripId}/media`, {
      token: adminToken,
      body: { ...body, thumbhash: "AAAAAAAAAAAA" },
    });
    expect(retry.status).toBe(200);
    await putFiles(tripId, body.id);
    await api("POST", `/media/${body.id}/complete`, { token: adminToken });
    const feed = await api("GET", `/trips/${tripId}/feed`, { token: adminToken });
    expect(feed.body.items[0].thumbhash).toBe(HASH);
  });
});
