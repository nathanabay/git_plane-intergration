// Round-3 F1 hand-off: a `{ID}-NEW` create is a durable plan (create, sync link, audit, resume), and the resume
// continues only the newly created target. Real ordered outbox on PGlite with in-memory queues.
import test from "node:test";
import { ok, strictEqual } from "node:assert/strict";
import { findLinkId, handleCreatedPr, handlePullRequest } from "../../src/app/pr.ts";
import { createOrderedOutbox } from "../../src/app/writers.ts";
import { ghJob, makeHarness, prPayload } from "../a8/harness.ts";
import { queue } from "../writers/outbox-fixture.ts";

test("F1: a -NEW create registers a plan; running it creates the item, links it, audits it, then resumes the PR work for that target only", async () => {
  const h = await makeHarness();
  try {
    await h.mapping({ linkback: true, smartCommits: false });
    const planeQ = queue(), githubQ = queue();
    const ctx: any = { ...h.ctx };
    const ordered = createOrderedOutbox({
      db: h.db, plane: h.ctx.plane as any, github: h.ctx.github as any,
      queues: { plane: planeQ as any, github: githubQ as any },
      loadActorToken: async () => null,
      findPlaneLinkId: (target, url) => findLinkId(ctx, target, url),
      resumeReducer: (request) => handleCreatedPr(ctx, request),
    });
    ctx.plane = ordered.plane; ctx.github = ordered.github;

    await handlePullRequest(ctx, ghJob("pull_request", prPayload("opened", {}, { body: "QLL-NEW" })));
    // registration only: nothing has been created yet, and no id was read
    strictEqual(h.plane.createdIssueIds.length, 0);
    strictEqual((await h.db.query("SELECT 1 FROM sync_links")).rows.length, 0);

    // the workers: run every queued job (wake-ups can appear while earlier ones execute) until the queues are idle
    const done = new Set<string>();
    for (let round = 0; round < 20; round++) {
      let progressed = false;
      for (const [side, q] of [["plane", planeQ], ["github", githubQ]] as const) {
        for (const [id, job] of q.jobs) {
          if (done.has(id)) continue;
          try { await (side === "plane" ? ordered.executePlane(job) : ordered.executeGithub(job)); done.add(id); progressed = true; } catch { /* deferred behind a predecessor */ }
        }
      }
      if (!progressed) break;
    }

    strictEqual(h.plane.createdIssueIds.length, 1);
    const links = (await h.db.query<any>("SELECT plane_issue_id, gh_number, gh_kind, tier FROM sync_links")).rows;
    strictEqual(links.length, 1);
    strictEqual(links[0].plane_issue_id, h.plane.createdIssueIds[0]);
    strictEqual(links[0].gh_kind, "pr");
    const audit = (await h.audit("pr_create_request"))[0];
    strictEqual(audit.outcome, "created");
    strictEqual(audit.detail.planeIssueId, h.plane.createdIssueIds[0]);
    // the continuation ran for the new target: the PR rollup link on it and the linkback comment on GitHub
    ok(h.plane.writes().some((c) => /\/links\/$/.test(c.path) && c.path.includes(h.plane.createdIssueIds[0]!)), "rollup link written on the created item");
    strictEqual((await h.db.query("SELECT 1 FROM dev_info_links WHERE plane_issue_id = $1", [h.plane.createdIssueIds[0]])).rows.length, 1, "the rollup link id is stored by the outbox");
    strictEqual(h.gh.writes().filter((c) => /comments/.test(c.route)).length, 1);
    // a redelivery of the same event registers nothing new
    await handlePullRequest(ctx, ghJob("pull_request", prPayload("edited", {}, { body: "QLL-NEW" })));
    strictEqual(h.plane.createdIssueIds.length, 1);
  } finally { await h.close(); }
});
