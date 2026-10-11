import test from "node:test";
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { createOrderedOutbox, deliveryScope, OrderedWriteDeferredError, QueuedWriteFailedError } from "../../src/app/writers.ts";
import { resultRef } from "../../src/operations/plans.ts";
import type { Db } from "../../src/db/migrate.ts";
import type { OutboxPlanStep } from "../../src/operations/plans.ts";
import { PlaneApiError } from "../../src/sync/plane.ts";
import { onGithubIssue } from "../../src/sync/mirror.ts";
import { SecretString } from "../../src/auth/identity.ts";
import { createVault } from "../../src/app/context.ts";
import { database, queue, intentJob } from "./outbox-fixture.ts";

const update = { kind: "update_issue" as const, slug: "ws", projectId: "p", issueId: "i", fields: { name: "Changed" } };
const steps: OutboxPlanStep[] = [
  { kind: "write", side: "plane", write: { kind: "create_issue", slug: "ws", projectId: "p", fields: { name: "Created" } }, bind: "created" },
  { kind: "sync_link", link: { planeWorkspaceSlug: "ws", planeProjectId: "p", planeIssueId: resultRef("created.id"), ghRepoId: 2, ghNumber: 3, ghKind: "issue", tier: "relation", createdBy: "label_sync" } },
  { kind: "write", side: "plane", write: { ...update, kind: "add_comment", issueId: resultRef("created.id"), commentHtml: "link" } },
];
const pendingLink = { planeWorkspaceSlug: "ws", planeProjectId: "p", ghRepoId: 2, ghNumber: 3 };

test("F2: terminal creation failure cancels the group, removes its barrier, and allows edit/re-opt-in", async (t) => {
  const db = await database(t), planeQ = queue();
  const outbox = createOrderedOutbox({ db, queues: { plane: planeQ as any, github: queue() as any }, loadActorToken: async () => null,
    plane: { preflight: async () => {}, apply: async () => { throw new PlaneApiError(403, {}, "forbidden"); } }, github: { apply: async () => ({ ok: true }) } });
  const key = "create:gh:ws:2#3:p";
  strictEqual((await outbox.plane.plan(key, steps, { pendingLink })).inserted, true);
  strictEqual((await outbox.plane.plan(key, steps, { pendingLink })).inserted, false);
  const original = (await db.query<{ id: string }>("SELECT id FROM outbound_writes ORDER BY sequence")).rows;
  await rejects(outbox.executePlane(await intentJob(db, original[0]!.id)), QueuedWriteFailedError);
  strictEqual((await db.query("SELECT 1 FROM outbound_writes WHERE status = 'pending'")).rows.length, 0);
  strictEqual((await db.query("SELECT 1 FROM pending_sync_links")).rows.length, 0);
  strictEqual((await db.query("SELECT 1 FROM audit_log WHERE kind = 'mirror_create_failed'")).rows.length, 1);
  await rejects(outbox.executePlane(await intentJob(db, original[0]!.id)), QueuedWriteFailedError);
  strictEqual((await db.query("SELECT 1 FROM audit_log WHERE kind = 'mirror_create_failed'")).rows.length, 1);
  // A stale marker lookup cannot append a continuation after the group has failed.
  strictEqual((await outbox.plane.plan("late-event", [{ kind: "write", side: "plane", write: update }], {
    groupRoot: original[0]!.id, predecessor: original[1]!.id,
    pendingMarker: { key, root: original[0]!.id, link: pendingLink },
  })).inserted, false);
  strictEqual((await db.query("SELECT 1 FROM outbound_writes")).rows.length, original.length);
  const job = { source: "github" as const, deliveryId: "edit", event: "issues", payload: {}, receivedAt: "now" };
  const deps = { db, plane: outbox.plane, github: outbox.github, createContinuation: { job },
    mapping: { id: 1, workspaceSlug: "ws", planeProjectId: "p", ghRepoId: 2, installationId: 1, owner: "o", repo: "r", syncDirection: "bidirectional" as const },
    users: { planeUserIdForGithubLogin: async () => null } };
  const issue = { number: 3, title: "Title", state: "open", labels: [{ name: "plane" }] };
  // A pre-upgrade failed marker is ignored, then replaced by the new generation's marker.
  await db.query("INSERT INTO pending_sync_links (key,outbox_id,link) VALUES ($1,$2,$3::jsonb)", [key, original[0]!.id, JSON.stringify(pendingLink)]);
  const edited = await onGithubIssue({ action: "edited", issue, repository: { id: 2 } }, deps);
  strictEqual(edited.action, "ignored");
  const reopt = await onGithubIssue({ action: "labeled", issue, label: { name: "plane" }, repository: { id: 2 } }, deps);
  strictEqual(reopt.action, "created");
  strictEqual((await db.query("SELECT 1 FROM pending_sync_links")).rows.length, 1);
  ok((await db.query("SELECT 1 FROM outbound_writes WHERE status = 'pending'")).rows.length > 0);
});

test("F3: only explicit replay revives a failed intent, then replays do not repeat its applied write", async (t) => {
  const db = await database(t), planeQ = queue();
  let calls = 0, healthy = false;
  const outbox = createOrderedOutbox({ db, maxAttempts: 1, queues: { plane: planeQ as any, github: queue() as any }, loadActorToken: async () => null,
    plane: { preflight: async () => {}, apply: async () => { calls++; if (!healthy) throw new Error("outage"); return { ok: true }; } }, github: { apply: async () => ({ ok: true }) } });
  const register = (scope: Parameters<typeof deliveryScope.run>[0]) => deliveryScope.run(scope, () => outbox.plane.apply(update));
  await register({ deliveryId: "github-original" });
  const job = await intentJob(db);
  await rejects(outbox.executePlane(job), QueuedWriteFailedError);
  await register({ deliveryId: "github-original" });
  await register({ deliveryId: "github-original", writeDeliveryId: "original", transportDeliveryId: "original" });
  strictEqual((await db.query<{ status: string }>("SELECT status FROM outbound_writes")).rows[0]!.status, "failed");
  planeQ.jobs.clear();
  await register({ deliveryId: "github-original", writeDeliveryId: "original", transportDeliveryId: "replay-1" });
  deepStrictEqual((await db.query("SELECT status,attempts,error,retry_at FROM outbound_writes")).rows, [{ status: "pending", attempts: 0, error: null, retry_at: null }]);
  strictEqual(planeQ.jobs.size, 1);
  healthy = true;
  await outbox.executePlane(await intentJob(db));
  await register({ deliveryId: "github-original", writeDeliveryId: "original", transportDeliveryId: "replay-2" });
  strictEqual((await db.query("SELECT 1 FROM outbound_writes")).rows.length, 1);
  strictEqual((await db.query("SELECT 1 FROM outbound_writes WHERE status = 'pending'")).rows.length, 0);
  strictEqual(calls, 2);
});

test("F3: replay resets a plan's failed tail while retaining its applied create and result", async (t) => {
  const db = await database(t), planeQ = queue();
  let creates = 0, comments = 0, healthy = false;
  const outbox = createOrderedOutbox({ db, queues: { plane: planeQ as any, github: queue() as any }, loadActorToken: async () => null,
    plane: { preflight: async () => {}, apply: async (w) => {
      if (w.kind === "create_issue") { creates++; return { ok: true, id: "created" }; }
      comments++; if (!healthy) throw new PlaneApiError(403, {}, "locked"); return { ok: true };
    } }, github: { apply: async () => ({ ok: true }) } });
  const register = (replay = false) => deliveryScope.run({ deliveryId: "github-create", ...(replay ? { writeDeliveryId: "create", transportDeliveryId: "replay" } : {}) },
    () => outbox.plane.plan("create-tail", steps, { pendingLink }));
  await register();
  const rows = (await db.query<{ id: string }>("SELECT id FROM outbound_writes ORDER BY sequence")).rows;
  await outbox.executePlane(await intentJob(db, rows[0]!.id));
  await rejects(outbox.executePlane(await intentJob(db, rows[1]!.id)), QueuedWriteFailedError);
  strictEqual((await db.query("SELECT 1 FROM pending_sync_links")).rows.length, 0);
  strictEqual((await register()).inserted, false);
  strictEqual((await db.query("SELECT 1 FROM outbound_writes WHERE status = 'failed'")).rows.length, 1);
  planeQ.jobs.clear();
  await register(true);
  strictEqual((await db.query("SELECT 1 FROM pending_sync_links")).rows.length, 1);
  strictEqual(planeQ.jobs.size, 1);
  healthy = true;
  await outbox.executePlane(await intentJob(db, rows[1]!.id));
  strictEqual(creates, 1); strictEqual(comments, 2);
  strictEqual((await db.query("SELECT 1 FROM outbound_writes WHERE status = 'applied'")).rows.length, 2);
  strictEqual((await db.query("SELECT 1 FROM pending_sync_links")).rows.length, 0);
});

test("F3: default retry bounds ride out a one-hour outage and manual retry checks the workspace", async (t) => {
  const db = await database(t);
  let clock = Date.now(), healthy = false;
  const outbox = createOrderedOutbox({ db, now: () => clock, queues: { plane: queue() as any, github: queue() as any }, loadActorToken: async () => null,
    plane: { preflight: async () => {}, apply: async () => { if (!healthy) throw new Error("outage"); return { ok: true }; } }, github: { apply: async () => ({ ok: true }) } });
  await deliveryScope.run({ deliveryId: "hour" }, () => outbox.plane.apply(update));
  const job = await intentJob(db);
  await rejects(outbox.executePlane(job), OrderedWriteDeferredError);
  clock += 60 * 60_000;
  await rejects(outbox.executePlane(job), OrderedWriteDeferredError);
  strictEqual((await db.query<{ status: string }>("SELECT status FROM outbound_writes")).rows[0]!.status, "pending");
  // An explicit terminal failure can still be retried independently of inbound replay.
  await db.query("UPDATE outbound_writes SET status = 'failed'");
  await rejects(outbox.retryFailed(job.id, "other"), (e: any) => e.status === 404);
  deepStrictEqual(await outbox.retryFailed(job.id, "ws"), { ok: true, retried: true });
  healthy = true;
  await outbox.executePlane(await intentJob(db));
  deepStrictEqual(await outbox.retryFailed(job.id, "ws"), { ok: true, retried: false });
  strictEqual((await db.query("SELECT 1 FROM audit_log WHERE kind = 'outbound_write_retry'")).rows.length, 1);
});

for (const status of [401, 403]) test(`F10: actor ${status} invalidates only the PAT and persists service fallback across worker restart`, async (t) => {
  const db = await database(t), vault = createVault(db, Buffer.alloc(32, 7));
  await vault.store("actor", "plane_pat", "revoked"); await vault.store("actor", "github_oauth", "keep-oauth");
  const calls: string[] = [], intentIds: (string | undefined)[] = [];
  let clock = Date.now(), healthy = false;
  const deps = { db, now: () => clock, queues: { plane: queue() as any, github: queue() as any }, loadActorToken: (id: string) => vault.load(id, "plane_pat"),
    plane: { preflight: async () => {}, apply: async (_write: unknown, opts?: { actorToken?: SecretString; intentId?: string }) => {
      calls.push(opts?.actorToken ? "actor" : "service");
      intentIds.push(opts?.intentId);
      if (opts?.actorToken) throw new PlaneApiError(status, {}, "revoked");
      if (!healthy) throw new Error("temporary service outage");
      return { ok: true as const, id: "created" };
    } }, github: { apply: async () => ({ ok: true as const }) } };
  const one = createOrderedOutbox(deps);
  await deliveryScope.run({ deliveryId: "actor" }, () => one.plane.apply({ kind: "create_issue", slug: "ws", projectId: "p", fields: { name: "Created" } }, { actorToken: new SecretString("revoked", "actor") }));
  const original = await intentJob(db);
  await rejects(one.executePlane(original), OrderedWriteDeferredError);
  strictEqual(await vault.load("actor", "plane_pat"), null);
  strictEqual((await vault.load("actor", "github_oauth"))?.reveal(), "keep-oauth");
  clock += 60_000; healthy = true;
  const two = createOrderedOutbox(deps);
  await two.executePlane(await intentJob(db));
  deepStrictEqual(calls, ["actor", "service", "service"]);
  deepStrictEqual(intentIds, [original.id, original.id, original.id], "actor, service fallback and restarted worker must preserve create identity");
  const audit = (await db.query<{ detail: any }>("SELECT detail FROM audit_log WHERE kind = 'identity_fallback'")).rows;
  strictEqual(audit.length, 1); strictEqual(audit[0]!.detail.reason, "token_rejected");
});

for (const headers of [{ "retry-after": "5" }, { "x-ratelimit-remaining": "0" }] as Record<string, string>[])
test(`F10: rate-limit 403 (${Object.keys(headers)[0]}) keeps the actor credential without fallback`, async (t) => {
  const db = await database(t), vault = createVault(db, Buffer.alloc(32, 8));
  await vault.store("actor", "plane_pat", "valid");
  const outbox = createOrderedOutbox({ db, queues: { plane: queue() as any, github: queue() as any }, loadActorToken: (id) => vault.load(id, "plane_pat"),
    plane: { preflight: async () => {}, apply: async () => { throw new PlaneApiError(403, {}, "rate limited", headers); } },
    github: { apply: async () => ({ ok: true }) } });
  await outbox.plane.apply(update, { actorToken: new SecretString("valid", "actor") });
  await rejects(outbox.executePlane(await intentJob(db)), OrderedWriteDeferredError);
  strictEqual((await vault.load("actor", "plane_pat"))?.reveal(), "valid");
  strictEqual((await db.query("SELECT 1 FROM audit_log WHERE kind = 'identity_fallback'")).rows.length, 0);
});


test("F2: failure cleanup and its audit roll back together if the audit cannot be written", async (t) => {
  const db = await database(t);
  let failAudit = true;
  const connection: Db = { exec: db.exec.bind(db), query: async <T>(sql: string, params?: any[]) => {
    if (sql.includes("pg_advisory") || sql.includes("pg_try_advisory")) return { rows: [{ ok: true } as T] };
    if (failAudit && sql.includes("INSERT INTO audit_log")) { failAudit = false; throw new Error("audit database unavailable"); }
    return db.query<T>(sql, params);
  } };
  const transactional: Db = { exec: db.exec.bind(db), query: db.query.bind(db), withConnection: async (fn) => fn(connection) };
  const outbox = createOrderedOutbox({ db: transactional, queues: { plane: queue() as any, github: queue() as any }, loadActorToken: async () => null,
    plane: { preflight: async () => {}, apply: async () => { throw new PlaneApiError(403, {}, "forbidden"); } }, github: { apply: async () => ({ ok: true }) } });
  await outbox.plane.plan("atomic", steps, { pendingLink });
  const rows = (await db.query<{ id: string }>("SELECT id FROM outbound_writes ORDER BY sequence")).rows;
  await rejects(outbox.executePlane(await intentJob(db, rows[0]!.id)), /audit database unavailable/);
  strictEqual((await db.query("SELECT 1 FROM outbound_writes WHERE status = 'pending'")).rows.length, 2);
  strictEqual((await db.query("SELECT 1 FROM pending_sync_links")).rows.length, 1);
  strictEqual((await db.query("SELECT 1 FROM audit_log")).rows.length, 0);
  await rejects(outbox.executePlane(await intentJob(db, rows[0]!.id)), QueuedWriteFailedError);
  strictEqual((await db.query("SELECT 1 FROM outbound_writes WHERE status = 'failed'")).rows.length, 2);
  strictEqual((await db.query("SELECT 1 FROM pending_sync_links")).rows.length, 0);
});

test("F3: a failed plan root is replayable, while retrying an older superseded generation is refused", async (t) => {
  const db = await database(t);
  let healthy = false, creates = 0;
  const outbox = createOrderedOutbox({ db, queues: { plane: queue() as any, github: queue() as any }, loadActorToken: async () => null,
    plane: { preflight: async () => {}, apply: async (w) => {
      if (w.kind === "create_issue") { if (!healthy) throw new PlaneApiError(403, {}, "forbidden"); creates++; return { ok: true, id: "created" }; }
      return { ok: true };
    } }, github: { apply: async () => ({ ok: true }) } });
  const register = (replay = false) => deliveryScope.run({ deliveryId: "github-root", ...(replay ? { writeDeliveryId: "root", transportDeliveryId: "replay-root" } : {}) },
    () => outbox.plane.plan("root-replay", steps, { pendingLink }));
  await register();
  const rows = (await db.query<{ id: string }>("SELECT id FROM outbound_writes ORDER BY sequence")).rows;
  await rejects(outbox.executePlane(await intentJob(db, rows[0]!.id)), QueuedWriteFailedError);
  await register(true);
  strictEqual((await db.query("SELECT 1 FROM outbound_writes WHERE status = 'pending'")).rows.length, 2);
  healthy = true;
  for (const row of rows) await outbox.executePlane(await intentJob(db, row.id));
  strictEqual(creates, 1);
  // A failed old generation must not create a second partner after a new generation took over.
  healthy = false;
  const newSteps = steps.map((step) => step.kind === "sync_link" ? { ...step, link: { ...step.link, ghNumber: 4 } } : step);
  const key = "different-object";
  await outbox.plane.plan(key, newSteps, { pendingLink: { ...pendingLink, ghNumber: 4 } });
  const old = (await db.query<{ id: string; sequence: string }>("SELECT id,sequence FROM outbound_writes ORDER BY sequence DESC OFFSET 1 LIMIT 1")).rows[0]!;
  await rejects(outbox.executePlane(await intentJob(db, old.id)), QueuedWriteFailedError);
  const generationKey = `${key}:generation:${old.sequence}`;
  const generationRoot = (await import("node:crypto")).createHash("sha256").update(generationKey).digest("hex");
  await outbox.plane.plan(generationKey, newSteps, { pendingLink: { ...pendingLink, ghNumber: 4 },
    pendingMarker: { key, root: `plan-${generationRoot}`, link: { ...pendingLink, ghNumber: 4 } } });
  await rejects(outbox.retryFailed(old.id, "ws"), (e: any) => e.status === 409);
  healthy = true;
  const pending = (await db.query<{ id: string }>("SELECT id FROM outbound_writes WHERE status = 'pending' ORDER BY sequence")).rows;
  for (const row of pending) await outbox.executePlane(await intentJob(db, row.id));
  await rejects(outbox.retryFailed(old.id, "ws"), (e: any) => e.status === 409);
  strictEqual(creates, 2);
});
