import test from "node:test";
import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { createOrderedOutbox } from "../../src/app/writers.ts";
import { inboundHandler } from "../../src/app/reducers.ts";
import { EventRouter } from "../../src/sync/router.ts";
import { appendAudit } from "../../src/db/ledgers.ts";
import { replayDelivery } from "../../src/operations/tooling.ts";
import type { InboundJob } from "../../src/queue/index.ts";
import { database, queue, intentJob } from "../writers/outbox-fixture.ts";

test("F1: replay and replay-of-replay retain original write identity without duplicating an earlier comment", async (t) => {
  const db = await database(t), planeQueue = queue(), applied: string[] = [];
  const outbox = createOrderedOutbox({ db, queues: { plane: planeQueue as any, github: queue() as any }, loadActorToken: async () => null,
    plane: { preflight: async () => {}, apply: async (w) => { if (w.kind === "add_comment") applied.push(w.commentHtml); return { ok: true }; } },
    github: { apply: async () => ({ ok: true }) } });
  let fail = true;
  const router = new EventRouter();
  router.on("github", "issues", async () => {
    await outbox.plane.apply({ kind: "add_comment", slug: "ws", projectId: "p", issueId: "i", commentHtml: "first" });
    if (fail) { fail = false; throw new Error("interrupted reducer" ); }
    await outbox.plane.apply({ kind: "add_comment", slug: "ws", projectId: "p", issueId: "i", commentHtml: "second" });
  });
  const handler = inboundHandler({ db } as any, router, "github");
  const original: InboundJob = { source: "github", deliveryId: "original", event: "issues", receivedAt: new Date().toISOString(), payload: {} };
  await rejects(handler(original), /interrupted/);
  let auditId = await appendAudit(db, { kind: "inbound_delivery", source: "github", deliveryId: "original", outcome: "failed", detail: { event: "issues", payload: {} } });
  for (let i = 0; i < 2; i++) {
    let replay!: InboundJob;
    await replayDelivery({ db, enqueue: async (job) => { replay = job; }, now: () => new Date(1000 + i) }, auditId);
    strictEqual(replay.writeDeliveryId, "original");
    await handler(replay);
    auditId = await appendAudit(db, { kind: "inbound_delivery", source: "github", deliveryId: replay.deliveryId,
      outcome: "handled", detail: { event: replay.event, payload: replay.payload, writeDeliveryId: replay.writeDeliveryId } });
  }
  const rows = (await db.query<{ id: string }>("SELECT id FROM outbound_writes ORDER BY sequence")).rows;
  strictEqual(rows.length, 2);
  for (const row of rows) await outbox.executePlane(await intentJob(db, row.id));
  deepStrictEqual(applied, ["first", "second"]);
});
