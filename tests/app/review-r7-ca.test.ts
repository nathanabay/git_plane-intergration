import test from "node:test";
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { findLinkId, handleCreatedPr } from "../../src/app/pr.ts";
import { handleMirroredIssue, handlePendingMirroredIssue } from "../../src/app/issues.ts";
import { createOutboundAuthoriser } from "../../src/app/mappings.ts";
import { createRouter, inboundHandler } from "../../src/app/reducers.ts";
import { createOrderedOutbox, deliveryScope } from "../../src/app/writers.ts";
import { processInbound } from "../../src/queue/workers.ts";
import { replayDelivery } from "../../src/operations/tooling.ts";
import { reconcileOnce } from "../../src/sync/reconcile.ts";
import { PlaneApiError } from "../../src/sync/plane.ts";
import type { InboundJob } from "../../src/queue/index.ts";
import { ghJob, makeHarness, prPayload, sha } from "../a8/harness.ts";
import { intentJob, queue } from "../writers/outbox-fixture.ts";

async function fixture() {
  const h = await makeHarness();
  const mappingId = await h.mapping({ installationId: 1, smartCommits: true, linkback: true, rules: `
- when: pull_request.opened
  then: [{ set_state: In Progress }, { comment: pr-rule-once }]
` });
  const ctx = { ...h.ctx };
  const scopes: unknown[] = [];
  const query = h.db.query.bind(h.db);
  h.db.query = (async (...args: Parameters<typeof query>) => {
    if (/INSERT INTO outbound_writes/.test(args[0])) scopes.push(deliveryScope.getStore()?.authority);
    return query(...args);
  }) as typeof h.db.query;
  const controls = { failComment: false, failResume: false };
  const outbox = createOrderedOutbox({ db: h.db, plane: {
    preflight: (write) => { scopes.push(deliveryScope.getStore()?.authority); return (h.ctx.plane as any).preflight(write); },
    apply: (write, opts) => {
      if (controls.failComment && write.kind === "add_comment") {
        controls.failComment = false;
        throw new PlaneApiError(422, {}, "comment failed before repair");
      }
      return h.ctx.plane.apply(write, opts);
    },
  }, github: h.ctx.github as any, queues: { plane: queue() as any, github: queue() as any }, maxAttempts: 1,
    loadActorToken: async () => null, authoriseWrite: createOutboundAuthoriser(h.db),
    findPlaneLinkId: (target, url) => findLinkId(ctx, target, url),
    resumeReducer: (request) => {
      if (controls.failResume) { controls.failResume = false; throw new PlaneApiError(422, {}, "original PR tail failed"); }
      return request.kind === "mirror_created" ? handleMirroredIssue(ctx, request)
        : request.kind === "mirror_pending" ? handlePendingMirroredIssue(ctx, request) : handleCreatedPr(ctx, request);
    },
  });
  ctx.plane = outbox.plane; ctx.github = outbox.github;
  const router = createRouter(ctx);
  const inbound = { db: h.db, opTtlMinutes: 30, onGithubEvent: inboundHandler(ctx, router, "github"), onPlaneEvent: inboundHandler(ctx, router, "plane") };
  const feed = (job: InboundJob) => processInbound(job, inbound);
  const next = async () => (await h.db.query<any>("SELECT id, side FROM outbound_writes WHERE status = 'pending' ORDER BY sequence LIMIT 1")).rows[0];
  const execute = async () => {
    const row = await next(); ok(row, "pending intent exists");
    const job = await intentJob(h.db, row.id);
    return row.side === "plane" ? outbox.executePlane(job) : outbox.executeGithub(job);
  };
  const drain = async () => {
    for (let n = 0; n < 60; n++) { if (!await next()) return; await execute(); }
    throw new Error("outbox did not drain");
  };
  const replay = async (job: InboundJob) => {
    const audit = (await h.audit("inbound_delivery")).find((r) => r.delivery_id === job.deliveryId);
    ok(audit);
    await replayDelivery({ db: h.db, enqueue: async (queued) => { strictEqual(await feed(queued), "handled"); } }, audit.id);
  };
  const authority = (installationId: number) => ({ mappingId: String(mappingId), workspaceSlug: "ws", repoId: 555, installationId });
  const verifyAuthority = async (installationId: number) => {
    const rows = (await h.db.query<any>("SELECT write FROM outbound_writes")).rows;
    ok(rows.length > 0);
    for (const row of rows) deepStrictEqual(row.write._authority, authority(installationId));
    ok(scopes.length > 0, "registration entered the admitted authority scope");
    for (const scope of scopes) deepStrictEqual(scope, authority(installationId));
  };
  return { ...h, ctx, mappingId, scopes, controls, outbox, feed, execute, drain, replay, verifyAuthority, authority };
}

test("F1: push refreshes 1 to 4242 before unmapped-sender lookup and keeps repaired Smart Commit/branch intents once-only", async () => {
  const h = await fixture();
  try {
    await h.db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (4242, 'ws')");
    const profileScopes: unknown[] = [];
    h.gh.respond(/^GET \/users\//, () => { profileScopes.push(deliveryScope.getStore()?.authority); return { id: 6001, email: null }; });
    const job = ghJob("push", { installation: { id: 4242 }, sender: { id: 6001, login: "r7-push", type: "User" },
      ref: "refs/heads/QLL-1-branch", before: sha("0"), after: sha("a"), created: true,
      commits: [{ id: sha("a"), message: "QLL-1 #done #comment push-once" }] }, "r7-push");
    strictEqual(await h.feed(job), "handled");
    strictEqual(Number((await h.db.query<any>("SELECT installation_id FROM repo_mappings WHERE id = $1", [h.mappingId])).rows[0].installation_id), 4242);
    deepStrictEqual(profileScopes, [h.authority(4242)], "the unmapped sender profile lookup already sees refreshed authority");
    await h.verifyAuthority(4242);
    h.controls.failComment = true;
    await rejects(h.drain(), /comment failed before repair/);
    const saved = (await h.db.query<any>("SELECT id, write, result FROM outbound_writes ORDER BY sequence")).rows;
    await h.replay(job);
    deepStrictEqual((await h.db.query<any>("SELECT id, write FROM outbound_writes ORDER BY sequence")).rows, saved.map(({ id, write }: any) => ({ id, write })), "repair never rewrites frozen authority or intent identities");
    await h.drain();
    await h.replay(job); await h.drain();
    await h.verifyAuthority(4242);
    strictEqual(h.plane.writes().filter((w) => w.method === "PATCH" && w.body?.state === "s-done").length, 1);
    strictEqual(h.plane.writes().filter((w) => w.body?.comment_html?.includes("push-once")).length, 1);
    strictEqual(h.plane.writes().filter((w) => /\/links\//.test(w.path)).length, 1, "branch rollup is once-only");
  } finally { await h.close(); }
});

test("F1: PR refreshes 1 to 4242 before create admission and resumed rules/rollup/linkback retain that snapshot through replay", async () => {
  const h = await fixture();
  try {
    await h.db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (4242, 'ws')");
    h.gh.respond(/^GET \/users\//, () => ({ id: 6002, email: null }));
    const job = ghJob("pull_request", prPayload("opened", { installation: { id: 4242 }, sender: { id: 6002, login: "r7-pr", type: "User" } }, { body: "QLL-NEW" }), "r7-pr");
    await h.feed(job);
    strictEqual(Number((await h.db.query<any>("SELECT installation_id FROM repo_mappings WHERE id = $1", [h.mappingId])).rows[0].installation_id), 4242);
    await h.verifyAuthority(4242);
    await h.execute();
    h.controls.failResume = true;
    await rejects(h.execute(), /original PR tail failed/);
    const saved = (await h.db.query<any>("SELECT id, write, result FROM outbound_writes ORDER BY sequence")).rows;
    await h.replay(job);
    const repaired = (await h.db.query<any>("SELECT id, write, result FROM outbound_writes ORDER BY sequence")).rows;
    deepStrictEqual(repaired, saved, "repair preserves successful results and every saved authority");
    await h.drain();
    await h.replay(job); await h.drain();
    await h.verifyAuthority(4242);
    strictEqual(h.plane.createdIssueIds.length, 1);
    strictEqual(h.plane.writes().filter((w) => w.method === "PATCH" && w.body?.state === "s-prog").length, 1);
    strictEqual(h.plane.writes().filter((w) => w.body?.comment_html?.includes("pr-rule-once")).length, 1);
    strictEqual(h.plane.writes().filter((w) => /\/links\//.test(w.path)).length, 1);
    strictEqual(h.gh.writes().filter((w) => /\/comments$/.test(w.route)).length, 1);
  } finally { await h.close(); }
});

test("F1: unlisted replacement installation is rejected by both actual reducers before any registration", async () => {
  const h = await fixture();
  try {
    for (const job of [ghJob("push", { installation: { id: 4242 }, ref: "refs/heads/main", commits: [{ id: sha("b"), message: "QLL-1 #comment forbidden" }] }),
      ghJob("pull_request", prPayload("opened", { installation: { id: 4242 } }, { body: "QLL-NEW" }))]) await rejects(h.feed(job), /not allowed/);
    strictEqual((await h.db.query("SELECT 1 FROM outbound_writes")).rows.length, 0);
    strictEqual(Number((await h.db.query<any>("SELECT installation_id FROM repo_mappings WHERE id = $1", [h.mappingId])).rows[0].installation_id), 1);
  } finally { await h.close(); }
});

test("F2: successful create, failed original tail and actual orphaning permit exactly one distinct replacement", async () => {
  const h = await fixture();
  try {
    const original = ghJob("pull_request", prPayload("opened", {}, { body: "QLL-NEW" }), "r7-orphan-original");
    await h.feed(original); await h.execute();
    h.controls.failResume = true;
    await rejects(h.execute(), /original PR tail failed/);
    const old = (await h.db.query<any>("SELECT id, write, status, result FROM outbound_writes ORDER BY sequence")).rows;
    deepStrictEqual(old.map((r) => r.status), ["applied", "failed"]);
    strictEqual((await reconcileOnce({ db: h.db, plane: h.ctx.planeClient })).orphaned, 1);
    // The old successful request remains once-only even when directly reduced with a new transport ID.
    await h.feed({ ...original, deliveryId: "r7-old-replay", writeDeliveryId: original.deliveryId });
    strictEqual((await h.db.query("SELECT 1 FROM outbound_writes")).rows.length, 2);
    const replacement = ghJob("pull_request", prPayload("edited", {}, { body: "QLL-NEW" }), "r7-orphan-replacement");
    await h.feed(replacement);
    await h.feed({ ...replacement, deliveryId: "r7-pending-replacement-replay", writeDeliveryId: replacement.deliveryId });
    const creates = (await h.db.query<any>("SELECT id FROM outbound_writes WHERE write->>'kind' = 'create_issue' ORDER BY sequence")).rows;
    strictEqual(creates.length, 2);
    ok(creates[1].id !== creates[0].id);
    deepStrictEqual((await h.db.query<any>("SELECT id, write, status, result FROM outbound_writes WHERE id = ANY($1::text[]) ORDER BY sequence", [old.map((r) => r.id)])).rows, old, "replacement leaves the old failed workflow untouched");
    await h.drain();
    await h.replay(replacement); await h.drain();
    strictEqual(h.plane.createdIssueIds.length, 2);
    const links = (await h.db.query<any>("SELECT status, plane_issue_id FROM sync_links ORDER BY id")).rows;
    deepStrictEqual(links.map((r) => r.status), ["orphaned", "active"]);
    strictEqual(links[1].plane_issue_id, h.plane.createdIssueIds[1]);
    strictEqual((await h.db.query("SELECT 1 FROM outbound_writes WHERE write->>'kind' = 'create_issue'")).rows.length, 2);
  } finally { await h.close(); }
});
