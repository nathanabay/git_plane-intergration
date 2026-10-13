import test from "node:test";
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { findLinkId, handleCreatedPr, handlePullRequest } from "../../src/app/pr.ts";
import { handleChecks } from "../../src/app/checks.ts";
import { linkedIssuesFor } from "../../src/app/rules.ts";
import { mappingsForRepo } from "../../src/app/mappings.ts";
import { createOrderedOutbox, deliveryScope, OrderedWriteDeferredError } from "../../src/app/writers.ts";
import { reconcileOnce } from "../../src/sync/reconcile.ts";
import type { ReconcilePlane } from "../../src/sync/reconcile.ts";
import { PlaneApiError } from "../../src/sync/plane.ts";
import type { PlaneClient } from "../../src/sync/plane.ts";
import { appendAudit } from "../../src/db/ledgers.ts";
import { replayDelivery } from "../../src/operations/tooling.ts";
import { ghJob, makeHarness, prPayload, sha } from "../a8/harness.ts";
import type { InboundJob } from "../../src/queue/index.ts";
import { queue } from "../writers/outbox-fixture.ts";

/**
 * A2 (docs audit): a single 404 no longer orphans a link; Plane must show the item was deleted (or a second
 * sweep must agree). "Actual orphaning" here means the Plane item was deleted: the real client answers the
 * 404 and the project read, and its activities record the delete.
 */
const deletedInPlane = (client: PlaneClient): ReconcilePlane => ({
  getIssue: client.getIssue.bind(client),
  getProject: client.getProject.bind(client),
  listIssueIds: client.listIssueIds.bind(client),
  listIssueActivities: async () => [{ verb: "deleted", field: "issue", created_at: new Date().toISOString() }],
});

async function harness(rules?: string) {
  const h = await makeHarness();
  await h.mapping({ smartCommits: false, linkback: true, ...(rules ? { rules } : {}) });
  const ctx = { ...h.ctx };
  const planeQ = queue(), githubQ = queue();
  let failNextResume = false;
  const ordered = createOrderedOutbox({ db: h.db, plane: h.ctx.plane as any, github: h.ctx.github as any,
    queues: { plane: planeQ as any, github: githubQ as any }, loadActorToken: async () => null,
    findPlaneLinkId: (target, url) => findLinkId(ctx, target, url), resumeReducer: (request) => {
      if (failNextResume) { failNextResume = false; throw new PlaneApiError(422, {}, "forced permanent continuation failure"); }
      return handleCreatedPr(ctx, request);
    } });
  ctx.plane = ordered.plane; ctx.github = ordered.github;
  const feed = (job: InboundJob) => deliveryScope.run({ deliveryId: `github-${job.writeDeliveryId ?? job.deliveryId}`,
    transportDeliveryId: job.deliveryId, workspaceSlug: "ws", ...(job.writeDeliveryId ? { writeDeliveryId: job.writeDeliveryId } : {}) }, () => handlePullRequest(ctx, job));
  async function drain() {
    for (let round = 0; round < 40; round++) {
      const before = Number((await h.db.query<any>("SELECT count(*) AS n FROM outbound_writes WHERE status = 'applied'")).rows[0].n);
      for (const [side, q] of [["plane", planeQ], ["github", githubQ]] as const) {
        for (const job of q.jobs.values()) {
          try { await (side === "plane" ? ordered.executePlane(job) : ordered.executeGithub(job)); }
          catch (err) { if (!(err instanceof OrderedWriteDeferredError)) throw err; }
        }
      }
      const pending = (await h.db.query("SELECT id FROM outbound_writes WHERE status <> 'applied'")).rows;
      if (pending.length === 0) return;
      const after = Number((await h.db.query<any>("SELECT count(*) AS n FROM outbound_writes WHERE status = 'applied'")).rows[0].n);
      ok(after > before, `outbox stalled with ${pending.length} unfinished intents`);
    }
    throw new Error("outbox did not drain");
  }
  return { ...h, ctx, ordered, planeQ, githubQ, feed, drain, failResume() { failNextResume = true; } };
}

test("F1 seam: replayDelivery revives a failed PR create continuation without appending another original event", async () => {
  const h = await harness("- when: pull_request.opened\n  then: [{ comment: original-rule-once }]\n");
  try {
    const opened = ghJob("pull_request", prPayload("opened", {}, { body: "QLL-NEW" }), "failed-original");
    const auditId = await appendAudit(h.db, { kind: "inbound_delivery", source: opened.source, deliveryId: opened.deliveryId,
      workspaceSlug: "ws", detail: { event: opened.event, payload: opened.payload }, outcome: "handled" });
    await h.feed(opened);
    await h.ordered.executePlane([...h.planeQ.jobs.values()][0]);
    h.failResume();
    await rejects(h.ordered.executeGithub([...h.githubQ.jobs.values()][0]), /forced permanent continuation failure/);
    strictEqual((await h.db.query("SELECT 1 FROM pending_sync_links")).rows.length, 0);
    const old = (await h.db.query<any>("SELECT id, status, result FROM outbound_writes ORDER BY sequence")).rows;
    deepStrictEqual(old.map((r) => r.status), ["applied", "failed"]);
    strictEqual(h.plane.createdIssueIds.length, 1);
    await replayDelivery({ db: h.db, enqueue: async (job) => h.feed(job) }, auditId);
    const restored = (await h.db.query<any>("SELECT id, status, result FROM outbound_writes ORDER BY sequence")).rows;
    deepStrictEqual(restored.map((r) => r.id), old.map((r) => r.id), "reducer replay did not append an extra continuation");
    deepStrictEqual(restored[0].result, old[0].result, "saved successful create result is preserved");
    deepStrictEqual(restored.map((r) => r.status), ["applied", "pending"]);
    await h.drain();
    strictEqual(h.plane.createdIssueIds.length, 1);
    strictEqual(h.plane.writes().filter((c) => c.body?.comment_html?.includes("original-rule-once")).length, 1);
    strictEqual(h.gh.writes().filter((c) => /comments/.test(c.route)).length, 1);
  } finally { await h.close(); }
});

test("F4: actual orphaning permits one replacement and duplicate/replayed requests preserve it", async () => {
  const h = await harness();
  try {
    await h.feed(ghJob("pull_request", prPayload("opened", {}, { body: "QLL-NEW" }), "create-original"));
    await h.drain();
    strictEqual(h.plane.createdIssueIds.length, 1);
    await h.feed(ghJob("pull_request", prPayload("edited", {}, { body: "QLL-NEW" })));
    await h.drain();
    strictEqual(h.plane.createdIssueIds.length, 1, "active partner is the once-only guard");
    deepStrictEqual(await reconcileOnce({ db: h.db, plane: deletedInPlane(h.ctx.planeClient) }), { checked: 1, orphaned: 1, archived: 0, errors: 0 });
    await h.feed({ ...ghJob("pull_request", prPayload("opened", {}, { body: "QLL-NEW" }), "replay-original-after-orphan"), writeDeliveryId: "create-original" });
    await h.drain();
    strictEqual(h.plane.createdIssueIds.length, 1, "replaying a completed old request cannot create a replacement");
    const request = ghJob("pull_request", prPayload("edited", {}, { body: "QLL-NEW" }), "replacement");
    await h.feed(request);
    await h.feed({ ...request, deliveryId: "replay-replacement", writeDeliveryId: request.deliveryId });
    await h.drain();
    strictEqual(h.plane.createdIssueIds.length, 2);
    const links = (await h.db.query<any>("SELECT status, plane_issue_id FROM sync_links ORDER BY id")).rows;
    deepStrictEqual(links.map((l) => l.status), ["orphaned", "active"]);
    strictEqual(links[1].plane_issue_id, h.plane.createdIssueIds[1]);
    await h.feed({ ...request, deliveryId: "replay-completed", writeDeliveryId: request.deliveryId });
    await h.drain();
    strictEqual(h.plane.createdIssueIds.length, 2);
  } finally { await h.close(); }
});

test("F4: a pruned completed workflow still gives a confirmed orphan a distinct replacement identity", async () => {
  const h = await harness();
  try {
    await h.feed(ghJob("pull_request", prPayload("opened", {}, { body: "WEB-NEW" })));
    await h.drain();
    const oldIntent = h.plane.writes().find((c) => c.body?.external_id)?.body.external_id;
    await reconcileOnce({ db: h.db, plane: deletedInPlane(h.ctx.planeClient) });
    await h.db.query("DELETE FROM outbound_writes");
    h.planeQ.jobs.clear(); h.githubQ.jobs.clear();
    await h.feed(ghJob("pull_request", prPayload("edited", {}, { body: "WEB-NEW" })));
    await h.drain();
    strictEqual(h.plane.createdIssueIds.length, 2);
    const creates = h.plane.writes().filter((c) => c.method === "POST" && /\/work-items\/$/.test(c.path));
    ok(creates[1]!.body.external_id !== oldIntent);
  } finally { await h.close(); }
});

const targetRules = `
- when: pull_request.approved
  if: { project: p-web }
  then: [{ comment: approved-other-project }]
- when: pull_request.ready_for_merge
  if: { project: p-web }
  then: [{ comment: ready-other-project }]
- when: check_suite.success
  if: { project: p-web }
  then: [{ comment: checked-other-project }]
- when: pull_request.merged
  if: { project: p-qll }
  then: [{ comment: wrong-project }]
- when: pull_request.merged
  if: { project: p-web }
  then: [{ set_state: Done }]
`;

test("F5: real cross-project -NEW follows approval, check readiness and merge in its target project", async () => {
  const h = await harness(targetRules);
  try {
    const head = { sha: sha("a"), ref: "feature" };
    const pr = { body: "WEB-NEW", title: "Ship", head };
    h.gh.respond(/pulls\/\{pull_number\}$/, () => (prPayload("opened", {}, pr) as any).pull_request);
    h.gh.respond(/\/reviews$/, () => [{ state: "APPROVED", user: { id: 9, login: "reviewer" } }]);
    h.gh.respond(/\/check-suites$/, () => ({ total_count: 1, check_suites: [{ status: "completed", conclusion: "success" }] }));
    h.gh.respond(/\/status$/, () => ({ state: "success", total_count: 1 }));
    h.gh.respond(/\/check-runs$/, () => ({ total_count: 1, check_runs: [{ status: "completed", conclusion: "success" }] }));
    h.gh.respond(/\/commits\/\{commit_sha\}\/pulls$/, () => [(prPayload("opened", {}, pr) as any).pull_request]);
    await h.feed(ghJob("pull_request", prPayload("opened", {}, pr)));
    await h.drain();
    const id = h.plane.createdIssueIds[0]!;
    // Foreign-workspace links are never targets of the mapping's lifecycle/readiness rules.
    await h.link("foreign", 12, { kind: "pr", slug: "elsewhere", project: "p-web", tier: "closing" });
    const mapping = (await mappingsForRepo(h.db, 555))[0]!;
    deepStrictEqual((await linkedIssuesFor(h.ctx, mapping, "pr", 12)).map((i) => [i.slug, i.projectId, i.issueId]), [["ws", "p-web", id]]);
    await h.feed(ghJob("pull_request_review", prPayload("submitted", { review: { state: "approved" } }, pr)));
    await h.drain();
    // Remove the control link before the checks reducer, whose unowned linkedTargets query needs
    // the driver's workspace-filter handoff (documented in the CA report).
    await h.db.query("DELETE FROM sync_links WHERE plane_issue_id = 'foreign'");
    await deliveryScope.run({ deliveryId: "check", workspaceSlug: "ws" }, () => handleChecks(h.ctx, ghJob("check_suite", {
      action: "completed", check_suite: { head_sha: head.sha, conclusion: "success", pull_requests: [{ number: 12 }] } })));
    await h.drain();
    await h.feed(ghJob("pull_request", prPayload("closed", {}, { ...pr, state: "closed", merged: true })));
    await h.drain();
    const writes = h.plane.writes();
    for (const text of ["approved-other-project", "ready-other-project", "checked-other-project"]) ok(writes.some((c) => c.body?.comment_html?.includes(text)), text);
    ok(!writes.some((c) => c.body?.comment_html?.includes("wrong-project")));
    ok(writes.some((c) => c.path.includes(`/p-web/work-items/${id}/`) && c.body?.state === "s-done"));
    ok(writes.some((c) => c.path.includes(`/p-web/work-items/${id}/links/`) && c.body?.title?.includes("MERGED")));
    ok(writes.every((c) => !c.path.includes("foreign")));
  } finally { await h.close(); }
});

test("F6: opened, edited, approved and merged before draining retain ordered rules and final MERGED rollup", async () => {
  const h = await harness(`
- when: pull_request.opened
  then: [{ comment: opened-once }, { set_state: In Progress }]
- when: pull_request.approved
  then: [{ comment: approved-once }, { set_state: In Review }]
- when: pull_request.merged
  then: [{ comment: merged-once }, { set_state: Done }]
`);
  try {
    const pr = { body: "WEB-NEW", title: "Initial title" };
    const opened = ghJob("pull_request", prPayload("opened", {}, pr), "early-opened");
    await h.feed(opened);
    const edited = ghJob("pull_request", prPayload("edited", {}, { ...pr, title: "Edited title" }), "early-edited");
    await h.feed(edited);
    await h.feed({ ...edited, deliveryId: "replay-early-edited", writeDeliveryId: edited.deliveryId });
    await h.feed(ghJob("pull_request_review", prPayload("submitted", { review: { state: "approved" } }, pr), "early-approved"));
    await h.feed(ghJob("pull_request", prPayload("closed", {}, { ...pr, merged: true, state: "closed" }), "early-merged"));
    strictEqual(h.plane.createdIssueIds.length, 0);
    const continuations = (await h.db.query<any>("SELECT write FROM outbound_writes WHERE write->>'kind' = 'resume_reducer' ORDER BY sequence")).rows;
    deepStrictEqual(continuations.map((r) => r.write.continuation.job.deliveryId), ["early-opened", "early-edited", "early-approved", "early-merged"]);
    await h.drain();
    strictEqual(h.plane.createdIssueIds.length, 1);
    const comments = h.plane.writes().filter((c) => c.body?.comment_html).map((c) => c.body.comment_html);
    for (const text of ["opened-once", "approved-once", "merged-once"]) strictEqual(comments.filter((c) => c.includes(text)).length, 1, text);
    deepStrictEqual(h.plane.writes().filter((c) => c.method === "PATCH" && c.body?.state).map((c) => c.body.state), ["s-prog", "s-review", "s-done"]);
    const rollups = h.plane.writes().filter((c) => /\/links\//.test(c.path));
    ok(rollups.at(-1)?.body.title.includes("MERGED"));
    ok(rollups.some((c) => c.body?.title?.includes("Edited title")));
    strictEqual((await h.db.query("SELECT 1 FROM pending_sync_links")).rows.length, 0);
    strictEqual(h.gh.writes().filter((c) => /comments/.test(c.route)).length, 1, "linkback belongs only to the original continuation");
  } finally { await h.close(); }
});

test("F6: a merge arriving after the create linked but before its original continuation stays fenced", async () => {
  const h = await harness();
  try {
    await h.feed(ghJob("pull_request", prPayload("opened", {}, { body: "QLL-NEW" })));
    await h.ordered.executePlane([...h.planeQ.jobs.values()][0]);
    strictEqual((await h.db.query("SELECT 1 FROM sync_links WHERE status = 'active'")).rows.length, 1);
    await h.feed(ghJob("pull_request", prPayload("closed", {}, { body: "QLL-NEW", merged: true, state: "closed" })));
    strictEqual(h.plane.writes().filter((c) => c.method === "PATCH").length, 0, "merge did not bypass the opened continuation");
    await h.drain();
    deepStrictEqual(h.plane.writes().filter((c) => c.method === "PATCH" && c.body?.state).map((c) => c.body.state), ["s-prog", "s-done"]);
    ok(h.plane.writes().filter((c) => /\/links\//.test(c.path)).at(-1)?.body.title.includes("MERGED"));
  } finally { await h.close(); }
});
