import test from "node:test";
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { linkbackOnOrphan } from "../../src/app/main.ts";
import { createOutboundAuthoriser, mappingForOrphanLink } from "../../src/app/mappings.ts";
import { handleMirroredIssue, handlePendingMirroredIssue, handlePlaneIssue } from "../../src/app/issues.ts";
import { findLinkId, handleCreatedPr, handlePullRequest } from "../../src/app/pr.ts";
import { createOrderedOutbox, deliveryScope, OrderedWriteDeferredError } from "../../src/app/writers.ts";
import { reconcileOnce } from "../../src/sync/reconcile.ts";
import { PlaneApiError } from "../../src/sync/plane.ts";
import type { PlaneWritePath } from "../../src/sync/plane.ts";
import type { GithubWritePath } from "../../src/sync/github.ts";
import type { SyncLinkRow } from "../../src/db/schema.ts";
import { ghJob, LABELS, makeHarness, planeJob, prPayload } from "../a8/harness.ts";
import { intentJob, queue } from "../writers/outbox-fixture.ts";

async function fixture(qllLinkback: boolean, webLinkback: boolean) {
  const h = await makeHarness();
  const qllId = await h.mapping({ projectId: "p-qll", linkback: qllLinkback, smartCommits: false });
  const webId = await h.mapping({ projectId: "p-web", linkback: webLinkback, smartCommits: false });
  const ctx = { ...h.ctx };
  const ordered = createOrderedOutbox({ db: h.db, authoriseWrite: createOutboundAuthoriser(h.db),
    plane: h.ctx.plane as PlaneWritePath, github: h.ctx.github as GithubWritePath,
    queues: { plane: queue(), github: queue() }, loadActorToken: async () => null,
    findPlaneLinkId: (target, url) => findLinkId(ctx, target, url),
    resumeReducer: (request) => request.kind === "pr_created" ? handleCreatedPr(ctx, request)
      : request.kind === "mirror_pending" ? handlePendingMirroredIssue(ctx, request) : handleMirroredIssue(ctx, request),
  });
  ctx.plane = ordered.plane; ctx.github = ordered.github;
  const drain = async () => {
    for (let round = 0; round < 40; round++) {
      const rows = (await h.db.query<{ id: string; side: string }>("SELECT id, side FROM outbound_writes WHERE status = 'pending' ORDER BY sequence")).rows;
      if (!rows.length) return;
      let progress = false;
      for (const row of rows) {
        const job = await intentJob(h.db, row.id);
        try { await (row.side === "plane" ? ordered.executePlane(job) : ordered.executeGithub(job)); progress = true; }
        catch (error) { if (!(error instanceof OrderedWriteDeferredError)) throw error; }
      }
      ok(progress, "outbox must make progress");
    }
    throw new Error("outbox did not drain");
  };
  const createMirror = async () => {
    const job = planeJob("issue", { workspace_slug: "ws", action: "update", data: { id: "web-mirror", project: "p-web",
      name: "WEB mirror", labels: [LABELS[0]], description_html: "<p>mirror body</p>" },
      activity: { field: "label_ids", old_value: [], new_value: [LABELS[0]!.id], actor: { id: "human" } } });
    await deliveryScope.run({ deliveryId: `plane-${job.deliveryId}`, workspaceSlug: "ws" }, () => handlePlaneIssue(ctx, job));
    await drain();
    const link = (await h.db.query<SyncLinkRow>("SELECT * FROM sync_links WHERE plane_issue_id = 'web-mirror'")).rows[0]!;
    strictEqual(link.created_by, "label_sync"); strictEqual(link.plane_project_id, "p-web");
    return link;
  };
  const createPr = async () => {
    const job = ghJob("pull_request", prPayload("opened", {}, { body: "WEB-NEW" }));
    await deliveryScope.run({ deliveryId: `github-${job.deliveryId}`, workspaceSlug: "ws" }, () => handlePullRequest(ctx, job));
    await drain();
    const link = (await h.db.query<SyncLinkRow>("SELECT * FROM sync_links WHERE gh_kind = 'pr'")).rows[0]!;
    strictEqual(link.plane_project_id, "p-web");
    const created = (await h.db.query<{ write: any }>("SELECT write FROM outbound_writes WHERE write->>'kind' = 'create_issue'")).rows[0]!;
    strictEqual(created.write._authority.mappingId, String(qllId), "first QLL mapping owns the cross-project WEB creation");
    return link;
  };
  const orphan = async () => {
    ctx.planeClient.getIssue = async () => { throw new PlaneApiError(404, {}, "deleted in Plane"); };
    // A2 (reconcile): a 404 alone no longer orphans, because Plane also answers 404 for archived items. Prove the deletion
    // the way production does: the project is live and the item's newest activity is `deleted`.
    ctx.planeClient.getProject = async (_slug: string, id: string) => ({ id, archived_at: null }) as any;
    ctx.planeClient.listIssueActivities = async () => [{ verb: "deleted", field: "issue", created_at: new Date().toISOString() }] as any;
    return reconcileOnce({ db: h.db, plane: ctx.planeClient, onOrphan: (link) => linkbackOnOrphan(ctx, link) });
  };
  // Mirror creation now also posts its own "Linked to Plane work item" comment when linkback is on (Plane-to-GitHub
  // mirror linkback, src/sync/mirror.ts createGithubIssue), so only the orphan notice counts as an orphan comment.
  const orphanComments = () => h.gh.writes().filter((w) => w.route.includes("comments") && String(w.params?.body ?? "").includes("marked orphaned"));
  const notifications = () => h.db.query<{ write: any }>("SELECT write FROM outbound_writes WHERE write->>'kind' = 'comment' AND write->>'body' LIKE '%marked orphaned%' ORDER BY sequence");
  return { ...h, ctx, qllId, webId, ordered, drain, createMirror, createPr, orphan, notifications, orphanComments };
}

for (const [qllEnabled, webEnabled] of [[false, true], [true, false]] as const) {
  test(`F1: actual WEB mirror reconciliation honors WEB=${webEnabled} with earlier QLL=${qllEnabled}`, async () => {
    const h = await fixture(qllEnabled, webEnabled);
    try {
      const link = await h.createMirror();
      strictEqual((await mappingForOrphanLink(h.db, link))!.id, h.webId);
      deepStrictEqual(await h.orphan(), { checked: 1, orphaned: 1, archived: 0, errors: 0 });
      const rows = (await h.notifications()).rows;
      strictEqual(rows.length, webEnabled ? 1 : 0);
      if (webEnabled) deepStrictEqual(rows[0]!.write._authority, { workspaceSlug: "ws", mappingId: String(h.webId), repoId: 555, installationId: 1 });
      await h.drain();
      strictEqual(h.orphanComments().length, webEnabled ? 1 : 0);
      ok(!h.gh.writes().some((w) => w.route.startsWith("PATCH")), "orphan notification never closes GitHub");
    } finally { await h.close(); }
  });
}

test("F1: deleting the owning WEB mirror mapping suppresses notification while QLL survives", async () => {
  const h = await fixture(true, true);
  try {
    const link = await h.createMirror();
    await h.db.query("DELETE FROM repo_mappings WHERE id = $1", [h.webId]);
    strictEqual(await mappingForOrphanLink(h.db, link), null);
    deepStrictEqual(await h.orphan(), { checked: 1, orphaned: 1, archived: 0, errors: 0 });
    strictEqual((await h.notifications()).rows.length, 0);
    strictEqual((await h.db.query("SELECT 1 FROM repo_mappings WHERE id = $1", [h.qllId])).rows.length, 1);
    strictEqual(h.orphanComments().length, 0);
  } finally { await h.close(); }
});

for (const [qllEnabled, webEnabled] of [[true, false], [false, true]] as const) {
  test(`F1: a cross-project WEB PR uses its stored QLL=${qllEnabled} provenance instead of WEB=${webEnabled}`, async () => {
    const h = await fixture(qllEnabled, webEnabled);
    try {
      const link = await h.createPr();
      strictEqual((await mappingForOrphanLink(h.db, link))!.id, h.qllId);
      deepStrictEqual(await h.orphan(), { checked: 1, orphaned: 1, archived: 0, errors: 0 });
      const rows = (await h.notifications()).rows;
      strictEqual(rows.length, qllEnabled ? 1 : 0);
      if (qllEnabled) strictEqual(rows[0]!.write._authority.mappingId, String(h.qllId));
      await h.drain();
    } finally { await h.close(); }
  });
}

test("F1: PR provenance cannot be replaced by the surviving target-project mapping or missing evidence", async () => {
  const h = await fixture(true, true);
  try {
    const link = await h.createPr();
    await h.db.query("DELETE FROM repo_mappings WHERE id = $1", [h.qllId]);
    strictEqual(await mappingForOrphanLink(h.db, link), null);
    deepStrictEqual(await h.orphan(), { checked: 1, orphaned: 1, archived: 0, errors: 0 });
    strictEqual((await h.notifications()).rows.length, 0);
    await h.db.query("DELETE FROM outbound_writes WHERE write->>'kind' = 'create_issue'");
    strictEqual(await mappingForOrphanLink(h.db, link), null, "an authorized target mapping is not provenance");
    strictEqual((await h.db.query("SELECT 1 FROM repo_mappings WHERE id = $1", [h.webId])).rows.length, 1);
  } finally { await h.close(); }
});

test("F1: older PR workflows recover explicit originating continuation provenance", async () => {
  const h = await fixture(true, false);
  try {
    const link = await h.createPr();
    await h.db.query("UPDATE outbound_writes SET write = write - '_authority' WHERE write->>'kind' = 'create_issue'");
    strictEqual((await mappingForOrphanLink(h.db, link))!.id, h.qllId);
    await h.orphan();
    strictEqual((await h.notifications()).rows[0]!.write._authority.mappingId, String(h.qllId));
  } finally { await h.close(); }
});
