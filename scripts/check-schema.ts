// Checks that src/db/schema.ts matches migrations/*.sql: builds one in-memory SQLite DB from the migrations and
// another from the DDL drizzle-kit generates from the schema, then compares tables, columns (name, type, notnull,
// default, pk), foreign keys and indexes (compared by table + columns + unique + partial; names may differ).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = join(import.meta.dirname, "..");
const outDir = mkdtempSync(join(tmpdir(), "rollo-drizzle-"));

function run(sql: string): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(sql);
  return db;
}

// Generated DDL (drizzle-kit writes into a temp dir, never into migrations/).
execFileSync("npx", ["drizzle-kit", "generate"], { cwd: root, stdio: "pipe", env: { ...process.env, DRIZZLE_OUT: outDir } });
const generatedSql = readdirSync(outDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(outDir, f), "utf8").replaceAll("--> statement-breakpoint", ""))
  .join("\n");
rmSync(outDir, { recursive: true, force: true });

const migrationsDir = join(root, "migrations");
const migrationsSql = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(migrationsDir, f), "utf8"))
  .join("\n");

const fromMigrations = run(migrationsSql);
const fromSchema = run(generatedSql);

type Row = Record<string, unknown>;

function describe(db: DatabaseSync): Map<string, string> {
  const out = new Map<string, string>();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Row[];
  for (const { name } of tables as { name: string }[]) {
    const columns = db.prepare(`PRAGMA table_info("${name}")`).all() as Row[];
    for (const c of columns) {
      const dflt = c.dflt_value === null ? "-" : String(c.dflt_value).replace(/^\((.*)\)$/, "$1");
      out.set(
        `column ${name}.${c.name}`,
        // SQLite lets a non-INTEGER PRIMARY KEY hold NULL (legacy quirk) while drizzle-kit writes NOT NULL; a primary
        // key is never null in practice, so it counts as NOT NULL on both sides.
        `type=${String(c.type).toLowerCase()} notnull=${c.pk ? 1 : c.notnull} default=${dflt} pk=${c.pk}`,
      );
    }
    const fks = db.prepare(`PRAGMA foreign_key_list("${name}")`).all() as Row[];
    for (const fk of fks) {
      out.set(`fk ${name}.${fk.from}`, `-> ${fk.table}.${fk.to} onDelete=${fk.on_delete}`);
    }
    const indexes = db.prepare(`PRAGMA index_list("${name}")`).all() as Row[];
    for (const ix of indexes) {
      // `UNIQUE (...)` constraints (origin u) and unique indexes (origin c) are the same thing to SQLite; primary
      // keys (origin pk) are covered by the column check above.
      if (ix.origin === "pk") continue;
      const cols = (db.prepare(`PRAGMA index_info("${ix.name}")`).all() as Row[]).map((r) => r.name).join(",");
      const partial = ix.partial ? "partial" : "full";
      out.set(`index ${name}(${cols})`, `unique=${ix.unique} ${partial}`);
    }
  }
  return out;
}

// CHECK constraints and partial index predicates: compare the normalized SQL text of the definitions.
function checks(db: DatabaseSync): Map<string, string> {
  const out = new Map<string, string>();
  const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as {
    name: string;
    sql: string;
  }[];
  for (const { name, sql } of rows) {
    const found = [...sql.matchAll(/CHECK\s*\(((?:[^()]|\([^()]*\))*)\)/gi)].map((m) =>
      m[1]!.replace(/[`"]/g, "").replace(new RegExp(`\\b${name}\\.`, "g"), "").replace(/\s+/g, " ").trim(),
    );
    out.set(`checks ${name}`, found.sort().join(" | ") || "-");
  }
  const indexes = db.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql LIKE '%WHERE%'").all() as {
    tbl_name: string;
    sql: string;
  }[];
  for (const { tbl_name, sql } of indexes) {
    const where = sql.slice(sql.toUpperCase().lastIndexOf("WHERE") + 5).replace(/[`"]/g, "").replace(new RegExp(`\\b${tbl_name}\\.`, "g"), "").replace(/\s+/g, " ").trim();
    const cols = sql.match(/\(([^)]*)\)/)?.[1]?.replace(/[`"\s]/g, "") ?? "";
    out.set(`partial predicate ${tbl_name}(${cols})`, where);
  }
  return out;
}

const a = new Map([...describe(fromMigrations), ...checks(fromMigrations)]);
const b = new Map([...describe(fromSchema), ...checks(fromSchema)]);

const problems: string[] = [];
for (const key of new Set([...a.keys(), ...b.keys()])) {
  const inMigrations = a.get(key);
  const inSchema = b.get(key);
  if (inMigrations === undefined) problems.push(`only in schema.ts:  ${key}  [${inSchema}]`);
  else if (inSchema === undefined) problems.push(`only in migrations: ${key}  [${inMigrations}]`);
  else if (inMigrations !== inSchema) problems.push(`different: ${key}\n    migrations: ${inMigrations}\n    schema.ts:  ${inSchema}`);
}

if (problems.length > 0) {
  console.error(`Schema drift (${problems.length}):\n${problems.map((p) => `  ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`Schema OK: ${a.size} facts match between migrations/*.sql and src/db/schema.ts`);
