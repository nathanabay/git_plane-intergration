import pkg from "pg";
import type { Db } from "./migrate.ts";
const { Pool } = pkg;

export function createDb(databaseUrl: string): Db & { close(): Promise<void> } {
  const pool = new Pool({ connectionString: databaseUrl });

  return {
    async query<R = any>(text: string, params?: unknown[]) {
      const res = await pool.query(text, params);
      return { rows: res.rows as R[] };
    },
    async exec(sql: string) {
      return pool.query(sql);
    },
    async withConnection<T>(fn: (conn: Db) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      let failed = false;
      try {
        return await fn({
          async query<R = any>(text: string, params?: unknown[]) {
            const res = await client.query(text, params);
            return { rows: res.rows as R[] };
          },
          exec: (sql: string) => client.query(sql),
        });
      } catch (err) {
        failed = true;
        throw err;
      } finally {
        // Destroy the connection after a failure so it cannot return to the pool mid-transaction.
        client.release(failed);
      }
    },
    async close() {
      await pool.end();
    }
  };
}
