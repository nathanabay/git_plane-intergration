import test from "node:test";
import { strictEqual, ok, rejects } from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../../src/db/migrate.ts";
import type { Db } from "../../src/db/migrate.ts";
import { consumeRecentOp, recordAppliedOps } from "../../src/db/ledgers.ts";
import { createDb } from "../../src/db/client.ts";
import { startPostgres } from "../../scripts/lib/postgres.mjs";

async function fresh() { const db = new PGlite(); await db.waitReady; await migrate(db); return db; }

test("migrate: a failing migration leaves nothing behind and is not recorded", async () => {
  const db = new PGlite();
  await db.waitReady;
  const dir = mkdtempSync(join(tmpdir(), "mig-"));
  try {
    writeFileSync(join(dir, "001-ok.sql"), "CREATE TABLE a (id int);");
    writeFileSync(join(dir, "002-bad.sql"), "CREATE TABLE b (id int); SELECT 1/0;");
    await rejects(migrate(db, { dir }));
    const t = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM information_schema.tables WHERE table_name = 'b'");
    strictEqual(t.rows[0]?.n, "0");
    const v = await db.query("SELECT version FROM schema_migrations");
    strictEqual(v.rows.length, 1);
    writeFileSync(join(dir, "002-bad.sql"), "CREATE TABLE b (id int);");
    const again = await migrate(db, { dir });
    strictEqual(again.applied.join(), "002-bad.sql");
  } finally { rmSync(dir, { recursive: true, force: true }); await db.close(); }
});

test("migrate: uses withConnection when the Db offers it, one connection for the whole transaction", async () => {
  const inner = new PGlite();
  await inner.waitReady;
  let opened = 0;
  const db: Db = {
    query: (t, p) => inner.query(t, p as any[]) as any,
    exec: (s) => inner.exec(s),
    withConnection: async (fn) => { opened++; return fn(db); },
  };
  const { applied } = await migrate(db);
  ok(applied.length >= 1);
  strictEqual(opened, applied.length);
  await inner.close();
});

test("schema: spec defaults, GHE url, uniqueness and cascade", async () => {
  const db = await fresh();
  await db.query(`INSERT INTO repo_mappings (workspace_slug, gh_repo_id, gh_repo_full_name, plane_project_id, sync_direction) VALUES ('w',1,'o/r','p','bidirectional')`);
  const m = await db.query<{ id: number; autolinks_enabled: boolean }>("SELECT id, autolinks_enabled FROM repo_mappings");
  strictEqual(m.rows[0]?.autolinks_enabled, false);
  const id = m.rows[0]!.id;
  await db.query(`INSERT INTO github_app_config (app_id, private_key_v1, webhook_secret_v1, ghe_base_url) VALUES (1,'v1:a','v1:b','https://ghe.example/api/v3')`);
  await db.query(`INSERT INTO conflict_policies (mapping_id, field, policy) VALUES ($1,'title','last_write_wins')`, [id]);
  await rejects(db.query(`INSERT INTO conflict_policies (mapping_id, field, policy) VALUES ($1,'title','last_write_wins')`, [id]));
  await db.query(`INSERT INTO rule_sets (mapping_id, yaml_source, version) VALUES ($1,'x',1)`, [id]);
  await rejects(db.query(`INSERT INTO rule_sets (mapping_id, yaml_source, version) VALUES ($1,'y',1)`, [id]));
  await db.query(`INSERT INTO magic_words (tier, words) VALUES ('closing','{fixes}')`);
  await rejects(db.query(`INSERT INTO magic_words (tier, words) VALUES ('closing','{closes}')`));
  await db.query("DELETE FROM repo_mappings WHERE id = $1", [id]);
  strictEqual((await db.query("SELECT 1 FROM rule_sets")).rows.length, 0);
  strictEqual((await db.query("SELECT 1 FROM conflict_policies")).rows.length, 0);
  await db.close();
});

test("postgres pool: failed migration is atomic, concurrent runners apply once, echoes consumed exactly once", async () => {
  const pg = await startPostgres();
  const dbs: (Db & { close(): Promise<void> })[] = [];
  const open = () => { const d = createDb(pg.url); dbs.push(d); return d; };
  const dir = mkdtempSync(join(tmpdir(), "mig-"));
  try {
    const real = open();
    writeFileSync(join(dir, "001-ok.sql"), "CREATE TABLE ok_t (id int);");
    writeFileSync(join(dir, "002-bad.sql"), "CREATE TABLE half (id int); INSERT INTO half VALUES (1); SELECT 1/0;");
    await rejects(migrate(real, { dir }));
    strictEqual((await real.query("SELECT to_regclass('half')::text AS r")).rows[0].r, null);
    strictEqual((await real.query("SELECT version FROM schema_migrations")).rows.length, 1);
    const idle = await real.query<{ n: string }>("SELECT count(*)::text AS n FROM pg_stat_activity WHERE state = 'idle in transaction'");
    strictEqual(idle.rows[0]?.n, "0");

    const a = open(), b = open(), c = open();
    const [ra, rb] = await Promise.all([migrate(a), migrate(b)]);
    ok(ra.applied.length + rb.applied.length >= 1);
    strictEqual(new Set([...ra.applied, ...rb.applied]).size, ra.applied.length + rb.applied.length);

    await recordAppliedOps(real, [{ opHash: "h", direction: "to_plane" }, { opHash: "h", direction: "to_plane" }]);
    const got = await Promise.all([consumeRecentOp(a, "h", 10), consumeRecentOp(b, "h", 10), consumeRecentOp(c, "h", 10)]);
    strictEqual(got.filter(Boolean).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    for (const d of dbs) await d.close();
    await pg.stop();
  }
});
