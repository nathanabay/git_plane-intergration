import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../../src/db/migrate.ts";

export async function database(t: { after(fn: () => Promise<unknown>): void }) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.waitReady;
  await migrate(db);
  return db;
}

export function queue() {
  const jobs = new Map<string, any>();
  let failAdd = false;
  return {
    jobs, failNextAdd() { failAdd = true; },
    async add(_name: string, data: any, opts: any) {
      if (failAdd) { failAdd = false; throw new Error("Redis temporarily unavailable"); }
      if (!jobs.has(opts.jobId)) jobs.set(opts.jobId, { id: opts.jobId, data, getState: async () => "waiting" });
      return jobs.get(opts.jobId);
    },
    async getJob(id: string) { return jobs.get(id); },
  };
}

/** Construct an executor wake-up for an intent, including a parked non-head in concurrency tests. */
export async function intentJob(db: { query<T>(sql: string, params?: any[]): Promise<{ rows: T[] }> }, id?: string) {
  const rows = await db.query<{ id: string; side: string; target_key: string; write: any; delivery_id: string | null; workspace_slug: string | null; actor_user_id: string | null }>(
    id ? "SELECT id, side, target_key, write, delivery_id, workspace_slug, actor_user_id FROM outbound_writes WHERE id = $1" : "SELECT id, side, target_key, write, delivery_id, workspace_slug, actor_user_id FROM outbound_writes ORDER BY sequence DESC LIMIT 1", id ? [id] : []);
  const row = rows.rows[0]!;
  return { id: row.id, data: { ...row.write, _gitsync: { id: row.id, side: row.side, targetKey: row.target_key,
    ...(row.delivery_id ? { deliveryId: row.delivery_id } : {}),
    ...(row.workspace_slug ? { workspaceSlug: row.workspace_slug } : {}),
    ...(row.actor_user_id ? { actorUserId: row.actor_user_id } : {}) } } };
}
