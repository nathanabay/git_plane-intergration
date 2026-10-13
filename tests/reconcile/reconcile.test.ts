import test from "node:test";
import { strictEqual, deepStrictEqual, ok } from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../../src/db/migrate.ts";
import { appendAudit, recordAppliedOps, upsertSyncLink, readRetention, pruneLedgers, recordDelivery, claimCommit } from "../../src/db/ledgers.ts";
import { pruneExpiredOps, reconcileOnce } from "../../src/sync/reconcile.ts";
import { PlaneApiError } from "../../src/sync/plane.ts";

// A 404 is orphaned at once only when Plane's activities show a delete (A2); 200 is visible; other statuses fail.
const deletedActivity = [{ verb: "deleted", field: "issue", created_at: "2026-10-01T00:00:00Z" }];
async function setup(statuses: Record<string, number>) {
  const db = new PGlite(); await db.waitReady; await migrate(db);
  const calls: string[] = [];
  const plane = {
    getIssue: async (_s: string, _p: string, id: string) => {
      calls.push(id);
      const st = statuses[id] ?? 200;
      if (st !== 200) throw new PlaneApiError(st, {}, "x");
      return { id };
    },
    listIssueIds: async () => {
      const ids = Object.keys(statuses).filter((id) => statuses[id] === 200);
      calls.push(...ids);
      return { ids, complete: true, totalPages: 1 };
    },
    getProject: async () => ({ id: "p", archived_at: null }),
    listIssueActivities: async () => deletedActivity,
  } as any;
  for (const id of Object.keys(statuses)) await upsertSyncLink(db, { planeWorkspaceSlug: "ws", planeProjectId: "p", planeIssueId: id, ghRepoId: 1, ghNumber: Number(id.slice(1)), ghKind: "issue", tier: "closing", createdBy: "manual" });
  return { db, plane, calls };
}
const link = (db: PGlite, id: string) => db.query<any>("SELECT status, last_checked_at, orphaned_at FROM sync_links WHERE plane_issue_id = $1", [id]).then((r) => r.rows[0]);

test("reconcile: a deleted item's 404 orphans with audit and callback; 200 stamps; 500 is counted and leaves the link active", async () => {
  const { db, plane } = await setup({ i1: 200, i2: 404, i3: 500 });
  const orphans: unknown[] = [];
  const r = await reconcileOnce({ db, plane, onOrphan: async (l) => { orphans.push(l.plane_issue_id); } });
  deepStrictEqual(r, { checked: 3, orphaned: 1, archived: 0, errors: 1 });
  strictEqual((await link(db, "i2")).status, "orphaned"); ok((await link(db, "i2")).orphaned_at);
  ok((await link(db, "i1")).last_checked_at); strictEqual((await link(db, "i3")).last_checked_at, null);
  deepStrictEqual(orphans, ["i2"]);
  const a = (await db.query<any>("SELECT kind, workspace_slug, detail FROM audit_log WHERE kind LIKE '%orphan%'")).rows;
  strictEqual(a.length, 1); strictEqual(a[0].workspace_slug, "ws"); strictEqual(a[0].detail.planeIssueId, "i2");
});
test("reconcile: pages through every active link with a small batch", async () => {
  const s: Record<string, number> = {}; for (let i = 1; i <= 7; i++) s[`i${i}`] = 200;
  const { db, plane, calls } = await setup(s);
  const r = await reconcileOnce({ db, plane, batchSize: 3 });
  strictEqual(r.checked, 7); strictEqual(new Set(calls).size, 7);
});
test("reconcile: an orphaned link is not checked again, and the sweep survives a failing callback", async () => {
  const { db, plane, calls } = await setup({ i1: 404 });
  const r1 = await reconcileOnce({ db, plane, onOrphan: async () => { throw new Error("github down"); } });
  deepStrictEqual(r1, { checked: 1, orphaned: 1, archived: 0, errors: 1 });
  calls.length = 0;
  deepStrictEqual(await reconcileOnce({ db, plane }), { checked: 0, orphaned: 0, archived: 0, errors: 0 });
  strictEqual(calls.length, 0);
});
test("reconcile: only GETs the Plane issue — no write method is even available to it", async () => {
  const { db, calls } = await setup({ i1: 404 });
  const plane = { // reads only: no request(), no write path
    getIssue: async (_s: string, _p: string, id: string) => { calls.push(id); throw new PlaneApiError(404, {}, "x"); },
    getProject: async () => ({ id: "p", archived_at: null }),
    listIssueActivities: async () => deletedActivity,
    listIssueIds: async () => ({ ids: [], complete: true }),
  } as any;
  strictEqual((await reconcileOnce({ db, plane })).orphaned, 1);
});
test("pruneExpiredOps removes only ops past the TTL", async () => {
  const { db } = await setup({});
  await recordAppliedOps(db, [{ opHash: "fresh", direction: "to_plane" }]);
  await db.query("INSERT INTO applied_ops (op_hash, direction, created_at) VALUES ('old', 'to_plane', now() - interval '2 hours')");
  strictEqual(await pruneExpiredOps({ db, ttlMinutes: 30 }), 1);
  strictEqual((await db.query("SELECT 1 FROM applied_ops WHERE op_hash = 'fresh'")).rows.length, 1);
  await appendAudit(db, { kind: "x", outcome: "ok" });
});

test("F17: readRetention returns default settings and respects instance_settings updates", async () => {
  const { db } = await setup({});
  const def = await readRetention(db);
  deepStrictEqual(def, { deliveryDays: 30, commitDays: 180, auditPayloadDays: 90, outboundDays: 30 });

  await db.query(`
    INSERT INTO instance_settings (id, delivery_retention_days, commit_retention_days, audit_payload_retention_days, outbound_retention_days)
    VALUES (1, 14, 60, 45, 14)
    ON CONFLICT (id) DO UPDATE SET
      delivery_retention_days = EXCLUDED.delivery_retention_days,
      commit_retention_days = EXCLUDED.commit_retention_days,
      audit_payload_retention_days = EXCLUDED.audit_payload_retention_days,
      outbound_retention_days = EXCLUDED.outbound_retention_days
  `);
  const custom = await readRetention(db);
  deepStrictEqual(custom, { deliveryDays: 14, commitDays: 60, auditPayloadDays: 45, outboundDays: 14 });
});

test("F17: pruneLedgers prunes webhook_deliveries, processed_commits, and strips audit_log payload", async () => {
  const { db } = await setup({});
  const retention = { deliveryDays: 30, commitDays: 180, auditPayloadDays: 90 };

  // Deliveries: one fresh, one expired (> 30 days)
  await recordDelivery(db, "github", "del-fresh");
  await db.query("INSERT INTO webhook_deliveries (source, delivery_id, received_at) VALUES ('plane', 'del-old', now() - interval '35 days')");

  // Commits: one fresh, one expired (> 180 days)
  await claimCommit(db, "sha-fresh", 1, "ws-1");
  await db.query("INSERT INTO processed_commits (sha, repo_id, workspace_slug, processed_at) VALUES ('sha-old', 1, 'ws-1', now() - interval '200 days')");

  // Audit log: one fresh with payload, one old with payload (> 90 days), one old without payload
  const freshAuditId = await appendAudit(db, { kind: "push", outcome: "ok", detail: { payload: { commit: "abc" }, count: 1 } });
  const oldAuditId = await appendAudit(db, { kind: "push", outcome: "ok", detail: { payload: { commit: "xyz" }, count: 2 } });
  await db.query("UPDATE audit_log SET created_at = now() - interval '100 days' WHERE id = $1", [oldAuditId]);
  const noPayloadAuditId = await appendAudit(db, { kind: "reconcile", outcome: "ok", detail: { count: 3 } });
  await db.query("UPDATE audit_log SET created_at = now() - interval '100 days' WHERE id = $1", [noPayloadAuditId]);

  const pruned = await pruneLedgers(db, retention);
  deepStrictEqual(pruned, { deliveries: 1, commits: 1, auditPayloads: 1, outboundWrites: 0 });

  // Webhook deliveries verification
  const deliveries = (await db.query<{ delivery_id: string }>("SELECT delivery_id FROM webhook_deliveries")).rows.map((r) => r.delivery_id);
  deepStrictEqual(deliveries, ["del-fresh"]);

  // Processed commits verification
  const commits = (await db.query<{ sha: string }>("SELECT sha FROM processed_commits")).rows.map((r) => r.sha);
  deepStrictEqual(commits, ["sha-fresh"]);

  // Audit log verification
  const freshRow = (await db.query<{ detail: any }>("SELECT detail FROM audit_log WHERE id = $1", [freshAuditId])).rows[0];
  ok(freshRow?.detail.payload, "fresh audit entry should keep its payload");

  const oldRow = (await db.query<{ detail: any }>("SELECT detail FROM audit_log WHERE id = $1", [oldAuditId])).rows[0];
  strictEqual(oldRow?.detail.payload, undefined, "old audit entry should have payload stripped");
  strictEqual(oldRow?.detail.count, 2, "old audit entry non-payload fields should remain");
});

