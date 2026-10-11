import test from "node:test";
import { deepStrictEqual, notStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { createOrderedOutbox, deliveryScope, OrderedWriteDeferredError, resultRef } from "../../src/app/writers.ts";
import { onGithubIssue, onPlaneIssue } from "../../src/sync/mirror.ts";
import { database, queue, intentJob } from "./outbox-fixture.ts";
import type { Db } from "../../src/db/migrate.ts";

const target = { slug: "ws", projectId: "p", issueId: "i" };
const update = (state: string) => ({ kind: "update_issue" as const, ...target, fields: { state } });
const mapping = { id: 1, workspaceSlug: "ws", planeProjectId: "p", ghRepoId: 2, syncDirection: "bidirectional" as const, installationId: 1, owner: "o", repo: "r" };

async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const db = await database(t), planeQueue = queue(), githubQueue = queue();
  const applied: any[] = [];
  const outbox = createOrderedOutbox({ db, queues: { plane: planeQueue as any, github: githubQueue as any },
    loadActorToken: async () => null,
    plane: { preflight: async () => {}, apply: async (write) => {
      applied.push(write);
      return { ok: true, id: write.kind === "upsert_label" ? `label-${write.name}` : "created-item" };
    } }, github: { apply: async (write) => { applied.push(write); return { ok: true, number: 7 }; } } });
  const drain = async () => {
    for (let i = 0; i < 30; i++) {
      const row = (await db.query<{ id: string; side: string }>("SELECT id, side FROM outbound_writes WHERE status = 'pending' ORDER BY sequence LIMIT 1")).rows[0];
      if (!row) return;
      const job = await intentJob(db, row.id);
      if (row.side === "plane") await outbox.executePlane(job); else await outbox.executeGithub(job);
    }
    throw new Error("fixture exceeded 30 continuation steps");
  };
  return { db, outbox, planeQueue, githubQueue, applied, drain };
}

test("F1: durable acknowledgement does not poll or call an unavailable destination", async (t) => {
  const h = await fixture(t);
  const began = performance.now();
  deepStrictEqual(await h.outbox.plane.apply(update("A")), { ok: true });
  ok(performance.now() - began < 1000, "inbound producer waited for the outbound worker");
  deepStrictEqual(h.applied, []);
  strictEqual((await h.db.query("SELECT 1 FROM outbound_writes WHERE status = 'pending'")).rows.length, 1);
});

test("F3: A→B→A is three intents and the same delivery retry reproduces all IDs", async (t) => {
  const h = await fixture(t);
  const run = () => deliveryScope.run({ deliveryId: "aba" }, async () => {
    for (const state of ["A", "B", "A"]) await h.outbox.plane.apply(update(state));
  });
  await run();
  const ids = (await h.db.query<{ id: string }>("SELECT id FROM outbound_writes ORDER BY sequence")).rows.map((r) => r.id);
  strictEqual(new Set(ids).size, 3);
  strictEqual(h.planeQueue.jobs.size, 1, "only the head holds a wake-up");
  await run();
  strictEqual((await h.db.query("SELECT 1 FROM outbound_writes")).rows.length, 3);
  await h.drain();
  deepStrictEqual(h.applied.map((w) => w.fields.state), ["A", "B", "A"]);
});

test("F10 contract: skipTerminalState is identity content and survives intent, recovery, execution", async (t) => {
  const h = await fixture(t);
  const guard = { ...update("A"), skipTerminalState: true as const };
  await deliveryScope.run({ deliveryId: "guard" }, () => h.outbox.plane.apply(guard));
  await deliveryScope.run({ deliveryId: "guard" }, () => h.outbox.plane.apply(update("A")));
  const rows = (await h.db.query<{ id: string; write: any }>("SELECT id, write FROM outbound_writes ORDER BY sequence")).rows;
  notStrictEqual(rows[0]!.id, rows[1]!.id);
  strictEqual(rows[0]!.write.skipTerminalState, true);
  h.planeQueue.jobs.clear();
  await h.outbox.recover();
  strictEqual(h.planeQueue.jobs.get(rows[0]!.id).data.skipTerminalState, true);
  await h.drain();
  strictEqual(h.applied[0].skipTerminalState, true);
  strictEqual(h.applied[1].skipTerminalState, undefined);
});

test("F2: opened and labeled deliveries during a pending create produce one item and complete its link and comments", async (t) => {
  const h = await fixture(t);
  const deps = { db: h.db, plane: h.outbox.plane, github: h.outbox.github, mapping,
    users: { planeUserIdForGithubLogin: async () => null } };
  const issue = { number: 3, title: "First", body: "Body", labels: [{ name: "plane" }, { name: "bug" }], state: "open" };
  await deliveryScope.run({ deliveryId: "opened" }, () => onGithubIssue({ action: "opened", issue, repository: { id: 2 } }, deps));
  strictEqual((await h.db.query("SELECT 1 FROM pending_sync_links")).rows.length, 1);
  strictEqual((await h.db.query("SELECT 1 FROM sync_links")).rows.length, 0);
  // Changed content and an extra label must not make the duplicate registration extend the original plan.
  await deliveryScope.run({ deliveryId: "labeled" }, () => onGithubIssue({ action: "labeled", label: { name: "plane" },
    issue: { ...issue, title: "Changed", labels: [...issue.labels, { name: "help" }] } }, deps));
  h.planeQueue.jobs.clear(); h.githubQueue.jobs.clear();
  await h.outbox.recover();
  await h.drain();
  strictEqual(h.applied.filter((w) => w.kind === "create_issue").length, 1);
  const create = h.applied.find((w) => w.kind === "create_issue");
  deepStrictEqual(create.fields.labels, ["label-bug"]);
  strictEqual((await h.db.query("SELECT 1 FROM sync_links WHERE plane_issue_id = 'created-item' AND gh_number = 3 AND created_by = 'label_sync'")).rows.length, 1);
  strictEqual((await h.db.query("SELECT 1 FROM pending_sync_links")).rows.length, 0);
  strictEqual(h.applied.filter((w) => w.kind === "add_comment" || w.kind === "comment").length, 2);
  strictEqual((await h.db.query("SELECT 1 FROM audit_log WHERE kind = 'mirror_created'")).rows.length, 1);
});

test("F1/F2: Plane-to-GitHub create continues with the created number after recovery", async (t) => {
  const h = await fixture(t);
  const deps = { db: h.db, plane: h.outbox.plane, github: h.outbox.github, mapping,
    users: { planeUserIdForGithubLogin: async () => null } };
  const job = { event: "issue", payload: { action: "created", data: { id: "i", project: "p", name: "Title", labels: [{ id: "gate", name: "github" }] } } };
  for (const deliveryId of ["first", "second"]) await deliveryScope.run({ deliveryId }, () => onPlaneIssue(job, deps));
  strictEqual(h.githubQueue.jobs.size, 1);
  await h.drain();
  strictEqual(h.applied.filter((w) => w.kind === "create_issue").length, 1);
  const comment = h.applied.find((w) => w.kind === "add_comment");
  ok(comment.commentHtml.includes("o/r#7"));
  strictEqual((await h.db.query("SELECT 1 FROM sync_links WHERE gh_number = 7")).rows.length, 1);
});

test("F1: a failed link follow-up retries the saved result without creating another item", async (t) => {
  const db = await database(t), planeQueue = queue();
  let calls = 0, failLink = true, clock = Date.now();
  const wrapped: Db = { exec: db.exec.bind(db), query: async (sql, params) => {
    if (sql.includes("INSERT INTO sync_links") && failLink) { failLink = false; throw new Error("database connection interrupted"); }
    return db.query(sql, params);
  } };
  const outbox = createOrderedOutbox({ db: wrapped, now: () => clock, queues: { plane: planeQueue as any, github: queue() as any }, loadActorToken: async () => null,
    plane: { preflight: async () => {}, apply: async () => { calls++; return { ok: true, id: "created" }; } }, github: { apply: async () => ({ ok: true }) } });
  await outbox.plane.plan("stable", [
    { kind: "write", side: "plane", write: { kind: "create_issue", slug: "ws", projectId: "p", fields: { name: "new" } }, bind: "created" },
    { kind: "sync_link", link: { planeWorkspaceSlug: "ws", planeProjectId: "p", planeIssueId: resultRef("created.id"), ghRepoId: 2, ghNumber: 3, ghKind: "issue", tier: "relation", createdBy: "label_sync" } },
  ], { pendingLink: { number: 3 } });
  const job = await intentJob(db);
  await rejects(outbox.executePlane(job), OrderedWriteDeferredError);
  strictEqual(calls, 1);
  clock += 600_000;
  await outbox.executePlane(job);
  strictEqual(calls, 1);
  strictEqual((await db.query("SELECT 1 FROM sync_links")).rows.length, 1);
});
