import test from "node:test";
import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../../src/db/migrate.ts";
import { processPush, SmartCommitRetry } from "../../src/github/smart-commits.ts";
import { PlaneApiError } from "../../src/sync/plane.ts";
import { deliveryScope, queuedPlaneWriter } from "../../src/app/writers.ts";

const sha = "a".repeat(40);
const payload = { repository: { id: 1 }, sender: { login: "octo", id: 1, type: "User" },
  commits: [{ id: sha, message: "WEB-1 WEB-2 #in-review" }] };

async function setup(t: { after(fn: () => Promise<unknown>): void }) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.waitReady;
  await migrate(db);
  const jobs = new Map<string, any>();
  const applied: string[] = [];
  let pending = false;
  let failPreflight = true;
  const queue = {
    async add(_name: string, write: any, opts: any) {
      if (!jobs.has(opts.jobId)) {
        let state = pending ? "waiting" : "completed";
        if (!pending) applied.push(write.issueId);
        jobs.set(opts.jobId, { id: opts.jobId, data: write, getState: async () => state,
          complete() { if (state !== "completed") applied.push(write.issueId); state = "completed"; } });
      }
      return jobs.get(opts.jobId);
    },
    async getJob(id: string) { return jobs.get(id); },
  };
  const writer = queuedPlaneWriter({ apply: async () => ({ ok: true }), preflight: async (write: any) => {
    if (write.issueId === "WEB-2" && failPreflight) {
      failPreflight = false;
      throw new PlaneApiError(503, {}, "state lookup temporarily unavailable");
    }
  } } as any, queue as any);
  const deps = { db, writer, users: { planeUserIdForGithubLogin: async () => null },
    vault: { load: async () => null }, requireVerified: false,
    mapping: { workspaceSlug: "ws", smartCommitsEnabled: true },
    listStates: async () => [{ id: "review", name: "In Review", group: "started" }],
    resolveIssue: async (key: string) => ({ projectId: "project", issueId: key }),
    getCommitVerified: async () => true };
  return { db, jobs, applied, deps,
    pending() { pending = true; failPreflight = false; },
    run() { return deliveryScope.run({ deliveryId: "github-d1", seq: 0 }, () => processPush(payload, deps)); } };
}

test("F2: a real Smart Commit retry enqueues and applies the skipped-position target before claiming success", async (t) => {
  const h = await setup(t);
  await rejects(h.run(), SmartCommitRetry);
  deepStrictEqual(h.applied, ["WEB-1"]);
  strictEqual((await h.db.query("SELECT 1 FROM processed_commits")).rows.length, 0);
  await h.run();
  deepStrictEqual(h.applied, ["WEB-1", "WEB-2"]);
  strictEqual(h.jobs.size, 2);
  const steps = (await h.db.query<{ delivery_id: string; outcome: string }>(
    "SELECT delivery_id, outcome FROM audit_log WHERE kind = 'smart_commit_step' ORDER BY delivery_id")).rows;
  deepStrictEqual(steps, [
    { delivery_id: `sc:${sha}:0:WEB-1:t0`, outcome: "applied" },
    { delivery_id: `sc:${sha}:0:WEB-2:t0`, outcome: "applied" },
  ]);
  strictEqual((await h.db.query("SELECT 1 FROM processed_commits WHERE sha = $1", [sha])).rows.length, 1);
});

test("F2: pending outbound writes register applied steps and commit claims without waiting for the API", async (t) => {
  const h = await setup(t);
  h.pending();
  await h.run();
  deepStrictEqual(h.applied, []);
  strictEqual((await h.db.query("SELECT 1 FROM audit_log WHERE kind = 'smart_commit_step'")).rows.length, 2);
  strictEqual((await h.db.query("SELECT 1 FROM processed_commits")).rows.length, 1);
  for (const job of h.jobs.values()) job.complete();
  await h.run();
  deepStrictEqual(h.applied, ["WEB-1", "WEB-2"]);
  strictEqual(h.jobs.size, 2);
  strictEqual((await h.db.query("SELECT 1 FROM audit_log WHERE kind = 'smart_commit_step'")).rows.length, 2);
  strictEqual((await h.db.query("SELECT 1 FROM processed_commits")).rows.length, 1);
});

test("F3: a real three-commit A→B→A push registers all three commands and ends in A", async (t) => {
  const db = new PGlite(); t.after(() => db.close()); await db.waitReady; await migrate(db);
  const { createOrderedOutbox } = await import("../../src/app/writers.ts");
  const { queue, intentJob } = await import("./outbox-fixture.ts");
  const planeQueue = queue(), applied: string[] = [];
  const outbox = createOrderedOutbox({ db, queues: { plane: planeQueue as any, github: queue() as any }, loadActorToken: async () => null,
    plane: { preflight: async () => {}, apply: async (w) => { if (w.kind === "update_issue") applied.push(String(w.fields.state)); return { ok: true }; } },
    github: { apply: async () => ({ ok: true }) } });
  const push = { repository: { id: 1 }, sender: { login: "octo", id: 1, type: "User" },
    commits: ["in-progress", "done", "in-progress"].map((state, i) => ({ id: String(i + 1).repeat(40), message: `WEB-1 #${state}` })) };
  const deps = { db, writer: outbox.plane, users: { planeUserIdForGithubLogin: async () => null, planeUserIdForGithubId: async () => null },
    vault: { load: async () => null }, requireVerified: false, mapping: { workspaceSlug: "ws", smartCommitsEnabled: true },
    listStates: async () => [{ id: "A", name: "In Progress", group: "started" }, { id: "B", name: "Done", group: "completed" }],
    resolveIssue: async () => ({ projectId: "p", issueId: "i" }), getCommitVerified: async () => true };
  await deliveryScope.run({ deliveryId: "push-aba" }, () => processPush(push, deps));
  deepStrictEqual(applied, []);
  const rows = (await db.query<{ id: string }>("SELECT id FROM outbound_writes ORDER BY sequence")).rows;
  strictEqual(rows.length, 3);
  strictEqual((await db.query("SELECT 1 FROM processed_commits")).rows.length, 3);
  await deliveryScope.run({ deliveryId: "push-aba" }, () => processPush(push, deps));
  strictEqual((await db.query("SELECT 1 FROM outbound_writes")).rows.length, 3);
  for (const row of rows) await outbox.executePlane(await intentJob(db, row.id));
  deepStrictEqual(applied, ["A", "B", "A"]);
});
