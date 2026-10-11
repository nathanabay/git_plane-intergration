import test from "node:test";
import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { startPostgres } from "../../scripts/lib/postgres.mjs";
import { createDb } from "../../src/db/client.ts";
import { migrate } from "../../src/db/migrate.ts";
import { createOrderedOutbox, deliveryScope, OrderedWriteDeferredError } from "../../src/app/writers.ts";
import { queue, intentJob } from "./outbox-fixture.ts";
import type { PlaneWrite } from "../../src/sync/plane.ts";
import type { Db } from "../../src/db/migrate.ts";

test("F6: real PostgreSQL advisory locks serialize independent replica pools on one target", async () => {
  const pg = await startPostgres();
  const a = createDb(pg.url), b = createDb(pg.url);
  let release!: () => void;
  let first: Promise<unknown> | undefined;
  try {
    await migrate(a);
    const planeQueue = queue(), githubQueue = queue();
    const states: string[] = [];
    let entered!: () => void;
    const enteredApi = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { release = r; });
    let running = 0, peak = 0;
    const plane = { preflight: async () => {}, apply: async (write: PlaneWrite) => {
      if (write.kind === "update_issue") {
        peak = Math.max(peak, ++running);
        if (write.fields.state === "old") { entered(); await gate; }
        states.push(String(write.fields.state));
        running--;
      }
      return { ok: true as const };
    } };
    const deps = { plane, github: { apply: async () => ({ ok: true as const }) },
      queues: { plane: planeQueue as any, github: githubQueue as any }, loadActorToken: async () => null,
       };
    const one = createOrderedOutbox({ db: a, ...deps }), two = createOrderedOutbox({ db: b, ...deps });
    for (const state of ["old", "new"]) await deliveryScope.run({ deliveryId: `d-${state}` }, () =>
      one.plane.apply({ kind: "update_issue", slug: "ws", projectId: "p", issueId: "i", fields: { state } }));
    const ids = (await a.query<{ id: string }>("SELECT id FROM outbound_writes ORDER BY sequence")).rows;
    const staged = await Promise.all(ids.map((r) => intentJob(a, r.id)));
    const old = staged[0]!, newer = staged[1]!;
    first = one.executePlane(old);
    await enteredApi;
    await rejects(two.executePlane(newer), OrderedWriteDeferredError);
    deepStrictEqual(states, []);
    release();
    await first;
    await two.executePlane(newer);
    strictEqual(peak, 1);
    deepStrictEqual(states, ["old", "new"]);

    // Pause the first registration before COMMIT. Another replica must not make its later
    // sequence visible to a worker while that lower sequence remains uncommitted.
    let registered!: () => void, releaseRegistration!: () => void;
    const atRegistration = new Promise<void>((r) => { registered = r; });
    const registrationGate = new Promise<void>((r) => { releaseRegistration = r; });
    const delayedDb: Db = { query: a.query.bind(a), exec: a.exec.bind(a), withConnection: (fn) =>
      a.withConnection!(async (conn) => fn({ ...conn, query: async (sql, params) => {
        const result = await conn.query(sql, params);
        if (sql.includes("INSERT INTO outbound_writes")) { registered(); await registrationGate; }
        return result;
      } })) };
    const three = createOrderedOutbox({ db: delayedDb, ...deps });
    const stage = (outbox: typeof one, state: string) => deliveryScope.run({ deliveryId: `registration-${state}` }, () =>
      outbox.plane.apply({ kind: "update_issue", slug: "ws", projectId: "p", issueId: "registration", fields: { state } }));
    const registeringOld = stage(three, "first");
    await atRegistration;
    const registeringNew = stage(two, "second");
    try {
      let waits = 0;
      for (let i = 0; i < 50 && !waits; i++) {
        waits = (await b.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted")).rows[0]!.n;
        if (!waits) await new Promise((r) => setTimeout(r, 10));
      }
      strictEqual(waits, 1, "later registration must wait for the earlier commit");
    } finally { releaseRegistration(); await Promise.all([registeringOld, registeringNew]); }
    const registrations = (await a.query<{ id: string; write: PlaneWrite & { fields: { state: string } } }>(
      "SELECT id, write FROM outbound_writes WHERE write->>'issueId' = 'registration' ORDER BY sequence")).rows;
    deepStrictEqual(registrations.map((r) => r.write.fields.state), ["first", "second"]);
    const registrationJobs = await Promise.all(registrations.map((r) => intentJob(a, r.id)));
    await two.executePlane(registrationJobs[0]!);
    await two.executePlane(registrationJobs[1]!);
    deepStrictEqual(states, ["old", "new", "first", "second"]);
  } finally {
    release?.();
    await first?.catch(() => {});
    await a.close();
    await b.close();
    await pg.stop();
  }
});

test("F2: independent PostgreSQL replicas atomically reserve one pending create and its link marker", async () => {
  const pg = await startPostgres(), a = createDb(pg.url), b = createDb(pg.url);
  try {
    await migrate(a);
    const planeQueue = queue();
    let creates = 0;
    const deps = { queues: { plane: planeQueue as any, github: queue() as any }, loadActorToken: async () => null,
      plane: { preflight: async () => {}, apply: async () => { creates++; return { ok: true, id: "created" }; } }, github: { apply: async () => ({ ok: true as const }) } };
    const one = createOrderedOutbox({ db: a, ...deps }), two = createOrderedOutbox({ db: b, ...deps });
    const steps = [{ kind: "write" as const, side: "plane" as const,
      write: { kind: "create_issue", slug: "ws", projectId: "p", fields: { name: "Title" } } }];
    await Promise.all([
      deliveryScope.run({ deliveryId: "opened" }, () => one.plane.plan("create:object", steps, { pendingLink: { number: 3 } })),
      deliveryScope.run({ deliveryId: "labeled" }, () => two.plane.plan("create:object", steps, { pendingLink: { number: 3 } })),
    ]);
    strictEqual((await a.query("SELECT 1 FROM outbound_writes")).rows.length, 1);
    strictEqual((await a.query("SELECT 1 FROM pending_sync_links")).rows.length, 1);
    await two.executePlane(await intentJob(a));
    await one.executePlane(await intentJob(a));
    strictEqual(creates, 1);
  } finally { await a.close(); await b.close(); await pg.stop(); }
});

test("F1/F2: a deferred event restores a marker cleared after its lookup and preserves create results", async () => {
  const pg = await startPostgres(), a = createDb(pg.url), b = createDb(pg.url);
  try {
    await migrate(a);
    const calls: string[] = [];
    const deps = { queues: { plane: queue() as any, github: queue() as any }, loadActorToken: async () => null,
      plane: { preflight: async () => {}, apply: async () => ({ ok: true as const, id: "created" }) }, github: { apply: async () => ({ ok: true as const }) },
      resumeReducer: async (request: { issueId: string }) => { calls.push(request.issueId); } };
    const one = createOrderedOutbox({ db: a, ...deps }), two = createOrderedOutbox({ db: b, ...deps });
    await one.plane.plan("create:marker-race", [
      { kind: "write", side: "plane", write: { kind: "create_issue", slug: "ws", projectId: "p", fields: {} }, bind: "created" },
      { kind: "write", side: "github", write: { kind: "comment", installationId: 1, owner: "o", repo: "r", repoId: 2, number: 3, body: "link" } },
    ], { pendingLink: { planeWorkspaceSlug: "ws" } });
    // The later reducer reads a marker, then the original workflow completes on another replica.
    const marker = (await b.query<{ outbox_id: string; link: Record<string, unknown> }>("SELECT outbox_id, link FROM pending_sync_links")).rows[0]!;
    const original = (await b.query<{ id: string; side: string; target_key: string }>("SELECT id, side, target_key FROM outbound_writes ORDER BY sequence")).rows;
    for (const row of original) {
      const job = await intentJob(a, row.id);
      if (row.side === "plane") await one.executePlane(job); else await one.executeGithub(job);
    }
    strictEqual((await b.query("SELECT 1 FROM pending_sync_links")).rows.length, 0);
    await two.plane.plan("pending-event:marker-race", [
      { kind: "write", side: "plane", write: { kind: "resume_reducer", continuation: {
        kind: "mirror_pending", job: { source: "github", deliveryId: "event", event: "issues", payload: {}, receivedAt: "now" },
        mappingId: 1, projectId: "p", issueId: { $result: "partner.id" }, identifier: "event" } } },
    ], { groupRoot: marker.outbox_id, bindings: { partner: original[0]!.id }, predecessor: original.at(-1)!.id,
      pendingMarker: { key: "create:marker-race", root: marker.outbox_id, link: marker.link } });
    strictEqual((await a.query("SELECT 1 FROM pending_sync_links")).rows.length, 1);
    const deferred = (await a.query<{ id: string; target_key: string }>("SELECT id, target_key FROM outbound_writes WHERE status = 'pending'")).rows[0]!;
    strictEqual(deferred.target_key, original[0]!.target_key);
    await one.executePlane(await intentJob(a, deferred.id));
    deepStrictEqual(calls, ["created"]);
    strictEqual((await b.query("SELECT 1 FROM pending_sync_links")).rows.length, 0);
  } finally { await a.close(); await b.close(); await pg.stop(); }
});
