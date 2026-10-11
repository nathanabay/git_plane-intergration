import test from "node:test";
import { strictEqual, deepStrictEqual, rejects } from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../../src/db/migrate.ts";
import { processInbound, isPermanentWriteError, CreateInFlightError } from "../../src/queue/workers.ts";
import type { InboundDeps } from "../../src/queue/workers.ts";
import type { InboundJob } from "../../src/queue/index.ts";
import { consumeRecentOp, forgetAppliedOps, recordAppliedOps } from "../../src/db/ledgers.ts";
import { opHash } from "../../src/sync/ophash.ts";
import { UnknownPlaneState, pendingCreateHash } from "../../src/sync/plane.ts";

async function setup(over: Partial<InboundDeps> = {}) {
  const db = new PGlite(); await db.waitReady; await migrate(db);
  const handled: string[] = [];
  const deps: InboundDeps = { db, opTtlMinutes: 30, onPlaneEvent: async (j) => { handled.push("p:" + j.deliveryId); }, onGithubEvent: async (j) => { handled.push("g:" + j.deliveryId); }, ...over };
  return { db, deps, handled };
}
const plane = (id: string, issue: string, field: string | null, value: unknown, actor = "human"): InboundJob => ({ source: "plane", deliveryId: id, event: "issue", receivedAt: "", payload: { data: { id: issue }, activity: { field, new_value: value, actor: { id: actor } } } });
const ghIssue = (id: string, action: string, extra: object = {}): InboundJob => ({ source: "github", deliveryId: id, event: "issues", receivedAt: "", payload: { action, issue: { number: 3, title: "T" }, repository: { id: 7 }, ...extra } });
const rec = (db: PGlite, h: string) => recordAppliedOps(db, [{ opHash: h, direction: "to_plane" }]);

test("inbound: a repeated delivery id is a duplicate, per source", async () => {
  const { deps } = await setup();
  strictEqual(await processInbound(plane("d", "i", "name", "x"), deps), "handled");
  strictEqual(await processInbound(plane("d", "i", "name", "x"), deps), "duplicate");
  strictEqual(await processInbound({ ...ghIssue("d", "closed") }, deps), "handled");
});
test("inbound: an echo consumes exactly one op, so a repeat edit is handled", async () => {
  const { db, deps, handled } = await setup();
  await rec(db, opHash("plane", "i", "name", "x"));
  strictEqual(await processInbound(plane("1", "i", "name", "x"), deps), "echo");
  strictEqual(await processInbound(plane("2", "i", "name", "x"), deps), "handled");
  deepStrictEqual(handled, ["p:2"]);
});
test("inbound: the service-actor pre-filter drops events even with no matching op", async () => {
  const { deps, handled } = await setup({ serviceUserId: "svc" });
  strictEqual(await processInbound(plane("1", "i", "name", "x", "svc"), deps), "echo");
  deepStrictEqual(handled, []);
});
test("inbound: a service-actor event consumes its op", async () => {
  const { db, deps } = await setup({ serviceUserId: "svc" });
  const h = opHash("plane", "i", "name", "x");
  await rec(db, h);
  await processInbound(plane("1", "i", "name", "x", "svc"), deps);
  strictEqual(await consumeRecentOp(db, h, 30), false);
});
test("inbound: a plane creation matches the `created` op, null field included", async () => {
  const { db, deps } = await setup();
  await rec(db, opHash("plane", "new", "created", null));
  strictEqual(await processInbound(plane("1", "new", null, null), deps), "echo");
  strictEqual(await processInbound(plane("2", "other", null, null), deps), "handled");
});
test("inbound: expired ops do not make an echo", async () => {
  const { db, deps } = await setup({ opTtlMinutes: 5 });
  await db.query("INSERT INTO applied_ops (op_hash, direction, created_at) VALUES ($1, 'to_plane', now() - interval '1 hour')", [opHash("plane", "i", "name", "x")]);
  strictEqual(await processInbound(plane("1", "i", "name", "x"), deps), "handled");
});
test("inbound: a github event needs every field change to match to be an echo", async () => {
  const { db, deps, handled } = await setup();
  await recordAppliedOps(db, [{ opHash: opHash("github", "7#3", "title", "T"), direction: "to_github" }]);
  const edited = (id: string) => ghIssue(id, "edited", { changes: { title: { from: "o" }, body: { from: "o" } } });
  strictEqual(await processInbound(edited("1"), deps), "handled"); // body had no op
  await recordAppliedOps(db, [{ opHash: opHash("github", "7#3", "title", "T"), direction: "to_github" }, { opHash: opHash("github", "7#3", "body", null), direction: "to_github" }]);
  strictEqual(await processInbound(edited("2"), deps), "echo");
  deepStrictEqual(handled, ["g:1"]);
});
test("inbound: events with no field vocabulary are always handled", async () => {
  const { deps } = await setup();
  strictEqual(await processInbound({ source: "github", deliveryId: "p", event: "push", receivedAt: "", payload: { repository: { id: 7 } } }, deps), "handled");
});
test("inbound: when the handler throws the delivery is released so a retry runs", async () => {
  let fail = true;
  const { deps } = await setup({ onPlaneEvent: async () => { if (fail) throw new Error("transient"); } });
  await rejects(processInbound(plane("1", "i", "name", "x"), deps), /transient/);
  fail = false;
  strictEqual(await processInbound(plane("1", "i", "name", "x"), deps), "handled");
});
test("ledger: forgetAppliedOps removes one row per hash, newest first", async () => {
  const { db } = await setup();
  await rec(db, "h"); await rec(db, "h"); await rec(db, "keep");
  await forgetAppliedOps(db, ["h"]);
  strictEqual((await db.query("SELECT 1 FROM applied_ops WHERE op_hash = 'h'")).rows.length, 1);
  strictEqual((await db.query("SELECT 1 FROM applied_ops WHERE op_hash = 'keep'")).rows.length, 1);
});

test("isPermanentWriteError: classifies UnknownPlaneState, invalid installationId, and 401 correctly (F13, F7)", () => {
  strictEqual(isPermanentWriteError(new UnknownPlaneState("unknown Plane state id s1 in project p1")), true);
  strictEqual(isPermanentWriteError(new Error("invalid GitHub installationId: 0")), false);
  const err401 = { status: 401 };
  strictEqual(isPermanentWriteError(err401, 0), false);
  strictEqual(isPermanentWriteError(err401, 4), false);
  strictEqual(isPermanentWriteError(err401, 5), true);
});

test("inbound: create-in-flight marker is scoped narrowly and final failure is audited (F9)", async () => {
  const { db, deps } = await setup();
  await rec(db, pendingCreateHash("p1", "Feature X"));

  const unrelatedJob: InboundJob = {
    source: "plane",
    deliveryId: "d-unrelated",
    event: "issue",
    receivedAt: "",
    payload: {
      data: { id: "i2", project: "p1", name: "Bug Y" },
      activity: { field: null, new_value: null },
    },
  };
  strictEqual(await processInbound(unrelatedJob, deps), "handled");

  const matchingJob: InboundJob = {
    source: "plane",
    deliveryId: "d-matching",
    event: "issue",
    receivedAt: "",
    payload: {
      data: { id: "i3", project: "p1", name: "Feature X" },
      activity: { field: null, new_value: null },
    },
  };
  await rejects(
    processInbound(matchingJob, deps, { attemptsMade: 10, maxAttempts: 10 }),
    CreateInFlightError
  );

  const { rows } = await db.query<any>("SELECT kind, outcome, delivery_id FROM audit_log WHERE delivery_id = 'd-matching'");
  strictEqual(rows.length, 1);
  strictEqual(rows[0].kind, "inbound_delivery");
  strictEqual(rows[0].outcome, "failed");
});

test("inbound: failure audit is written only on final attempt and marked superseded on recovery (F14)", async () => {
  let fail = true;
  const { db, deps } = await setup({
    onPlaneEvent: async () => {
      if (fail) throw new Error("transient outage");
    },
  });

  const job = plane("d-retry", "i1", "name", "v");

  // Attempt 1 of 10: failing does not write a failed audit row
  await rejects(
    processInbound(job, deps, { attemptsMade: 1, maxAttempts: 10 }),
    /transient outage/
  );
  let rows = (await db.query<any>("SELECT kind, outcome, delivery_id FROM audit_log WHERE delivery_id = 'd-retry'")).rows;
  strictEqual(rows.length, 0);

  // Final attempt (10 of 10): failing writes exactly one failed audit row
  await rejects(
    processInbound(job, deps, { attemptsMade: 10, maxAttempts: 10 }),
    /transient outage/
  );
  rows = (await db.query<any>("SELECT kind, outcome, delivery_id FROM audit_log WHERE delivery_id = 'd-retry'")).rows;
  strictEqual(rows.length, 1);
  strictEqual(rows[0].outcome, "failed");

  // Later attempt succeeds (e.g. after service recovery or manual redelivery)
  fail = false;
  strictEqual(await processInbound(job, deps, { attemptsMade: 1, maxAttempts: 10 }), "handled");
  rows = (await db.query<any>("SELECT kind, outcome, delivery_id FROM audit_log WHERE delivery_id = 'd-retry' ORDER BY created_at ASC")).rows;
  // The earlier failed row should now be superseded, and the new row is handled
  strictEqual(rows.length, 2);
  strictEqual(rows[0].outcome, "superseded");
  strictEqual(rows[1].outcome, "handled");
});

test("inbound: auditDelivery preserves writeDeliveryId in detail (CB coordination F1)", async () => {
  const { db, deps } = await setup();
  const job: InboundJob = {
    source: "plane",
    deliveryId: "d-replay-1",
    writeDeliveryId: "d-original-1",
    event: "issue",
    receivedAt: "",
    payload: {
      data: { id: "i10", project: "p1", name: "Replay Test" },
      activity: { field: null, new_value: null },
    },
  };
  strictEqual(await processInbound(job, deps), "handled");
  const { rows } = await db.query<any>("SELECT kind, outcome, delivery_id, detail FROM audit_log WHERE delivery_id = 'd-replay-1'");
  strictEqual(rows.length, 1);
  strictEqual(rows[0].kind, "inbound_delivery");
  strictEqual(rows[0].outcome, "handled");
  strictEqual(rows[0].detail.writeDeliveryId, "d-original-1");
  await db.close();
});

