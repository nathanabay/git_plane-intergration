import test from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import { Queue } from "bullmq";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../../src/db/migrate.ts";
import { upsertSyncLink } from "../../src/db/ledgers.ts";
import { startMaintenance } from "../../src/queue/cron.ts";
import { MAINTENANCE_QUEUE, QUEUE_NAMES } from "../../src/queue/index.ts";
import { PlaneApiError } from "../../src/sync/plane.ts";
import { startValkey } from "../../scripts/lib/valkey.mjs";

const until = async (f: () => boolean | Promise<boolean>) => { for (let i = 0; i < 160 && !(await f()); i++) await new Promise((r) => setTimeout(r, 50)); };

test("maintenance: the queue is separate from the four webhook queues", () => {
  strictEqual(MAINTENANCE_QUEUE, "maintenance");
  ok(!Object.values(QUEUE_NAMES).includes("maintenance" as never));
});

test("maintenance: schedulers are registered from instance_settings and the first run reconciles and prunes", async () => {
  const vk = await startValkey();
  const db = new PGlite(); await db.waitReady; await migrate(db);
  await db.query("INSERT INTO instance_settings (id, reconciliation_interval_minutes, op_ttl_minutes) VALUES (1, 1, 5)");
  await db.query("INSERT INTO applied_ops (op_hash, direction, created_at) VALUES ('old', 'to_plane', now() - interval '1 hour')");
  await upsertSyncLink(db, { planeWorkspaceSlug: "w", planeProjectId: "p", planeIssueId: "gone", ghRepoId: 1, ghNumber: 1, ghKind: "issue", tier: "closing", createdBy: "manual" });
  const plane = {
    getIssue: async () => { throw new PlaneApiError(404, {}, "nf"); },
    getProject: async () => ({ id: "p", archived_at: null }),
    // A2: the item's activities show it was deleted, so the first sweep orphans it.
    listIssueActivities: async () => [{ verb: "deleted", field: "issue", created_at: "2026-10-01T00:00:00Z" }],
    listIssueIds: async () => ({ ids: [], complete: true }),
    latestIssueUpdate: async () => null,
  } as any;
  const m = startMaintenance({ connectionUrl: vk.url, prefix: "m1", db, plane });
  const q = new Queue(MAINTENANCE_QUEUE, { connection: { url: vk.url }, prefix: "m1" });
  try {
    await until(async () => (await q.getJobSchedulers()).length === 4);
    const sch = await q.getJobSchedulers();
    strictEqual(sch.find((s) => s.key === "reconcile")?.every, 60_000);
    // C1/C2: expired and consumed connect/OAuth states are pruned hourly.
    strictEqual(sch.find((s) => s.key === "prune-oauth-states")?.every, 60 * 60_000);
    await until(async () => (await db.query<any>("SELECT status FROM sync_links")).rows[0].status === "orphaned");
    strictEqual((await db.query<any>("SELECT status FROM sync_links")).rows[0].status, "orphaned");
  } finally { await q.close(); await m.close(); await db.close(); await vk.stop(); }
});

test("maintenance: with no settings row the defaults apply, and close() is clean", async () => {
  const vk = await startValkey();
  const db = new PGlite(); await db.waitReady; await migrate(db);
  const m = startMaintenance({ connectionUrl: vk.url, prefix: "m2", db, plane: {} as any });
  const q = new Queue(MAINTENANCE_QUEUE, { connection: { url: vk.url }, prefix: "m2" });
  try {
    await until(async () => (await q.getJobSchedulers()).length === 4);
    strictEqual((await q.getJobSchedulers()).find((s) => s.key === "reconcile")?.every, 60 * 60_000);
  } finally { await q.close(); await m.close(); await db.close(); await vk.stop(); }
});
