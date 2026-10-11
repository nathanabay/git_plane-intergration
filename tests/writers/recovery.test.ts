import test from "node:test";
import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { createOrderedOutbox, deliveryScope, OrderedWriteDeferredError, QueuedWriteFailedError } from "../../src/app/writers.ts";
import { database, queue, intentJob } from "./outbox-fixture.ts";

test("recovery is bounded to 100 rows but eventually recovers later missing wake-ups", async (t) => {
  const db = await database(t), planeQueue = queue();
  const outbox = createOrderedOutbox({ db,
    queues: { plane: planeQueue as any, github: queue() as any }, loadActorToken: async () => null,
    plane: { preflight: async () => {}, apply: async () => ({ ok: true }) }, github: { apply: async () => ({ ok: true }) } });
  for (let i = 0; i < 102; i++) await deliveryScope.run({ deliveryId: `d${i}` }, () =>
    outbox.plane.apply({ kind: "update_issue", slug: "ws", projectId: "p", issueId: `i${i}`, fields: { name: "name" } }));
  const ids = [...planeQueue.jobs.keys()];
  planeQueue.jobs.clear();
  await outbox.recover(); strictEqual(planeQueue.jobs.size, 100);
  await outbox.recover(); strictEqual(planeQueue.jobs.size, 102);
  deepStrictEqual([...planeQueue.jobs.keys()], ids);
  await outbox.recover(); strictEqual(planeQueue.jobs.size, 102);
});

test("retry budget belongs to the oldest intent, whose terminal failure permits the next write", async (t) => {
  const db = await database(t), planeQueue = queue();
  let clock = Date.now(), calls = 0;
  const outbox = createOrderedOutbox({ db, maxAttempts: 2, now: () => clock,
    queues: { plane: planeQueue as any, github: queue() as any }, loadActorToken: async () => null,
    plane: { preflight: async () => {}, apply: async (w) => {
      calls++;
      if (w.kind === "update_issue" && w.fields.name === "old") throw new Error("temporary outage");
      return { ok: true };
    } }, github: { apply: async () => ({ ok: true }) } });
  for (const name of ["old", "new"]) await deliveryScope.run({ deliveryId: name }, () =>
    outbox.plane.apply({ kind: "update_issue", slug: "ws", projectId: "p", issueId: "i", fields: { name } }));
  const ids = (await db.query<{ id: string }>("SELECT id FROM outbound_writes ORDER BY sequence")).rows;
  const staged = await Promise.all(ids.map((r) => intentJob(db, r.id)));
  const old = staged[0]!, newer = staged[1]!;
  await rejects(outbox.executePlane(old), OrderedWriteDeferredError);
  await rejects(outbox.executePlane(newer), OrderedWriteDeferredError);
  strictEqual(calls, 1);
  clock += 600_000;
  await rejects(outbox.executePlane(newer), OrderedWriteDeferredError);
  await outbox.executePlane(newer);
  await rejects(outbox.executePlane(old), QueuedWriteFailedError);
  strictEqual(calls, 3);
  deepStrictEqual((await db.query("SELECT status, attempts FROM outbound_writes ORDER BY sequence")).rows,
    [{ status: "failed", attempts: 2 }, { status: "applied", attempts: 0 }]);
  strictEqual((await db.query("SELECT 1 FROM audit_log WHERE kind = 'outbound_write_failed' AND delivery_id = 'old'")).rows.length, 1);
});

test("creates acknowledge registration while their worker result stays durable for retry deduplication", async (t) => {
  const db = await database(t), planeQueue = queue();
  let calls = 0;
  const outbox = createOrderedOutbox({ db,
    queues: { plane: planeQueue as any, github: queue() as any }, loadActorToken: async () => null,
    plane: { preflight: async () => {}, apply: async () => { calls++; return { ok: true, id: "created-1", sequenceId: 1 }; } },
    github: { apply: async () => ({ ok: true }) } });
  const run = () => deliveryScope.run({ deliveryId: "create" }, () => outbox.plane.apply({
    kind: "create_issue", slug: "ws", projectId: "p", fields: { name: "new" } }));
  await run(); strictEqual(calls, 0);
  await outbox.executePlane([...planeQueue.jobs.values()][0]);
  deepStrictEqual(await run(), { ok: true });
  deepStrictEqual((await db.query<{ result: unknown }>("SELECT result FROM outbound_writes")).rows[0]!.result, { ok: true, id: "created-1", sequenceId: 1 });
  strictEqual(calls, 1);
});

test("F11: the head's retry window expires without another API call and releases its successor", async (t) => {
  const db = await database(t), planeQueue = queue();
  let clock = Date.now(), calls = 0;
  const outbox = createOrderedOutbox({ db, now: () => clock, maxTargetBlockDurationMs: 100,
    queues: { plane: planeQueue as any, github: queue() as any }, loadActorToken: async () => null,
    plane: { preflight: async () => {}, apply: async (w) => { calls++; if (w.kind === "update_issue" && w.fields.name === "old") throw new Error("outage"); return { ok: true }; } },
    github: { apply: async () => ({ ok: true }) } });
  for (const name of ["old", "new"]) await deliveryScope.run({ deliveryId: name }, () => outbox.plane.apply({ kind: "update_issue", slug: "ws", projectId: "p", issueId: "i", fields: { name } }));
  const rows = (await db.query<{ id: string }>("SELECT id FROM outbound_writes ORDER BY sequence")).rows;
  strictEqual(planeQueue.jobs.size, 1);
  await rejects(outbox.executePlane(await intentJob(db, rows[0]!.id)), OrderedWriteDeferredError);
  clock += 101;
  await rejects(outbox.executePlane(await intentJob(db, rows[0]!.id)), QueuedWriteFailedError);
  strictEqual(calls, 1);
  strictEqual(planeQueue.jobs.size, 2);
  await outbox.executePlane(await intentJob(db, rows[1]!.id));
  strictEqual(calls, 2);
  strictEqual((await db.query("SELECT 1 FROM audit_log WHERE kind = 'outbound_write_failed'")).rows.length, 1);
});

test("F11: one failing create cannot block an unrelated create in the same project", async (t) => {
  const db = await database(t), planeQueue = queue();
  let created = 0;
  const outbox = createOrderedOutbox({ db, queues: { plane: planeQueue as any, github: queue() as any }, loadActorToken: async () => null,
    plane: { preflight: async () => {}, apply: async (w) => { if (w.kind === "create_issue" && w.fields.name === "old") throw new Error("outage"); created++; return { ok: true, id: "new" }; } },
    github: { apply: async () => ({ ok: true }) } });
  for (const name of ["old", "new"]) await deliveryScope.run({ deliveryId: name }, () => outbox.plane.apply({ kind: "create_issue", slug: "ws", projectId: "p", fields: { name } }));
  const rows = (await db.query<{ id: string; target_key: string }>("SELECT id, target_key FROM outbound_writes ORDER BY sequence")).rows;
  strictEqual(new Set(rows.map((r) => r.target_key)).size, 2);
  await rejects(outbox.executePlane(await intentJob(db, rows[0]!.id)), OrderedWriteDeferredError);
  await outbox.executePlane(await intentJob(db, rows[1]!.id));
  strictEqual(created, 1);
});
