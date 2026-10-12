import test from "node:test";
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { findLinkId, handleCreatedPr } from "../../src/app/pr.ts";
import { handleMirroredIssue, handlePendingMirroredIssue } from "../../src/app/issues.ts";
import { createOutboundAuthoriser } from "../../src/app/mappings.ts";
import { createRouter, inboundHandler } from "../../src/app/reducers.ts";
import { createOrderedOutbox, OrderedWriteDeferredError } from "../../src/app/writers.ts";
import { processInbound } from "../../src/queue/workers.ts";
import { replayDelivery } from "../../src/operations/tooling.ts";
import { PlaneApiError } from "../../src/sync/plane.ts";
import type { InboundJob } from "../../src/queue/index.ts";
import { ghJob, makeHarness, planeJob, prPayload } from "../a8/harness.ts";
import { intentJob, queue } from "../writers/outbox-fixture.ts";

async function harness() {
  const h = await makeHarness();
  const mappingId = await h.mapping({ smartCommits: false, linkback: true, rules: `
- when: pull_request.opened
  then: [{ comment: opened-once }, { set_state: In Progress }]
- when: pull_request.approved
  then: [{ comment: approved-once }, { set_state: In Review }]
- when: pull_request.merged
  then: [{ comment: merged-once }, { set_state: Done }]
` });
  const authority = { workspaceSlug: "ws", mappingId: String(mappingId), repoId: 555, installationId: 1 };
  const ctx = { ...h.ctx };
  const planeQ = queue(), githubQ = queue();
  let unavailable = false;
  const ordered = createOrderedOutbox({ db: h.db,
    plane: { preflight: (w) => (h.ctx.plane as any).preflight(w),
      apply: (w, opts) => {
        if (unavailable && w.kind === "create_issue") throw new PlaneApiError(503, {}, "Plane unavailable until explicit repair");
        return h.ctx.plane.apply(w, opts);
      } },
    github: h.ctx.github as any, queues: { plane: planeQ as any, github: githubQ as any },
    loadActorToken: async () => null, maxAttempts: 1,
    authoriseWrite: createOutboundAuthoriser(h.db),
    findPlaneLinkId: (target, url) => findLinkId(ctx, target, url),
    resumeReducer: (request) => request.kind === "mirror_created" ? handleMirroredIssue(ctx, request)
      : request.kind === "mirror_pending" ? handlePendingMirroredIssue(ctx, request) : handleCreatedPr(ctx, request),
  });
  ctx.plane = ordered.plane; ctx.github = ordered.github;
  const router = createRouter(ctx);
  const inbound = { db: h.db, opTtlMinutes: 30, onGithubEvent: inboundHandler(ctx, router, "github"), onPlaneEvent: inboundHandler(ctx, router, "plane") };
  const feed = (job: InboundJob) => processInbound(job, inbound);
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
      if (!pending.length) return;
      const after = Number((await h.db.query<any>("SELECT count(*) AS n FROM outbound_writes WHERE status = 'applied'")).rows[0].n);
      ok(after > before, `outbox stalled with ${pending.length} unfinished intents`);
    }
    throw new Error("outbox did not drain");
  }
  return { ...h, ctx, mappingId, authority, ordered, feed, drain, outage(value: boolean) { unavailable = value; } };
}

test("F5: terminal unlinked create retains edited/approved/merged events until original replay or failed-write Retry", async () => {
  for (const repair of ["replay", "retry"] as const) {
    const h = await harness();
    try {
      const opened = ghJob("pull_request", prPayload("opened", {}, { body: "QLL-NEW" }), `opened-${repair}`);
      strictEqual(await h.feed(opened), "handled");
      const root = (await h.db.query<any>("SELECT id FROM outbound_writes ORDER BY sequence LIMIT 1")).rows[0].id;
      h.outage(true);
      await rejects(h.ordered.executePlane(await intentJob(h.db, root)), /Plane unavailable/);
      strictEqual((await h.db.query("SELECT 1 FROM pending_sync_links")).rows.length, 0);
      strictEqual((await h.db.query("SELECT 1 FROM sync_links")).rows.length, 0);
      strictEqual(h.plane.createdIssueIds.length, 0);
      const original = (await h.db.query<any>("SELECT id, status, attempts, write FROM outbound_writes ORDER BY sequence")).rows;
      deepStrictEqual(original.map((r) => r.status), ["failed", "failed"]);
      const edited = ghJob("pull_request", prPayload("edited", {}, { body: "QLL-NEW", title: "Edited while failed" }), `edited-${repair}`);
      const approved = ghJob("pull_request_review", prPayload("submitted", { review: { state: "approved" } }, { body: "QLL-NEW" }), `approved-${repair}`);
      const merged = ghJob("pull_request", prPayload("closed", {}, { body: "QLL-NEW", state: "closed", merged: true }), `merged-${repair}`);
      for (const job of [edited, approved, merged]) strictEqual(await h.feed(job), "handled");
      const duplicate = { ...merged, deliveryId: `transport-replay-${repair}`, writeDeliveryId: merged.deliveryId };
      strictEqual(await h.feed(duplicate), "handled");
      const held = (await h.db.query<any>("SELECT id, status, attempts, write FROM outbound_writes ORDER BY sequence")).rows;
      strictEqual(held.length, 5, "one original create, original resume, and three held events");
      ok(held.every((r) => r.status === "failed"), "ordinary later events never restart remote work");
      deepStrictEqual(held.slice(0, 2), original, "failed original intents and attempts are unchanged");
      deepStrictEqual(held.slice(1).map((r) => r.write.continuation.job.deliveryId), [opened.deliveryId, edited.deliveryId, approved.deliveryId, merged.deliveryId]);
      for (let i = 2; i < held.length; i++) strictEqual(held[i].write._plan.predecessor, held[i - 1].id);
      for (const row of held) deepStrictEqual(row.write._authority, h.authority);
      strictEqual(h.plane.createdIssueIds.length, 0);
      strictEqual((await h.db.query("SELECT 1 FROM pending_sync_links")).rows.length, 0, "failed event retention does not recreate a live barrier");
      h.outage(false);
      if (repair === "replay") {
        const audit = (await h.audit("inbound_delivery")).find((r) => r.delivery_id === opened.deliveryId);
        await replayDelivery({ db: h.db, enqueue: async (job) => { strictEqual(await h.feed(job), "handled"); } }, audit.id);
      } else {
        deepStrictEqual(await h.ordered.retryFailed(root, "ws"), { ok: true, retried: true });
      }
      const revived = (await h.db.query<any>("SELECT id, status FROM outbound_writes ORDER BY sequence")).rows;
      deepStrictEqual(revived.map((r) => r.id), held.map((r) => r.id), "repair reuses every saved event identity");
      ok(revived.every((r) => r.status === "pending"));
      await h.drain();
      strictEqual(h.plane.createdIssueIds.length, 1);
      const writes = h.plane.writes();
      deepStrictEqual(writes.filter((w) => w.method === "PATCH" && w.body?.state).map((w) => w.body.state), ["s-prog", "s-review", "s-done"]);
      for (const text of ["opened-once", "approved-once", "merged-once"]) strictEqual(writes.filter((w) => w.body?.comment_html?.includes(text)).length, 1);
      const rollups = writes.filter((w) => /\/links\//.test(w.path));
      ok(rollups.some((w) => w.body?.title?.includes("Edited while failed")));
      ok(rollups.at(-1)?.body.title.includes("MERGED"));
      strictEqual(h.gh.writes().filter((w) => /comments/.test(w.route)).length, 1);
      strictEqual((await h.db.query("SELECT 1 FROM pending_sync_links")).rows.length, 0);
      const completed = (await h.db.query<any>("SELECT write FROM outbound_writes")).rows;
      for (const { write } of completed) deepStrictEqual(write._authority, h.authority, "rules, rollups and linkbacks inherit the frozen source");
    } finally { await h.close(); }
  }
});

test("authority: both directions of real mirror registration freeze the admitted mapping", async () => {
  const h = await harness();
  try {
    strictEqual(await h.feed(ghJob("issues", { action: "labeled", label: { name: "plane" }, issue: { number: 23, title: "Mirror me", body: "Body", labels: [{ name: "plane" }] } })), "handled");
    strictEqual(await h.feed(planeJob("issue", { action: "update", data: { id: "i-plane", project: "p-qll", name: "Plane origin", labels: [{ id: "label-gh", name: "github" }] },
      activity: { field: "label_ids", old_value: [], new_value: ["label-gh"], actor: { id: "human" } } })), "handled");
    const intents = (await h.db.query<any>("SELECT side, write FROM outbound_writes ORDER BY sequence")).rows;
    ok(intents.some((r) => r.side === "plane" && r.write.kind === "create_issue"));
    ok(intents.some((r) => r.side === "github" && r.write.kind === "create_issue"));
    for (const row of intents) deepStrictEqual(row.write._authority, h.authority);
  } finally { await h.close(); }
});

test("authority: queued PR create cannot adopt a replacement mapping after its original mapping is removed", async () => {
  const h = await harness();
  try {
    await h.feed(ghJob("pull_request", prPayload("opened", {}, { body: "QLL-NEW" })));
    const root = (await h.db.query<any>("SELECT id FROM outbound_writes ORDER BY sequence LIMIT 1")).rows[0].id;
    await h.db.query("DELETE FROM rule_sets WHERE mapping_id = $1", [h.mappingId]);
    await h.db.query("DELETE FROM repo_mappings WHERE id = $1", [h.mappingId]);
    const replacement = await h.mapping({ installationId: 1, smartCommits: false });
    ok(replacement !== h.mappingId);
    await rejects(h.ordered.executePlane(await intentJob(h.db, root)), /authority/);
    strictEqual(h.plane.createdIssueIds.length, 0);
    await rejects(h.ordered.retryFailed(root, "ws"), /authority/);
    for (const row of (await h.db.query<any>("SELECT status, write FROM outbound_writes")).rows) {
      strictEqual(row.status, "failed"); deepStrictEqual(row.write._authority, h.authority);
    }
  } finally { await h.close(); }
});
