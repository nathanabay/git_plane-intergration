import { promises as fs } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Db {
  query<R = any>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
  exec(sql: string): Promise<unknown>;
  /** Runs fn on one dedicated connection, so BEGIN ... COMMIT cannot straddle pool connections.
   *  Single-connection engines (PGlite) omit it; callers then use the Db itself. */
  withConnection?<T>(fn: (conn: Db) => Promise<T>): Promise<T>;
}

// Arbitrary constant namespacing the migration lock; every replica must use the same key.
const MIGRATION_LOCK_KEY = 7_340_001;

export async function migrate(db: Db, opts: { dir?: string } = {}): Promise<{ applied: string[] }> {
  const dir = opts.dir ?? join(fileURLToPath(import.meta.url), "../migrations");
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const run = <T>(fn: (conn: Db) => Promise<T>): Promise<T> => (db.withConnection ? db.withConnection(fn) : fn(db));

  const applied: string[] = [];
  for (const file of files) {
    const sql = await fs.readFile(join(dir, file), "utf8");
    await run(async (conn) => {
      await conn.exec("BEGIN");
      try {
        // Transaction-scoped: replicas migrating at once queue here, and the lock is released by
        // COMMIT/ROLLBACK. Taken before CREATE TABLE so two runners cannot race on it either.
        await conn.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
        await conn.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
          version VARCHAR(255) PRIMARY KEY,
          applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )`);
        const seen = await conn.query("SELECT 1 FROM schema_migrations WHERE version = $1", [file]);
        if (seen.rows.length === 0) {
          await conn.exec(sql);
          await conn.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
          applied.push(file);
        }
        await conn.exec("COMMIT");
      } catch (err) {
        await conn.exec("ROLLBACK").catch(() => {});
        throw err;
      }
    });
  }
  return { applied };
}
