import test from "node:test";
import { deepStrictEqual, rejects, strictEqual, ok } from "node:assert/strict";
import { SecretString } from "../../src/auth/identity.ts";
import { PlaneApiError } from "../../src/sync/plane.ts";
import type { PlaneWrite } from "../../src/sync/plane.ts";
import { createOrderedOutbox, deliveryScope, OrderedWriteDeferredError, QueuedWriteFailedError } from "../../src/app/writers.ts";
import { database, queue, intentJob } from "./outbox-fixture.ts";

const write = (state: string, issueId = "i1"): PlaneWrite =>
  ({ kind: "update_issue", slug: "ws", projectId: "p1", issueId, fields: { state } });

async function setup(t: { after(fn: () => Promise<unknown>): void }) {
  const db = await database(t);
  const planeQueue = queue(), githubQueue = queue();
  const applied: string[] = [];
  let clock = Date.now(), failFirst = true, actorAvailable = true;
  const plane = { preflight: async () => {}, apply: async (w: PlaneWrite, opts: any = {}) => {
    if (w.kind === "update_issue") {
      if (failFirst && w.fields.state === "old") { failFirst = false; throw new PlaneApiError(502, {}, "API unavailable"); }
      applied.push(`${w.issueId}:${w.fields.state}:${opts.actorToken?.reveal() ?? "SERVICE"}`);
    }
    return { ok: true as const, id: "new-id" };
  } };
  const args = { db, plane, github: { apply: async () => ({ ok: true as const }) },
    queues: { plane: planeQueue as any, github: githubQueue as any },
    actorUserIdForToken: async () => "u-actor", loadActorToken: async () => actorAvailable ? new SecretString("CURRENT-PAT") : null,
    now: () => clock };
  const outbox = createOrderedOutbox(args);
  const stage = async (state: string, issueId = "i1", actorToken?: SecretString) => {
    await deliveryScope.run({ deliveryId: `github-${state}-${issueId}`, seq: 0 }, () =>
      outbox.plane.apply(write(state, issueId), { actorToken }));
    return intentJob(db);
  };
  return { db, planeQueue, applied, args, outbox, stage, advance() { clock += 600_000; }, revokeActor() { actorAvailable = false; } };
}

test("F6: a delayed older write remains ahead of a newer write, even on another executor instance", async (t) => {
  const h = await setup(t);
  const old = await h.stage("old"), newer = await h.stage("new");
  await rejects(h.outbox.executePlane(old), OrderedWriteDeferredError);
  const replica = createOrderedOutbox(h.args);
  await rejects(replica.executePlane(newer), OrderedWriteDeferredError);
  deepStrictEqual(h.applied, []);
  h.advance();
  // The newer wake-up can recover the old intent, but can never perform its own write first.
  await rejects(replica.executePlane(newer), OrderedWriteDeferredError);
  deepStrictEqual(h.applied, ["i1:old:SERVICE"]);
  await replica.executePlane(newer);
  await h.outbox.executePlane(old);
  deepStrictEqual(h.applied, ["i1:old:SERVICE", "i1:new:SERVICE"]);
});

test("F6: per-user writes use the same FIFO, store only user identity, and reload the current PAT", async (t) => {
  const h = await setup(t);
  const service = await h.stage("service"), actor = await h.stage("actor", "i1", new SecretString("OLD-PAT"));
  ok(!JSON.stringify(actor.data).includes("OLD-PAT"));
  strictEqual(actor.data._gitsync.actorUserId, "u-actor");
  ok(!JSON.stringify((await h.db.query("SELECT * FROM outbound_writes")).rows).includes("OLD-PAT"));
  await rejects(h.outbox.executePlane(actor), OrderedWriteDeferredError);
  await h.outbox.executePlane(actor);
  await h.outbox.executePlane(service);
  deepStrictEqual(h.applied, ["i1:service:SERVICE", "i1:actor:CURRENT-PAT"]);
});

test("F6: simultaneous executors cannot overlap API writes on the same target", async (t) => {
  const h = await setup(t);
  const first = await h.stage("first"), second = await h.stage("second");
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => { entered = r; });
  const gate = new Promise<void>((r) => { release = r; });
  let running = 0, peak = 0;
  h.args.plane.apply = async () => { peak = Math.max(peak, ++running); entered(); await gate; running--; return { ok: true, id: "new-id" }; };
  const one = h.outbox.executePlane(first);
  await started;
  await rejects(createOrderedOutbox(h.args).executePlane(second), OrderedWriteDeferredError);
  release();
  await one;
  await h.outbox.executePlane(second);
  strictEqual(peak, 1);
});

test("F6: other targets can progress while one target is delayed", async (t) => {
  const h = await setup(t);
  const old = await h.stage("old"), other = await h.stage("new", "i2");
  await rejects(h.outbox.executePlane(old), OrderedWriteDeferredError);
  await h.outbox.executePlane(other);
  deepStrictEqual(h.applied, ["i2:new:SERVICE"]);
});

test("F2/F6: an interrupted enqueue is recoverable from durable intent without changing its ID", async (t) => {
  const h = await setup(t);
  h.planeQueue.failNextAdd();
  await deliveryScope.run({ deliveryId: "github-d1", seq: 0 }, () => h.outbox.plane.apply(write("new")));
  strictEqual(h.planeQueue.jobs.size, 0);
  const id = (await h.db.query<{ id: string }>("SELECT id FROM outbound_writes")).rows[0]!.id;
  await h.outbox.recover();
  strictEqual(h.planeQueue.jobs.size, 1);
  strictEqual([...h.planeQueue.jobs.keys()][0], id);
  await h.outbox.executePlane(h.planeQueue.jobs.get(id));
  await deliveryScope.run({ deliveryId: "github-d1", seq: 0 }, () => h.outbox.plane.apply(write("new")));
  deepStrictEqual(h.applied, ["i1:new:SERVICE"]);
});

test("F6: a revoked actor PAT falls back to the service identity, audited once", async (t) => {
  const h = await setup(t);
  h.revokeActor();
  const actor = await h.stage("actor", "i1", new SecretString("OLD-PAT")), service = await h.stage("service");
  await h.outbox.executePlane(actor);
  await h.outbox.executePlane(service);
  deepStrictEqual(h.applied, ["i1:actor:SERVICE", "i1:service:SERVICE"]);
  const failure = (await h.db.query<any>("SELECT detail FROM audit_log WHERE kind = 'identity_fallback'")).rows[0]!.detail;
  strictEqual(failure.outboxId, actor.id);
  strictEqual(failure.reason, "token_revoked");
  strictEqual((await h.db.query("SELECT 1 FROM audit_log WHERE kind = 'identity_fallback'")).rows.length, 1);
  ok(!JSON.stringify(failure).includes("OLD-PAT"));
});
