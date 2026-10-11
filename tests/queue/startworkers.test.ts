import test from "node:test";
import { deepStrictEqual, ok } from "node:assert/strict";
import { Queue } from "bullmq";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../../src/db/migrate.ts";
import { startWorkers } from "../../src/queue/workers.ts";
import { createQueues } from "../../src/queue/index.ts";
import { startValkey } from "../../scripts/lib/valkey.mjs";

const until = async (f: () => boolean) => { for (let i = 0; i < 120 && !f(); i++) await new Promise((r) => setTimeout(r, 50)); };

test("workers: every queue is consumed — inbound to handlers, outbound to the write paths", async () => {
  const vk = await startValkey();
  const db = new PGlite(); await db.waitReady; await migrate(db);
  const seen: string[] = [];
  const plane = { apply: async (w: any) => { seen.push("plane:" + w.kind); } } as any;
  const github = { apply: async (w: any) => { seen.push("github:" + w.kind); } } as any;
  const w = startWorkers({ connectionUrl: vk.url, prefix: "t", plane, github, inbound: { db, opTtlMinutes: 5, onPlaneEvent: async () => { seen.push("in:plane"); }, onGithubEvent: async () => { seen.push("in:github"); } } });
  const q = createQueues({ connectionUrl: vk.url, prefix: "t" });
  try {
    await q.enqueueInbound({ source: "plane", deliveryId: "a", event: "issue", receivedAt: "", payload: { data: { id: "i" }, activity: { field: "name", new_value: "x", actor: { id: "h" } } } });
    await q.enqueueInbound({ source: "github", deliveryId: "b", event: "push", receivedAt: "", payload: {} });
    await q.outboundPlane.add("w", { kind: "add_comment" });
    await q.outboundGithub.add("w", { kind: "comment" });
    await until(() => seen.length >= 4);
    deepStrictEqual([...seen].sort(), ["github:comment", "in:github", "in:plane", "plane:add_comment"]);
  } finally { await w.close(); await q.close(); await db.close(); await vk.stop(); }
});

test("queues: jobs retry with backoff and keep completed ids for dedupe", async () => {
  const vk = await startValkey();
  const q = createQueues({ connectionUrl: vk.url, prefix: "t2" });
  try {
    const j = await q.outboundPlane.add("w", {});
    ok((j.opts.attempts ?? 0) >= 3);
    ok(j.opts.backoff);
    ok(j.opts.removeOnComplete && typeof j.opts.removeOnComplete === "object");
  } finally { await q.close(); await vk.stop(); }
});

test("workers: a failing outbound job is retried, not lost", async () => {
  const vk = await startValkey();
  const db = new PGlite(); await db.waitReady; await migrate(db);
  let tries = 0;
  const plane = { apply: async () => { tries++; if (tries < 2) throw new Error("flaky"); } } as any;
  const w = startWorkers({ connectionUrl: vk.url, prefix: "t3", plane, github: {} as any, inbound: { db, opTtlMinutes: 5, onPlaneEvent: async () => {}, onGithubEvent: async () => {} } });
  const out = new Queue("outbound-plane", { connection: { url: vk.url }, prefix: "t3" });
  try {
    await out.add("w", {}, { attempts: 3, backoff: { type: "fixed", delay: 50 } });
    await until(() => tries >= 2);
    ok(tries >= 2);
  } finally { await out.close(); await w.close(); await db.close(); await vk.stop(); }
});
