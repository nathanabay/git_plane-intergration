#!/usr/bin/env node
// Oracle for task A3 (spec §5, §1.3, §7.6, §8, §9). Applies the migrations to a real Postgres
// engine (PGlite) and exercises the ledger contract later tasks depend on.
import { resolve, join } from "node:path";
import { strictEqual, deepStrictEqual, ok, rejects } from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";

const root = resolve(import.meta.dirname, "..");
const results = [];
async function check(name, fn, ms = 60000) {
  let timer;
  const limit = new Promise((_, no) => { timer = setTimeout(() => no(new Error(`timed out after ${ms}ms`)), ms); });
  try { await Promise.race([fn(), limit]); results.push([name, null]); console.log(`ok   ${name}`); }
  catch (e) { results.push([name, e]); console.error(`FAIL: ${name}: ${String(e?.message ?? e).split("\n")[0]}`); }
  finally { clearTimeout(timer); }
}

const { migrate } = await import(join(root, "src/db/migrate.ts"));
const L = await import(join(root, "src/db/ledgers.ts"));
const { PgTokenStore } = await import(join(root, "src/db/token-store.ts"));
const { TokenVault } = await import(join(root, "src/auth/identity.ts"));

const db = new PGlite();
await db.waitReady;
const cols = async (t) => (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [t])).rows.map((r) => r.column_name);

await check("migrations apply cleanly and are idempotent on re-run", async () => {
  const first = await migrate(db);
  ok(first.applied.length >= 1, "first run applied nothing");
  const second = await migrate(db);
  deepStrictEqual(second.applied, []);
});

await check("sync_links carries both identities, tier, created_by and orphan status (§5, §1.3)", async () => {
  const c = await cols("sync_links");
  for (const k of ["plane_workspace_slug", "plane_project_id", "plane_issue_id", "gh_repo_id", "gh_number", "gh_kind", "tier", "created_by", "status", "orphaned_at"]) ok(c.includes(k), `sync_links.${k} missing`);
});
await check("applied_ops is field-granular: op_hash, direction, created_at, and no whole-object payload column (§5)", async () => {
  const c = await cols("applied_ops");
  for (const k of ["op_hash", "direction", "created_at"]) ok(c.includes(k), `applied_ops.${k} missing`);
  ok(!c.some((x) => /payload|snapshot|fields|body/.test(x)), `applied_ops has a whole-object column: ${c.join(",")}`);
});
await check("configuration, identity and audit tables exist (§7.6, §8, §9)", async () => {
  const tables = (await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`)).rows.map((r) => r.table_name);
  for (const t of ["sync_links", "applied_ops", "webhook_deliveries", "processed_commits", "audit_log", "repo_mappings", "rule_sets", "conflict_policies", "user_map", "user_tokens", "instance_settings", "magic_words", "github_app_config", "schema_migrations"]) ok(tables.includes(t), `table ${t} missing`);
});
await check("CHECK constraints reject values outside the spec's vocabularies", async () => {
  const base = `INSERT INTO sync_links (plane_workspace_slug, plane_project_id, plane_issue_id, gh_repo_id, gh_number, gh_kind, tier, created_by) VALUES ('w','p','i',1,1,$1,$2,$3)`;
  await rejects(db.query(base, ["commit", "closing", "manual"]));
  await rejects(db.query(base, ["issue", "sometimes", "manual"]));
  await rejects(db.query(base, ["issue", "closing", "guess"]));
  await rejects(db.query(`INSERT INTO applied_ops (op_hash, direction) VALUES ('h', 'sideways')`));
  await rejects(db.query(`INSERT INTO conflict_policies (mapping_id, field, policy) VALUES (1, 'title', 'whoever_shouts')`));
});

await check("delivery ids are recorded once per source (§5)", async () => {
  strictEqual(await L.recordDelivery(db, "github", "d-1"), true);
  strictEqual(await L.recordDelivery(db, "github", "d-1"), false);
  strictEqual(await L.recordDelivery(db, "plane", "d-1"), true);
});
await check("commit commands are claimed once per SHA regardless of repository (§5: fork re-delivery)", async () => {
  strictEqual(await L.claimCommit(db, "a".repeat(40), 1), true);
  strictEqual(await L.claimCommit(db, "a".repeat(40), 2), false);
  strictEqual(await L.claimCommit(db, "b".repeat(40), 1), true);
});
await check("an applied op is consumed by exactly one matching echo (§5: N writes → N echoes)", async () => {
  await L.recordAppliedOps(db, [{ opHash: "h-state", direction: "to_plane" }, { opHash: "h-state", direction: "to_plane" }, { opHash: "h-title", direction: "to_plane" }]);
  strictEqual(await L.consumeRecentOp(db, "h-state", 10), true);
  strictEqual(await L.consumeRecentOp(db, "h-state", 10), true);
  strictEqual(await L.consumeRecentOp(db, "h-state", 10), false);
  strictEqual(await L.consumeRecentOp(db, "h-title", 10), true);
  strictEqual(await L.consumeRecentOp(db, "h-unknown", 10), false);
});
await check("ops older than the TTL never match and are pruned", async () => {
  await db.query(`INSERT INTO applied_ops (op_hash, direction, created_at) VALUES ('h-old', 'to_github', now() - interval '2 hours')`);
  strictEqual(await L.consumeRecentOp(db, "h-old", 30), false);
  await L.recordAppliedOps(db, [{ opHash: "h-fresh", direction: "to_github" }]);
  const pruned = await L.pruneAppliedOps(db, 30);
  ok(pruned >= 1, `pruned ${pruned}`);
  strictEqual((await db.query(`SELECT count(*)::int AS n FROM applied_ops WHERE op_hash = 'h-old'`)).rows[0].n, 0);
  strictEqual((await db.query(`SELECT count(*)::int AS n FROM applied_ops WHERE op_hash = 'h-fresh'`)).rows[0].n, 1);
});

await check("sync links upsert by identity, list active, and orphan without deleting (§1.3)", async () => {
  const link = { planeWorkspaceSlug: "qelal", planeProjectId: "p1", planeIssueId: "i1", ghRepoId: 42, ghNumber: 7, ghKind: "pr", tier: "closing", createdBy: "magic_word" };
  const id1 = await L.upsertSyncLink(db, link);
  const id2 = await L.upsertSyncLink(db, link);
  strictEqual(String(id1), String(id2));
  const active = await L.listActiveSyncLinks(db, { limit: 100 });
  ok(active.some((l) => String(l.id) === String(id1)));
  await L.markLinkOrphaned(db, id1);
  const row = (await db.query(`SELECT status, orphaned_at FROM sync_links WHERE id = $1`, [id1])).rows[0];
  strictEqual(row.status, "orphaned"); ok(row.orphaned_at);
  ok(!(await L.listActiveSyncLinks(db, { limit: 100 })).some((l) => String(l.id) === String(id1)));
});

await check("audit entries append and a replay references its original (§7.6)", async () => {
  const a = await L.appendAudit(db, { kind: "inbound_delivery", source: "github", deliveryId: "d-9", detail: { event: "push" }, outcome: "failed", error: "boom" });
  const b = await L.appendAudit(db, { kind: "inbound_delivery", source: "github", deliveryId: "d-9", detail: { event: "push" }, outcome: "ok", replayOf: a });
  const row = (await db.query(`SELECT replay_of FROM audit_log WHERE id = $1`, [b])).rows[0];
  strictEqual(String(row.replay_of), String(a));
  await rejects(L.appendAudit(db, { kind: "inbound_delivery", source: "github", outcome: "ok", replayOf: 999999 }));
});

await check("PgTokenStore persists only ciphertext and revocation removes every kind (§9)", async () => {
  const vault = new TokenVault(new PgTokenStore(db), Buffer.alloc(32, 7));
  await vault.store("u1", "plane_pat", "plane_api_TOPSECRET");
  await vault.store("u1", "github_oauth", "gho_TOPSECRET");
  const raw = (await db.query(`SELECT * FROM user_tokens`)).rows;
  ok(raw.length === 2 && !JSON.stringify(raw).includes("TOPSECRET"), "plaintext reached the database");
  strictEqual((await vault.load("u1", "plane_pat")).reveal(), "plane_api_TOPSECRET");
  strictEqual(await vault.revoke("u1"), true);
  strictEqual(await vault.load("u1", "github_oauth"), null);
  strictEqual(await vault.revoke("u1"), false);
});

await check("spec defaults and keys: autolinks off by default (§7.4), GHE base URL stored (§8), one policy per field, one word list per tier, one row per rule version", async () => {
  const def = (await db.query(`SELECT column_name, column_default FROM information_schema.columns WHERE table_name = 'repo_mappings' AND column_name = 'autolinks_enabled'`)).rows[0];
  ok(def && /false/i.test(String(def.column_default)), `autolinks_enabled default is ${def?.column_default}`);
  ok((await cols("github_app_config")).includes("ghe_base_url"), "github_app_config.ghe_base_url missing");
  const m = (await db.query(`INSERT INTO repo_mappings (workspace_slug, gh_repo_id, gh_repo_full_name, plane_project_id, sync_direction) VALUES ('w', 1, 'o/r', 'p', 'bidirectional') RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO conflict_policies (mapping_id, field, policy) VALUES ($1, 'title', 'last_write_wins')`, [m]);
  await rejects(db.query(`INSERT INTO conflict_policies (mapping_id, field, policy) VALUES ($1, 'title', 'source_of_truth:plane')`, [m]));
  await db.query(`INSERT INTO rule_sets (mapping_id, yaml_source, version) VALUES ($1, '[]', 1)`, [m]);
  await rejects(db.query(`INSERT INTO rule_sets (mapping_id, yaml_source, version) VALUES ($1, '[]', 1)`, [m]));
  await db.query(`INSERT INTO magic_words (tier, words) VALUES ('closing', ARRAY['fixes'])`);
  await rejects(db.query(`INSERT INTO magic_words (tier, words) VALUES ('closing', ARRAY['closes'])`));
  await db.query(`DELETE FROM repo_mappings WHERE id = $1`, [m]);
  strictEqual((await db.query(`SELECT count(*)::int AS n FROM rule_sets WHERE mapping_id = $1`, [m])).rows[0].n, 0, "deleting a mapping must cascade to its rules and policies");
});

await db.close();

// ---- real Postgres 15.7 over a pg Pool: what PGlite's single connection cannot show ----------
const { startPostgres } = await import("./lib/postgres.mjs");
const { createDb } = await import(join(root, "src/db/client.ts"));
const { mkdtempSync, writeFileSync, copyFileSync, readdirSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const pgs = await startPostgres();
try {
  await check("on a pg Pool, a failing migration rolls back completely and is not recorded", async () => {
    const real = createDb(pgs.url);
    try {
      const dir = mkdtempSync(join(tmpdir(), "gitsync-mig-"));
      for (const f of readdirSync(join(root, "src/db/migrations"))) copyFileSync(join(root, "src/db/migrations", f), join(dir, f));
      writeFileSync(join(dir, "999-broken.sql"), "CREATE TABLE oracle_half_done (id int);\nINSERT INTO oracle_half_done VALUES (1);\nSELECT 1/0;\n");
      await rejects(migrate(real, { dir }));
      const t = (await real.query(`SELECT to_regclass('public.oracle_half_done') AS t`)).rows[0].t;
      strictEqual(t, null, "the failed migration's table survived: migrations are not atomic");
      strictEqual((await real.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE version = '999-broken.sql'`)).rows[0].n, 0);
      ok((await real.query(`SELECT count(*)::int AS n FROM schema_migrations`)).rows[0].n >= 1, "the good migrations were not applied");
      rmSync(dir, { recursive: true, force: true });
    } finally { await real.close(); }
  });
  await check("two replicas migrating at once both succeed and apply each migration exactly once", async () => {
    const pg2 = await startPostgres();
    const a = createDb(pg2.url), b = createDb(pg2.url);
    try {
      const [ra, rb] = await Promise.all([migrate(a), migrate(b)]);
      strictEqual(ra.applied.length + rb.applied.length, readdirSync(join(root, "src/db/migrations")).filter((f) => f.endsWith(".sql")).length);
    } finally { await a.close(); await b.close(); await pg2.stop(); }
  }, 120000);
  await check("concurrent echo consumption is exact: two recorded ops are consumed by two concurrent echoes, never fewer", async () => {
    const real = createDb(pgs.url);
    try {
      for (let i = 0; i < 25; i++) {
        const h = `race-${i}`;
        await L.recordAppliedOps(real, [{ opHash: h, direction: "to_plane" }, { opHash: h, direction: "to_plane" }]);
        const got = await Promise.all([L.consumeRecentOp(real, h, 10), L.consumeRecentOp(real, h, 10), L.consumeRecentOp(real, h, 10)]);
        deepStrictEqual(got.filter(Boolean).length, 2, `round ${i}: ${got}`);
      }
    } finally { await real.close(); }
  }, 120000);
} finally { await pgs.stop(); }
let bad = 0;
for (const [, err] of results) if (err) bad++;
if (bad) process.exit(1);
console.log(`A3 schema verification passed (${results.length} checks)`);
process.exit(0); // lingering client sockets must not keep a passed oracle alive