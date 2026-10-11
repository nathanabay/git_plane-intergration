// Round-3 F1 hand-off: the issue.* rules of a newly mirrored GitHub issue run from the durable resume once the item and its link
// exist (the reducer returns before them). Real ordered outbox on PGlite with in-memory queues.
import test from "node:test";
import { ok, strictEqual } from "node:assert/strict";
import { handleGithubIssue, handleMirroredIssue, handlePendingMirroredIssue, handlePlaneIssue } from "../../src/app/issues.ts";
import { findLinkId } from "../../src/app/pr.ts";
import { createOrderedOutbox } from "../../src/app/writers.ts";
import { ghJob, LABELS, makeHarness, planeJob } from "../a8/harness.ts";
import { queue } from "../writers/outbox-fixture.ts";

test("F1: a custom issue.labeled rule fires on the item created by a mirror, after its link exists", async () => {
  const h = await makeHarness();
  try {
    await h.mapping({ rules: "- when: issue.labeled\n  then: [{ comment: ruled }]\n", smartCommits: false });
    const planeQ = queue(), githubQ = queue();
    const ctx: any = { ...h.ctx };
    const ordered = createOrderedOutbox({
      db: h.db, plane: h.ctx.plane as any, github: h.ctx.github as any,
      queues: { plane: planeQ as any, github: githubQ as any },
      loadActorToken: async () => null,
      findPlaneLinkId: (target, url) => findLinkId(ctx, target, url),
      resumeReducer: (request) => handleMirroredIssue(ctx, request),
    });
    ctx.plane = ordered.plane; ctx.github = ordered.github;

    await handleGithubIssue(ctx, ghJob("issues", { action: "labeled", label: { name: "plane" }, issue: { number: 31, title: "Mirror me", body: "b", state: "open", labels: [{ name: "plane" }], assignees: [] } }));
    strictEqual(h.plane.createdIssueIds.length, 0, "registration only");
    const ruled = () => h.plane.writes().filter((c) => /\/comments\/$/.test(c.path) && JSON.stringify(c.body).includes("ruled")).length;
    strictEqual(ruled(), 0);

    const done = new Set<string>();
    for (let round = 0; round < 30; round++) {
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
    strictEqual((await h.db.query("SELECT 1 FROM sync_links WHERE plane_issue_id = $1", [h.plane.createdIssueIds[0]])).rows.length, 1);
    strictEqual(ruled(), 1, "the rule ran once, for the created item, after the link existed");
    ok((await h.audit("rule_match")).length >= 1);
  } finally { await h.close(); }
});

test("F1: when a fast worker creates and links the item before the reducer returns, the rule still runs exactly once", async () => {
  const h = await makeHarness();
  try {
    await h.mapping({ rules: "- when: issue.labeled\n  then: [{ comment: ruled }]\n", smartCommits: false });
    const planeQ = queue(), githubQ = queue();
    const ctx: any = { ...h.ctx };
    let ordered: ReturnType<typeof createOrderedOutbox> | undefined;
    const done = new Set<string>();
    let draining = false;
    const drain = async () => { // the worker: runs the queued jobs as soon as they are queued
      if (draining || !ordered) return;
      draining = true;
      try {
        for (let round = 0; round < 30; round++) {
          let progressed = false;
          for (const [side, q] of [["plane", planeQ], ["github", githubQ]] as const) {
            for (const [id, job] of q.jobs) {
              if (done.has(id)) continue;
              try { await (side === "plane" ? ordered.executePlane(job) : ordered.executeGithub(job)); done.add(id); progressed = true; } catch { /* deferred */ }
            }
          }
          if (!progressed) break;
        }
      } finally { draining = false; }
    };
    for (const q of [planeQ, githubQ]) { const add = q.add.bind(q); q.add = async (name: string, data: any, opts: any) => { const r = await add(name, data, opts); await drain(); return r; }; }
    ordered = createOrderedOutbox({
      db: h.db, plane: h.ctx.plane as any, github: h.ctx.github as any,
      queues: { plane: planeQ as any, github: githubQ as any },
      loadActorToken: async () => null,
      findPlaneLinkId: (target, url) => findLinkId(ctx, target, url),
      resumeReducer: (request) => handleMirroredIssue(ctx, request),
    });
    ctx.plane = ordered.plane; ctx.github = ordered.github;

    await handleGithubIssue(ctx, ghJob("issues", { action: "labeled", label: { name: "plane" }, issue: { number: 31, title: "Mirror me", body: "b", state: "open", labels: [{ name: "plane" }], assignees: [] } }));
    await drain();
    strictEqual(h.plane.createdIssueIds.length, 1);
    const ruled = h.plane.writes().filter((c) => /\/comments\/$/.test(c.path) && JSON.stringify(c.body).includes("ruled")).length;
    strictEqual(ruled, 1);
  } finally { await h.close(); }
});

test("F1: an issues.edited received while the partner is still being created is replayed, rules included, once the link exists", async () => {
  const h = await makeHarness();
  try {
    await h.mapping({ rules: "- when: issue.edited\n  then: [{ comment: edited-rule }]\n", smartCommits: false });
    const planeQ = queue(), githubQ = queue();
    const ctx: any = { ...h.ctx };
    const ordered = createOrderedOutbox({
      db: h.db, plane: h.ctx.plane as any, github: h.ctx.github as any,
      queues: { plane: planeQ as any, github: githubQ as any },
      loadActorToken: async () => null,
      findPlaneLinkId: (target, url) => findLinkId(ctx, target, url),
      resumeReducer: (request) => (request.kind === "mirror_pending" ? handlePendingMirroredIssue(ctx, request) : handleMirroredIssue(ctx, request)),
    });
    ctx.plane = ordered.plane; ctx.github = ordered.github;
    const issue = (title: string) => ({ number: 31, title, body: "b", state: "open", labels: [{ name: "plane" }], assignees: [] });
    await handleGithubIssue(ctx, ghJob("issues", { action: "labeled", label: { name: "plane" }, issue: issue("Mirror me") }));
    // the create is still queued when the edit arrives
    await handleGithubIssue(ctx, ghJob("issues", { action: "edited", changes: { title: { from: "Mirror me" } }, issue: issue("Mirror me, renamed") }));
    strictEqual(h.plane.createdIssueIds.length, 0);

    const done = new Set<string>();
    for (let round = 0; round < 40; round++) {
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
    const edited = h.plane.writes().filter((c) => /\/comments\/$/.test(c.path) && JSON.stringify(c.body).includes("edited-rule")).length;
    strictEqual(edited, 1, "the edit's rule ran once, after the link existed");
    ok(h.plane.writes().some((c) => c.method === "PATCH" && c.body?.name === "Mirror me, renamed"), "the edit's new title reached the Plane item");
  } finally { await h.close(); }
});

async function planeOriginSetup() {
  const h = await makeHarness();
  await h.mapping({ smartCommits: false, policies: { title: "last_write_wins" } }); // the default title policy keeps Plane edits out of GitHub
  const planeQ = queue(), githubQ = queue();
  const ctx: any = { ...h.ctx };
  const ordered = createOrderedOutbox({
    db: h.db, plane: h.ctx.plane as any, github: h.ctx.github as any,
    queues: { plane: planeQ as any, github: githubQ as any },
    loadActorToken: async () => null,
    findPlaneLinkId: (target, url) => findLinkId(ctx, target, url),
    resumeReducer: (request) => (request.kind === "mirror_pending" ? handlePendingMirroredIssue(ctx, request) : handleMirroredIssue(ctx, request)),
  });
  ctx.plane = ordered.plane; ctx.github = ordered.github;
  h.gh.respond(/POST \/repos\/\{owner\}\/\{repo\}\/issues$/, () => ({ id: 5001, number: 55 }));
  const drain = async () => {
    const done = new Set<string>();
    for (let round = 0; round < 40; round++) {
      let progressed = false;
      for (const [side, q] of [["plane", planeQ], ["github", githubQ]] as const) {
        for (const [id, job] of q.jobs) {
          if (done.has(id)) continue;
          try { await (side === "plane" ? ordered.executePlane(job) : ordered.executeGithub(job)); done.add(id); progressed = true; } catch { /* deferred behind a predecessor */ }
        }
      }
      if (!progressed) break;
    }
  };
  const optIn = () => handlePlaneIssue(ctx, planeJob("issue", { action: "update", data: { id: "i9", project: "p-qll", name: "Ship it", labels: [LABELS[0]], description_html: "<p>d</p>" }, activity: { field: "label_ids", old_value: [], new_value: [LABELS[0]!.id], actor: { id: "u-human", email: "human@test.local" } } }));
  return { h, ctx, drain, optIn };
}

test("F1: a Plane-origin edit received while its GitHub partner is still being created is replayed once the link exists", async () => {
  const { h, ctx, drain, optIn } = await planeOriginSetup();
  try {
    await optIn();
    await handlePlaneIssue(ctx, planeJob("issue", { action: "update", data: { id: "i9", project: "p-qll", name: "Ship it, renamed" }, activity: { field: "name", old_value: "Ship it", new_value: "Ship it, renamed", actor: { id: "u-human", email: "human@test.local" } } }));
    strictEqual(h.gh.writes().length, 0, "registration only");
    await drain();
    ok(h.gh.writes().some((c) => c.route === "POST /repos/{owner}/{repo}/issues"), "the GitHub issue was created");
    const patch = h.gh.writes().find((c) => /^PATCH /.test(c.route));
    ok(patch, "the pending edit reached GitHub");
    strictEqual(patch!.params.title, "Ship it, renamed");
    strictEqual(patch!.params.issue_number, 55);
  } finally { await h.close(); }
});

test("F1: a Plane comment received while the GitHub partner is still being created is posted once the link exists", async () => {
  const { h, ctx, drain, optIn } = await planeOriginSetup();
  try {
    await optIn();
    await handlePlaneIssue(ctx, planeJob("issue_comment", { action: "create", data: { id: "c1", issue: "i9", project: "p-qll", comment_html: "<p>hello from plane</p>", actor: { display_name: "Pat" } }, activity: { actor: { id: "u-human", email: "human@test.local" } } }));
    await drain();
    const comments = h.gh.writes().filter((c) => /issues\/\{issue_number\}\/comments$/.test(c.route));
    strictEqual(comments.length, 1);
    ok(String(comments[0]!.params.body).includes("hello from plane"));
    strictEqual(comments[0]!.params.issue_number, 55);
  } finally { await h.close(); }
});
