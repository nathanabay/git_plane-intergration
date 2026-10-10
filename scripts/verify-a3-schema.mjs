#!/usr/bin/env node
// Oracle for task A3 (spec §5, §1.3, §7.6, §8, §9). Applies the migrations to a real Postgres
// engine (PGlite) and exercises the ledger contract later tasks depend on.
import { resolve, join } from "node:path";
import { strictEqual, deepStrictEqual, ok, rejects } from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";

const root = resolve(import.meta.dirname, "..");
const results = [];
async function check(name, fn) { try { await fn(); results.push([name, null]); } catch (e) { results.push([name, e]); } }

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

await db.close();
let bad = 0;
for (const [name, err] of results) { if (err) { bad++; console.error(`FAIL: ${name}: ${String(err.message).split("\n")[0]}`); } else console.log(`ok   ${name}`); }
if (bad) process.exit(1);
console.log(`A3 schema verification passed (${results.length} checks)`);
