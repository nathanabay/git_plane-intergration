import test from "node:test";
import { ok } from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../../src/db/migrate.ts";

test("F6: the production migrations provide the durable outbound intent table", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.waitReady;
  await migrate(db);
  const columns = (await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
    WHERE table_name = 'outbound_writes' AND table_schema = 'public'`)).rows.map((r) => r.column_name);
  for (const name of ["id", "sequence", "side", "target_key", "delivery_id", "workspace_slug", "actor_user_id",
    "write", "status", "attempts", "retry_at", "result", "error", "created_at", "updated_at"])
    ok(columns.includes(name), `production migration does not provide outbound_writes.${name}`);
});
