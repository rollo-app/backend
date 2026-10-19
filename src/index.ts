import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import media from "./routes/media";
import trips from "./routes/trips";
import type { AppEnv } from "./types";

const app = new Hono<AppEnv>();

app.get("/", (c) => c.json({ ok: true, service: "rollo-api" }));

app.route("/trips", trips);
app.route("/", media);

app.notFound((c) => c.json({ error: "No encontrado" }, 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: "Error interno" }, 500);
});

export default app;
