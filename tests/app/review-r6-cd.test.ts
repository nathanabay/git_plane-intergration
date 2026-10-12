import test from "node:test";
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { createOutboundAuthoriser, freezeMappingAuthority, mappingsForRepo } from "../../src/app/mappings.ts";
import { handleChecks } from "../../src/app/checks.ts";
import { findLinkId, handleCreatedPr, handlePullRequest } from "../../src/app/pr.ts";
import { handleMirroredIssue, handlePendingMirroredIssue, handlePlaneIssue } from "../../src/app/issues.ts";
import { createOrderedOutbox, deliveryScope, OrderedWriteDeferredError } from "../../src/app/writers.ts";
import { appendAudit } from "../../src/db/ledgers.ts";
import { replayDelivery } from "../../src/operations/tooling.ts";
import { upsertRollupLink } from "../../src/sync/dev-info.ts";
import { PlaneApiError } from "../../src/sync/plane.ts";
import type { PlaneWritePath } from "../../src/sync/plane.ts";
import type { GithubWritePath } from "../../src/sync/github.ts";
import type { InboundJob } from "../../src/queue/index.ts";
import { ghJob, LABELS, makeHarness, planeJob, prPayload, sha } from "../a8/harness.ts";
import { intentJob, queue } from "../writers/outbox-fixture.ts";

async function fixture(rules?: string) {
  const h = await makeHarness();
  const mappingId = await h.mapping({ smartCommits: false, linkback: true, policies: { title: "last_write_wins" }, ...(rules ? { rules } : {}) });
  const mapping = (await mappingsForRepo(h.db, 555))[0]!;
  const ctx = { ...h.ctx };
  const controls = { failResume: false, resumes: 0 };
  const ordered = createOrderedOutbox({
    db: h.db, plane: h.ctx.plane as PlaneWritePath, github: h.ctx.github as GithubWritePath,
    queues: { plane: queue(), github: queue() }, loadActorToken: async () => null,
    authoriseWrite: createOutboundAuthoriser(h.db), findPlaneLinkId: (target, url) => findLinkId(ctx, target, url),
    resumeReducer: async (request) => {
      if (controls.failResume) { controls.failResume = false; throw new PlaneApiError(422, {}, "forced resume failure"); }
      controls.resumes++;
      if (request.kind === "pr_created") await handleCreatedPr(ctx, request);
      else if (request.kind === "mirror_created") await handleMirroredIssue(ctx, request);
      else await handlePendingMirroredIssue(ctx, request);
    },
  });
  ctx.plane = ordered.plane; ctx.github = ordered.github;
  const feed = (job: InboundJob) => deliveryScope.run({ deliveryId: `${job.source}-${job.writeDeliveryId ?? job.deliveryId}`,
    workspaceSlug: "ws", transportDeliveryId: job.deliveryId,
    ...(job.writeDeliveryId ? { writeDeliveryId: job.writeDeliveryId } : {}) }, () =>
    job.source === "plane" ? handlePlaneIssue(ctx, job) : handlePullRequest(ctx, job));
  const execute = async (id: string, side: "plane" | "github") => {
    const job = await intentJob(h.db, id);
    return side === "plane" ? ordered.executePlane(job) : ordered.executeGithub(job);
  };
  const drain = async () => {
    for (let round = 0; round < 40; round++) {
      const pending = (await h.db.query<{ id: string; side: "plane" | "github" }>("SELECT id, side FROM outbound_writes WHERE status = 'pending' ORDER BY sequence")).rows;
      if (!pending.length) return;
      let progress = false;
      for (const row of pending) {
        try { await execute(row.id, row.side); progress = true; }
        catch (error) { if (!(error instanceof OrderedWriteDeferredError)) throw error; }
      }
      ok(progress, "pending outbox must make progress");
    }
    throw new Error("outbox did not drain");
  };
  const replay = async (job: InboundJob) => {
    const id = await appendAudit(h.db, { kind: "inbound_delivery", source: job.source, deliveryId: job.deliveryId,
      workspaceSlug: "ws", detail: { event: job.event, payload: job.payload }, outcome: "handled" });
    return replayDelivery({ db: h.db, enqueue: feed }, id);
  };
  return { ...h, ctx, sourceMapping: mapping, mappingId, ordered, controls, feed, execute, drain, replay };
}

test("F1: production-authorized PR create continuation survives failure/replay and runs opened effects once", async () => {
  const h = await fixture("- when: pull_request.opened\n  then: [{ comment: opened-once }]\n");
  try {
    const opened = ghJob("pull_request", prPayload("opened", {}, { body: "QLL-NEW" }), "r6-pr-opened");
    await h.feed(opened);
    const registered = (await h.db.query<{ id: string; side: "plane" | "github"; write: any }>("SELECT id, side, write FROM outbound_writes ORDER BY sequence")).rows;
    const create = registered.find((r) => r.write.kind === "create_issue")!;
    const resume = registered.find((r) => r.write.kind === "resume_reducer")!;
    strictEqual(resume.side, "github");
    await h.execute(create.id, create.side);
    h.controls.failResume = true;
    await rejects(() => h.execute(resume.id, resume.side), /forced resume failure/);
    strictEqual(h.plane.createdIssueIds.length, 1);
    await h.replay(opened);
    await h.drain();
    strictEqual(h.controls.resumes, 1);
    strictEqual(h.plane.createdIssueIds.length, 1);
    strictEqual(h.plane.writes().filter((w) => w.body?.comment_html?.includes("opened-once")).length, 1);
    ok(h.plane.writes().some((w) => /\/links\/$/.test(w.path) && w.body?.title?.includes("OPEN")));
    strictEqual(h.gh.writes().filter((w) => w.route.includes("comments")).length, 1);
    await h.replay(opened); await h.drain();
    strictEqual(h.controls.resumes, 1, "replay cannot duplicate the original continuation");
  } finally { await h.close(); }
});

test("F1: a real GitHub-side pending Plane mirror event dispatches after repair, and revocation blocks its retry", async () => {
  const h = await fixture();
  try {
    const payload = (name: string, field: string) => ({ workspace_slug: "ws", action: "update",
      data: { id: "plane-i9", project: "p-qll", name, labels: [LABELS[0]], description_html: "<p>body</p>" },
      activity: { field, old_value: [], new_value: [LABELS[0]!.id], actor: { id: "human" } } });
    const optIn = planeJob("issue", payload("Initial", "label_ids"), "r6-mirror-create");
    const edit = planeJob("issue", payload("Renamed", "name"), "r6-mirror-edit");
    await h.feed(optIn); await h.feed(edit);
    const resume = (await h.db.query<{ id: string; side: "plane" | "github" }>("SELECT id, side FROM outbound_writes WHERE write->>'kind' = 'resume_reducer'")).rows[0]!;
    strictEqual(resume.side, "github");
    const prior = (await h.db.query<{ id: string; side: "plane" | "github" }>("SELECT id, side FROM outbound_writes WHERE sequence < (SELECT sequence FROM outbound_writes WHERE id = $1) ORDER BY sequence", [resume.id])).rows;
    for (const row of prior) await h.execute(row.id, row.side);
    h.controls.failResume = true;
    await rejects(() => h.execute(resume.id, resume.side), /forced resume failure/);
    await h.db.query("DELETE FROM workspace_installations WHERE installation_id = 1");
    await rejects(() => h.ordered.retryFailed(resume.id, "ws"), /not allowed|revoked/);
    strictEqual(h.controls.resumes, 0);
    await h.db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (1, 'ws')");
    await h.replay(edit); await h.drain();
    strictEqual(h.controls.resumes, 1);
    strictEqual(h.gh.writes().filter((w) => w.route.startsWith("POST") && !w.route.includes("comments")).length, 1, "one GitHub partner");
    strictEqual(h.gh.writes().filter((w) => w.route.startsWith("PATCH") && w.params.title === "Renamed").length, 1);
    await h.replay(edit); await h.drain();
    strictEqual(h.controls.resumes, 1);
  } finally { await h.close(); }
});

test("F2 validation: frozen authority works before any SHA claim and cannot follow mapping edits or other grants", async () => {
  const h = await fixture();
  try {
    const authorise = createOutboundAuthoriser(h.db);
    const authority = freezeMappingAuthority(h.sourceMapping);
    const write = { kind: "add_comment" as const, slug: "ws", projectId: "another-project", issueId: "command-target",
      commentHtml: "one", _smartCommit: { sha: sha("a") }, _authority: authority };
    strictEqual((await h.db.query("SELECT 1 FROM processed_commits")).rows.length, 0);
    await authorise("plane", write, "ws");
    await deliveryScope.run({ deliveryId: "before-claim", workspaceSlug: "ws", authority }, () => h.ordered.plane.apply(write));
    const intent = await intentJob(h.db);
    await h.ordered.executePlane(intent);
    strictEqual(h.plane.writes().filter((w) => w.body?.comment_html === "one").length, 1);
    strictEqual((await h.db.query("SELECT 1 FROM processed_commits")).rows.length, 0, "completion claim is not needed for authorization");
    await rejects(() => authorise("plane", { ...write, _authority: null }, "ws"), /revoked/);
    await rejects(() => authorise("plane", write, undefined), /revoked/);
    await rejects(() => authorise("plane", { ...write, slug: "elsewhere" }, "ws"), /revoked/);
    await h.mapping({ repoId: 666, projectId: "another-project", installationId: 2 });
    await h.db.query("UPDATE repo_mappings SET gh_repo_id = 666 WHERE id = $1", [h.mappingId]);
    await rejects(() => authorise("plane", write, "ws"), /revoked/);
    await h.db.query("UPDATE repo_mappings SET gh_repo_id = 555, installation_id = 2 WHERE id = $1", [h.mappingId]);
    await rejects(() => authorise("plane", write, "ws"), /revoked/);
    await h.db.query("UPDATE repo_mappings SET installation_id = 1 WHERE id = $1", [h.mappingId]);
    await h.db.query("UPDATE workspace_installations SET workspace_slug = 'elsewhere' WHERE installation_id = 1");
    await rejects(() => authorise("plane", write, "ws"), /not allowed/);
    await h.db.query("DELETE FROM repo_mappings WHERE id = $1", [h.mappingId]);
    await rejects(() => authorise("plane", write, "ws"), /revoked/);
  } finally { await h.close(); }
});

test("F4: moved-installation check/deploy rollups keep old links but target only the newly authorized workspace", async () => {
  const h = await fixture();
  try {
    await h.link("old-target", 12, { kind: "pr", slug: "ws", project: "p-qll" });
    await h.db.query("UPDATE sync_links SET created_by = 'magic_word' WHERE plane_issue_id = 'old-target'");
    await h.mapping({ repoId: 666, installationId: 2, projectId: "p-qll" }); // unrelated repo still authorizes the old target project
    await h.db.query("DELETE FROM repo_mappings WHERE id = $1", [h.mappingId]);
    await h.db.query("UPDATE workspace_installations SET workspace_slug = 'new' WHERE installation_id = 1");
    const newId = await h.mapping({ slug: "new", projectId: "p-new", installationId: 1 });
    await h.link("new-target", 12, { kind: "pr", slug: "new", project: "p-new" });
    const head = sha("b");
    h.gh.respond(/\/check-runs$/, () => ({ check_runs: [{ status: "completed", conclusion: "success" }] }));
    h.gh.respond(/\/commits\/\{commit_sha\}\/pulls$/, () => [{ number: 12 }]);
    await handleChecks(h.ctx, ghJob("check_run", { action: "completed", check_run: { head_sha: head, pull_requests: [{ number: 12 }] } }));
    await handleChecks(h.ctx, ghJob("deployment_status", { deployment: { sha: head, environment: "preview" },
      deployment_status: { state: "success", environment: "preview", environment_url: "https://app.vercel.app" } }));
    const intents = (await h.db.query<{ write: any }>("SELECT write FROM outbound_writes WHERE write->>'kind' = 'upsert_rollup' ORDER BY sequence")).rows;
    strictEqual(intents.length, 3, "build, deployment, preview");
    for (const { write } of intents) {
      strictEqual(write.slug, "new"); strictEqual(write.issueId, "new-target");
      deepStrictEqual(write._authority, { workspaceSlug: "new", mappingId: String(newId), repoId: 555, installationId: 1 });
    }
    strictEqual((await h.db.query("SELECT 1 FROM sync_links WHERE plane_issue_id = 'old-target'")).rows.length, 1, "foreign control link remains");
    await h.drain();
    strictEqual(h.plane.writes().filter((w) => /\/links\//.test(w.path)).length, 3);
    ok(h.plane.writes().every((w) => w.path.includes("/workspaces/new/") && !w.path.includes("old-target")));
    // Queue a fresh rollup then remove its actual source; the unrelated target grant cannot replace it.
    const target = { slug: "new", projectId: "p-new", issueId: "new-target", _authority: intents[0]!.write._authority };
    await upsertRollupLink({ db: h.db, writer: h.ctx.plane }, target, "queued-before-revocation", { title: "latest", url: "https://example.test/latest" });
    const pending = await intentJob(h.db);
    await h.mapping({ slug: "new", repoId: 777, projectId: "p-new", installationId: 3 });
    await h.db.query("DELETE FROM repo_mappings WHERE id = $1", [newId]);
    const count = h.plane.writes().length;
    await rejects(() => h.ordered.executePlane(pending), /revoked/);
    strictEqual(h.plane.writes().length, count);
  } finally { await h.close(); }
});

test("F1: legacy continuations authorize before destination-side checks and still require their stored workspace", async () => {
  const h = await fixture();
  try {
    const authorise = createOutboundAuthoriser(h.db);
    const continuation = { kind: "resume_reducer", continuation: { mappingId: h.mappingId, workspaceSlug: "ws" } };
    await authorise("github", continuation, "ws"); await authorise("plane", continuation, "ws");
    await rejects(() => authorise("github", { ...continuation, continuation: { ...continuation.continuation, workspaceSlug: "other" } }, "ws"), /revoked/);
    await rejects(() => authorise("github", { kind: "comment", repoId: 555 }, "ws"), /not allowed/);
    await h.db.query("DELETE FROM workspace_installations WHERE installation_id = 1");
    await rejects(() => authorise("github", continuation, "ws"), /not allowed/);
  } finally { await h.close(); }
});
