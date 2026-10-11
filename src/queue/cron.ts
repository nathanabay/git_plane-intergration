import { Queue, Worker } from "bullmq";
import { pruneLedgers, readRetention } from "../db/ledgers.ts";
import type { Db } from "../db/migrate.ts";
import type { SyncLinkRow } from "../db/schema.ts";
import { pruneExpiredOps, reconcileOnce } from "../sync/reconcile.ts";
import type { PlaneClient } from "../sync/plane.ts";
import { MAINTENANCE_QUEUE } from "./index.ts";

const DEFAULTS = { reconciliationMinutes: 60, opTtlMinutes: 10 };
const PRUNE_EVERY_MS = 10 * 60_000;
const RETENTION_EVERY_MS = 60 * 60_000;

async function readSettings(db: Db): Promise<{ reconciliationMinutes: number; opTtlMinutes: number }> {
  const res = await db.query<{ reconciliation_interval_minutes: number; op_ttl_minutes: number }>("SELECT reconciliation_interval_minutes, op_ttl_minutes FROM instance_settings WHERE id = 1");
  const row = res.rows[0];
  return {
    reconciliationMinutes: Math.max(1, row?.reconciliation_interval_minutes ?? DEFAULTS.reconciliationMinutes),
    opTtlMinutes: Math.max(1, row?.op_ttl_minutes ?? DEFAULTS.opTtlMinutes),
  };
}

/**
 * Two repeatable jobs on the `maintenance` queue, driven by BullMQ job schedulers so several replicas
 * share one schedule: `reconcile` (interval from instance_settings) and `prune-ops` (TTL from the same
 * table). Settings are read on each run; a changed interval re-registers the scheduler.
 */
export function startMaintenance(opts: { connectionUrl: string; prefix: string; db: Db; plane: PlaneClient; onOrphan?(link: SyncLinkRow): Promise<void> }): { close(): Promise<void> } {
  const connection = { url: opts.connectionUrl };
  const queue = new Queue(MAINTENANCE_QUEUE, { connection, prefix: opts.prefix });
  let registeredMinutes = 0;
  let closed = false;

  const registerReconcile = async (minutes: number) => {
    if (minutes === registeredMinutes) return;
    await queue.upsertJobScheduler("reconcile", { every: minutes * 60_000 }, { name: "reconcile", opts: { removeOnComplete: true, removeOnFail: { count: 20 } } });
    registeredMinutes = minutes;
  };

  const worker = new Worker(MAINTENANCE_QUEUE, async (job) => {
    const settings = await readSettings(opts.db);
    if (job.name === "reconcile") {
      const result = await reconcileOnce({ db: opts.db, plane: opts.plane, ...(opts.onOrphan ? { onOrphan: opts.onOrphan } : {}) });
      await registerReconcile(settings.reconciliationMinutes);
      return result;
    }
    if (job.name === "prune-ops") return pruneExpiredOps({ db: opts.db, ttlMinutes: settings.opTtlMinutes });
    // F17: deliveries, processed commits and old audit payloads would otherwise grow without bound.
    if (job.name === "prune-ledgers") return pruneLedgers(opts.db, await readRetention(opts.db));
    return undefined;
  }, { connection, prefix: opts.prefix, concurrency: 1 });
  worker.on("error", (err) => console.error(`maintenance worker error: ${err.message}`));
  worker.on("failed", (job, err) => console.error(`maintenance job ${job?.name ?? "?"} failed: ${err.message}`));

  const ready = (async () => {
    const settings = await readSettings(opts.db);
    if (closed) return;
    await registerReconcile(settings.reconciliationMinutes);
    await queue.upsertJobScheduler("prune-ops", { every: PRUNE_EVERY_MS }, { name: "prune-ops", opts: { removeOnComplete: true, removeOnFail: { count: 20 } } });
    await queue.upsertJobScheduler("prune-ledgers", { every: RETENTION_EVERY_MS }, { name: "prune-ledgers", opts: { removeOnComplete: true, removeOnFail: { count: 20 } } });
  })().catch((err) => console.error(`maintenance scheduling failed: ${err instanceof Error ? err.message : "unknown error"}`));

  return {
    close: async () => {
      closed = true;
      await ready;
      await worker.close();
      await queue.close();
    },
  };
}
