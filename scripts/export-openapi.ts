import { writeFileSync } from "node:fs";
import app from "../src/index";
import type { Env } from "../src/types";

// The empty env is enough: this route touches no binding. Generates openapi.json from the code. Run after changing the API: `npm run openapi`.
const res = await app.request("/openapi.json", undefined, {} as Env);
const doc = await res.json();
writeFileSync(new URL("../openapi.json", import.meta.url), `${JSON.stringify(doc, null, 2)}\n`);
console.log("openapi.json updated");
