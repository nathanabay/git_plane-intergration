import test from "node:test";
import type { TestContext } from "node:test";
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { createOrderedOutbox } from "../../src/app/writers.ts";
import { OrderedWriteDeferredError } from "../../src/operations/outbox.ts";
import { handleMirroredIssue, handlePendingMirroredIssue } from "../../src/app/issues.ts";
import { handleCreatedPr } from "../../src/app/pr.ts";
import { replayDelivery, restoreCreateWorkflow } from "../../src/operations/tooling.ts";
import type { ReplayJob } from "../../src/operations/tooling.ts";
import { nextCreateGeneration } from "../../src/sync/mirror.ts";
import { PlaneApiError } from "../../src/sync/plane.ts";
import { reconcileOnce } from "../../src/sync/reconcile.ts";
import { ghJob, makeHarness, prPayload } from "../a8/harness.ts";
import { intentJob, queue } from "../writers/outbox-fixture.ts";
import type { InboundJob } from "../../src/queue/index.ts";

const mirrorJob = () => ghJob("issues", { action: "labeled", label: { name: "plane" },
  issue: { number: 41, title: "Mirror me", state: "open", labels: [{ name: "plane" }], assignees: [] } });
const prJob = () => ghJob("pull_request", prPayload("opened", {}, { body: "QLL-NEW", title: "Create me" }));

async function fixture(t: TestContext, kind: "mirror" | "pr" = "mirror", maxAttempts = 1) {
  const h = await makeHarness();
  t.after(() => h.close());
  await h.mapping({ smartCommits: false, rules: `- when: ${kind === "mirror" ? "issue.labeled" : "pull_request.opened"}\n  then: [{comment: original-rule}]\n` });
  const controls = { failGithubComment: false, failResume: false, resumeCalls: 0 };
  const rawPlane = h.ctx.plane, rawGithub = h.ctx.github;
  const outbox = createOrderedOutbox({ db: h.db, plane: rawPlane as any,
    github: { apply: async (write, ...args) => {
      if (controls.failGithubComment && write.kind === "comment") throw new PlaneApiError(422, {}, "cross-link rejected");
      return rawGithub.apply(write, ...args);
    } },
    maxAttempts, queues: { plane: queue() as any, github: queue() as any }, loadActorToken: async () => null,
    resumeReducer: async (request) => {
      if (controls.failResume) throw new PlaneApiError(422, {}, "resume unavailable");
      controls.resumeCalls++;
      if (request.kind === "pr_created") return handleCreatedPr(h.ctx, request);
      if (request.kind === "mirror_pending") return handlePendingMirroredIssue(h.ctx, request);
      return handleMirroredIssue(h.ctx, request);
    } });
  h.ctx.plane = outbox.plane; h.ctx.github = outbox.github;
  const next = async () => (await h.db.query<{ id: string; side: string }>(
    "SELECT id, side FROM outbound_writes WHERE status = 'pending' ORDER BY sequence LIMIT 1")).rows[0];
  const execute = async () => {
    const row = await next();
    ok(row, "a pending intent exists");
    const job = await intentJob(h.db, row.id);
    return row.side === "plane" ? outbox.executePlane(job) : outbox.executeGithub(job);
  };
  const drain = async () => {
    for (let n = 0; n < 60; n++) { if (!(await next())) return; await execute(); }
    throw new Error("workflow did not drain within 60 intents");
  };
  const replay = async (job: InboundJob) => {
    const audit = (await h.db.query<{ id: string }>("SELECT id FROM audit_log WHERE kind = 'inbound_delivery' AND delivery_id = $1 ORDER BY id LIMIT 1", [job.deliveryId])).rows[0];
    ok(audit);
    let queued: ReplayJob | undefined;
    await replayDelivery({ db: h.db, enqueue: async (j) => { queued = j; } }, audit.id);
    ok(queued);
    strictEqual(await h.feed(queued), "handled");
  };
  return { h, controls, outbox, next, execute, drain, replay };
}

test("F1: UI replay through the real mirror reducer repairs the cross-link and original rule continuation", async (t) => {
  const { h, controls, execute, next, drain, replay } = await fixture(t);
  const original = mirrorJob();
  strictEqual(await h.feed(original), "handled");
  while ((await next())?.side === "plane") await execute();
  strictEqual(h.plane.createdIssueIds.length, 1);
  const successful = (await h.db.query<any>("SELECT id, write, result FROM outbound_writes WHERE status = 'applied' ORDER BY sequence")).rows;
  controls.failGithubComment = true;
  await rejects(execute(), /cross-link rejected/);
  strictEqual((await h.db.query<any>("SELECT 1 FROM pending_sync_links")).rows.length, 0);
  controls.failGithubComment = false;
  await replay(original);
  strictEqual((await h.db.query<any>("SELECT 1 FROM outbound_writes WHERE write->'continuation'->>'kind' = 'mirror_pending'")).rows.length, 0);
  await drain();
  deepStrictEqual((await h.db.query<any>("SELECT id, write, result FROM outbound_writes WHERE id = ANY($1::text[]) ORDER BY sequence", [successful.map((r) => r.id)])).rows, successful);
  strictEqual(h.plane.createdIssueIds.length, 1);
  strictEqual(controls.resumeCalls, 1);
  strictEqual(h.gh.writes().filter((w) => w.route.includes("/comments")).length, 1);
  strictEqual(h.plane.writes().filter((w) => w.body?.comment_html === "<p>original-rule</p>").length, 1);
  await replay(original); await drain();
  strictEqual(h.plane.createdIssueIds.length, 1);
  strictEqual(h.plane.writes().filter((w) => w.body?.comment_html === "<p>original-rule</p>").length, 1);
});

test("F1: UI replay through the real PR reducer restores the failed original continuation after created audit", async (t) => {
  const { h, controls, execute, drain, replay } = await fixture(t, "pr");
  const original = prJob();
  await h.feed(original); await execute();
  strictEqual((await h.audit("pr_create_request")).filter((r) => r.outcome === "created").length, 1);
  controls.failResume = true;
  await rejects(execute(), /resume unavailable/);
  controls.failResume = false;
  await replay(original); await drain();
  strictEqual(h.plane.createdIssueIds.length, 1);
  strictEqual(controls.resumeCalls, 1, "the original delivery must have exactly one continuation");
  strictEqual(h.plane.writes().filter((w) => w.body?.comment_html === "<p>original-rule</p>").length, 1);
  strictEqual(h.plane.writes().filter((w) => /\/links\/$/.test(w.path)).length, 1);
});

for (const kind of ["mirror", "pr"] as const) {
  test(`F2: ${kind} re-opt-in recovers a committed-but-unacknowledged POST using its original external_id`, async (t) => {
    const { h, execute, next, drain, replay } = await fixture(t, kind, 2);
    const job = kind === "mirror" ? mirrorJob() : prJob();
    const request = h.ctx.planeClient.request.bind(h.ctx.planeClient);
    let lost = false, unavailable = true;
    const lookups: string[] = [];
    h.ctx.planeClient.request = async <T>(...args: Parameters<typeof request>): Promise<T> => {
      const [method, path] = args;
      if (method === "GET" && path.includes("external_id=")) {
        lookups.push(new URL(path, "http://plane.test").searchParams.get("external_id")!);
        if (lost && unavailable) throw new PlaneApiError(503, {}, "recovery lookup unavailable");
      }
      const result = await request<T>(...args);
      if (!lost && method === "POST" && /\/issues\/$/.test(path)) { lost = true; throw new Error("response lost after commit"); }
      return result;
    };
    await h.feed(job);
    while (true) {
      const row = await next(); ok(row);
      const write = (await h.db.query<any>("SELECT write FROM outbound_writes WHERE id = $1", [row.id])).rows[0]!.write;
      if (write.kind === "create_issue") break;
      await execute();
    }
    const createId = (await next())!.id;
    await rejects(execute(), OrderedWriteDeferredError);
    strictEqual((await h.db.query<any>("SELECT error FROM outbound_writes WHERE id = $1", [createId])).rows[0]!.error.message, "response lost after commit");
    await h.db.query<any>("UPDATE outbound_writes SET retry_at = NULL WHERE id = $1", [createId]);
    await rejects(execute(), /recovery lookup unavailable/);
    strictEqual((await h.db.query<any>("SELECT status FROM outbound_writes WHERE id = $1", [createId])).rows[0]!.status, "failed");
    strictEqual((await h.db.query<any>("SELECT 1 FROM sync_links")).rows.length, 0);
    const ids = (await h.db.query<any>("SELECT id, write, result FROM outbound_writes ORDER BY sequence")).rows;
    const reopt = kind === "mirror" ? mirrorJob() : ghJob("pull_request", prPayload("edited", {}, { body: "QLL-NEW", title: "Create me" }));
    await h.feed(reopt);
    deepStrictEqual((await h.db.query<any>("SELECT id, write, result FROM outbound_writes WHERE id = ANY($1::text[]) ORDER BY sequence", [ids.map((r) => r.id)])).rows, ids, "re-opt-in retains the original workflow rows");
    const added = (await h.db.query<any>("SELECT write FROM outbound_writes WHERE NOT (id = ANY($1::text[]))", [ids.map((r) => r.id)])).rows;
    ok(added.every((r) => r.write.kind === "resume_reducer" && r.write._plan.root === createId), "a fresh event may join the original root, but cannot create a new partner");
    if (kind === "pr") {
      // Round-6 F5 retains the edited event but leaves terminal PR creates failed until explicit repair.
      strictEqual(await next(), undefined, "a PR edit must not implicitly retry an ambiguous terminal create");
      strictEqual(added.length, 1, "the edit remains durably attached to the original create identity");
      ok((await h.db.query<any>("SELECT status FROM outbound_writes")).rows.every((r) => r.status === "failed"));
      await replay(job);
    }
    await rejects(execute(), OrderedWriteDeferredError);
    strictEqual((await h.db.query<any>("SELECT error FROM outbound_writes WHERE id = $1", [createId])).rows[0]!.error.message, "recovery lookup unavailable");
    strictEqual(h.plane.createdIssueIds.length, 1, "lookup outage never advances to a second POST");
    // Explicit replay also keeps the same root while recovery remains unavailable.
    await replay(job);
    unavailable = false;
    await h.db.query<any>("UPDATE outbound_writes SET retry_at = NULL WHERE status = 'pending'");
    await drain();
    strictEqual(h.plane.createdIssueIds.length, 1);
    ok(lookups.length >= 4);
    ok(lookups.every((id) => id === createId));
    strictEqual((await h.db.query<any>("SELECT plane_issue_id FROM sync_links WHERE status = 'active'")).rows[0]!.plane_issue_id, h.plane.createdIssueIds[0]);
    strictEqual(h.plane.writes().filter((w) => w.body?.comment_html === "<p>original-rule</p>").length, 1);
  });
}

test("F2: a saved create result survives failure during local linking and re-opt-in without a second POST", async (t) => {
  const { h, execute, drain } = await fixture(t);
  const query = h.db.query.bind(h.db);
  let failLink = true;
  h.db.query = (async (...args: Parameters<typeof query>) => {
    if (failLink && /INSERT INTO sync_links/.test(args[0])) throw new Error("link transaction failed");
    return query(...args);
  }) as typeof h.db.query;
  await h.feed(mirrorJob()); await execute();
  await rejects(execute(), /link transaction failed/);
  const saved = (await query<any>("SELECT id, result FROM outbound_writes WHERE write->>'kind' = 'create_issue'")).rows[0]!;
  ok(saved.result?.id);
  failLink = false;
  await h.feed(mirrorJob()); await drain();
  strictEqual(h.plane.createdIssueIds.length, 1);
  deepStrictEqual((await query<any>("SELECT id, result FROM outbound_writes WHERE write->>'kind' = 'create_issue'")).rows[0], saved);
});

test("F2: successful but unlinked workflow cannot advance; confirmed orphan can get a replacement", async (t) => {
  const { h, drain } = await fixture(t);
  const key = "create:gh:ws:555#41:p-qll";
  await h.feed(mirrorJob()); await drain();
  const link = (await h.db.query<any>("SELECT * FROM sync_links")).rows[0]!;
  await h.db.query<any>("DELETE FROM sync_links");
  strictEqual(await nextCreateGeneration(h.db, key), null, "absence of a local link is not proof of a deleted remote partner");
  await h.db.query<any>(`INSERT INTO sync_links (plane_workspace_slug, plane_project_id, plane_issue_id, gh_repo_id,
    gh_number, gh_kind, tier, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
  [link.plane_workspace_slug, link.plane_project_id, link.plane_issue_id, link.gh_repo_id, link.gh_number, link.gh_kind, link.tier, link.created_by]);
  strictEqual((await reconcileOnce({ db: h.db, plane: h.ctx.planeClient })).orphaned, 1);
  await h.feed(mirrorJob()); await drain();
  strictEqual(h.plane.createdIssueIds.length, 2);
});

test("F1/F2: restoring an older failed workflow rejects a newer object's barrier and rolls back", async (t) => {
  const { h, controls, execute, next } = await fixture(t);
  await h.feed(mirrorJob());
  const marker = (await h.db.query<any>("SELECT * FROM pending_sync_links")).rows[0]!;
  while ((await next())?.side === "plane") await execute();
  controls.failGithubComment = true; await rejects(execute());
  await h.db.query(`INSERT INTO outbound_writes (id, side, target_key, write, status)
    SELECT 'newer-root', side, target_key, write, 'applied' FROM outbound_writes WHERE id = $1`, [marker.outbox_id]);
  await h.db.query<any>("INSERT INTO pending_sync_links (key,outbox_id,link) VALUES ($1,'newer-root',$2::jsonb)", [marker.key, JSON.stringify(marker.link)]);
  await rejects(restoreCreateWorkflow(h.db, marker.outbox_id), /newer create workflow/);
  strictEqual((await h.db.query<any>("SELECT 1 FROM outbound_writes WHERE status = 'pending'")).rows.length, 0);
});

test("F2: confirmed orphan of a saved partner permits replacement even when its old tail failed", async (t) => {
  const { h, controls, execute, next, drain } = await fixture(t);
  await h.feed(mirrorJob());
  while ((await next())?.side === "plane") await execute();
  controls.failGithubComment = true; await rejects(execute());
  strictEqual((await reconcileOnce({ db: h.db, plane: h.ctx.planeClient })).orphaned, 1);
  controls.failGithubComment = false;
  await h.feed(mirrorJob()); await drain();
  strictEqual(h.plane.createdIssueIds.length, 2);
  strictEqual((await h.db.query<any>("SELECT 1 FROM sync_links WHERE status = 'active'")).rows.length, 1);
});

test("F2: retention of an unresolved failed generation cannot authorize a fresh identity", async (t) => {
  const { h, controls, execute, next } = await fixture(t);
  await h.feed(mirrorJob());
  while ((await next())?.side === "plane") await execute();
  controls.failGithubComment = true; await rejects(execute());
  await h.db.query("DELETE FROM sync_links");
  await h.db.query("DELETE FROM outbound_writes");
  strictEqual(await nextCreateGeneration(h.db, "create:gh:ws:555#41:p-qll"), null);
  await h.feed(mirrorJob());
  strictEqual((await h.db.query<any>("SELECT 1 FROM outbound_writes")).rows.length, 0);
  strictEqual(h.plane.createdIssueIds.length, 1);
});
