import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "../db/schema";

export type DB = DrizzleD1Database<typeof schema>;

const instances = new WeakMap<D1Database, DB>();

/** Drizzle client for a D1 binding, memoized per binding instance. */
export function orm(d1: D1Database): DB {
  let db = instances.get(d1);
  if (!db) {
    db = drizzle(d1, { schema });
    instances.set(d1, db);
  }
  return db;
}

/**
 * Turns a Drizzle query (not awaited) into an unexecuted `D1PreparedStatement`.
 * Repositories return this for writes instead of running them: during the migration to Drizzle a service batches
 * writes from migrated and not-yet-migrated modules together with `d1.batch([...])` (e.g. `blockFeature` groups
 * `media.blockFeaturing` with the still-raw-SQL `featured.deleteFeaturedByOthers`). Once every module is on
 * Drizzle this goes away in favor of Drizzle's own `db.batch([...])`.
 */
export function toStatement(d1: D1Database, query: { toSQL(): { sql: string; params: unknown[] } }): D1PreparedStatement {
  const { sql, params } = query.toSQL();
  return d1.prepare(sql).bind(...params);
}
