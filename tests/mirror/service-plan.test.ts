import test from "node:test";
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { createOrderedOutbox, deliveryScope } from "../../src/app/writers.ts";
import { handlePlaneIssue, handleGithubIssue, handleMirroredIssue, handlePendingMirroredIssue } from "../../src/app/issues.ts";
import { makeHarness, planeJob, ghJob, LABELS } from "../a8/harness.ts";
import { queue, intentJob } from "../writers/outbox-fixture.ts";

test("F1/F2: the production assignee wrapper forwards plans for Plane-to-GitHub opt-in creates", async () => {
  const h = await makeHarness();
  try {
    await h.mapping({ smartCommits: false });
    const planeQ = queue(), githubQ = queue(), ctx = { ...h.ctx };
    const outbox = createOrderedOutbox({ db: h.db, plane: h.ctx.plane as any, github: h.ctx.github as any,
      queues: { plane: planeQ as any, github: githubQ as any }, loadActorToken: async () => null });
    ctx.plane = outbox.plane; ctx.github = outbox.github;
    const job = planeJob("issue", { action: "created", data: { id: "iss-1", project: "p-qll", name: "Title", description_html: "<p>Body</p>", labels: [LABELS[0]] } });
    await deliveryScope.run({ deliveryId: "plane-created" }, () => handlePlaneIssue(ctx, job));
    strictEqual(h.gh.writes().length, 0, "create should only register durable work");
    strictEqual((await h.db.query("SELECT 1 FROM pending_sync_links")).rows.length, 1);
    for (let step = 0; step < 10; step++) {
      const row = (await h.db.query<{ id: string; side: string }>("SELECT id, side FROM outbound_writes WHERE status = 'pending' ORDER BY sequence LIMIT 1")).rows[0];
      if (!row) break;
      const wake = await intentJob(h.db, row.id);
      if (row.side === "plane") await outbox.executePlane(wake); else await outbox.executeGithub(wake);
    }
    strictEqual((await h.db.query("SELECT 1 FROM sync_links WHERE created_by = 'label_sync'")).rows.length, 1);
    ok(h.plane.writes().some((c) => /comments\/$/.test(c.path)), "Plane cross-link comment was not continued");
  } finally { await h.close(); }
});

test("F1: a GitHub opt-in create durably resumes its original issue rule for the new target", async () => {
  const h = await makeHarness();
  try {
    await h.mapping({ smartCommits: false, rules: "- when: issue.opened\n  then: [{comment: original-creation-rule}]\n" });
    const ctx = { ...h.ctx }, planeQ = queue(), githubQ = queue();
    const outbox = createOrderedOutbox({ db: h.db, plane: h.ctx.plane as any, github: h.ctx.github as any,
      queues: { plane: planeQ as any, github: githubQ as any }, loadActorToken: async () => null,
      resumeReducer: (request) => request.kind === "mirror_pending" ? handlePendingMirroredIssue(ctx, request) : handleMirroredIssue(ctx, request) });
    ctx.plane = outbox.plane; ctx.github = outbox.github;
    const job = ghJob("issues", { action: "opened", installation: { id: 1 }, repository: { id: 555, full_name: "acme/web" },
      sender: { login: "unmapped", id: 1, type: "User" }, issue: { number: 3, title: "Title", state: "open", labels: [{ name: "plane" }] } });
    await deliveryScope.run({ deliveryId: `github-${job.deliveryId}` }, () => handleGithubIssue(ctx, job));
    strictEqual(h.plane.createdIssueIds.length, 0);
    strictEqual((await h.audit("rule_match")).length, 0);
    planeQ.jobs.clear(); githubQ.jobs.clear(); await outbox.recover();
    for (let step = 0; step < 20; step++) {
      const row = (await h.db.query<{ id: string; side: string }>("SELECT id, side FROM outbound_writes WHERE status = 'pending' ORDER BY sequence LIMIT 1")).rows[0];
      if (!row) break;
      const wake = await intentJob(h.db, row.id);
      if (row.side === "plane") await outbox.executePlane(wake); else await outbox.executeGithub(wake);
    }
    strictEqual(h.plane.createdIssueIds.length, 1);
    const ruleComments = h.plane.writes().filter((c) => c.body?.comment_html?.includes("original-creation-rule"));
    strictEqual(ruleComments.length, 1);
    ok(ruleComments[0]!.path.includes(h.plane.createdIssueIds[0]!));
    strictEqual((await h.audit("rule_match")).filter((r) => r.outcome === "applied").length, 1);
    // The partner now exists, so replay takes the ordinary inbound rule path. Its write identity must
    // match the earlier continuation, rather than minting a second comment under another namespace.
    await deliveryScope.run({ deliveryId: `github-${job.deliveryId}` }, () => handleGithubIssue(ctx, job));
    strictEqual((await h.db.query("SELECT 1 FROM outbound_writes WHERE status = 'pending'")).rows.length, 0);
    strictEqual(h.plane.writes().filter((c) => c.body?.comment_html?.includes("original-creation-rule")).length, 1);
  } finally { await h.close(); }
});

test("F1: a fast worker cannot run the original mirrored-issue rule twice", async () => {
  const h = await makeHarness();
  try {
    await h.mapping({ smartCommits: false, rules: "- when: issue.opened\n  then: [{comment: one-creation-rule}]\n" });
    const ctx = { ...h.ctx }, planeQ = queue(), githubQ = queue();
    const outbox = createOrderedOutbox({ db: h.db, plane: h.ctx.plane as any, github: h.ctx.github as any,
      queues: { plane: planeQ as any, github: githubQ as any }, loadActorToken: async () => null,
      resumeReducer: (request) => request.kind === "mirror_pending" ? handlePendingMirroredIssue(ctx, request) : handleMirroredIssue(ctx, request) });
    const drain = async () => {
      for (let step = 0; step < 20; step++) {
        const row = (await h.db.query<{ id: string; side: string }>("SELECT id, side FROM outbound_writes WHERE status = 'pending' ORDER BY sequence LIMIT 1")).rows[0];
        if (!row) return;
        const wake = await intentJob(h.db, row.id);
        if (row.side === "plane") await outbox.executePlane(wake); else await outbox.executeGithub(wake);
      }
      throw new Error("continuation fixture exceeded 20 steps");
    };
    ctx.plane = { ...outbox.plane, plan: async (...args) => { const result = await outbox.plane.plan(...args); await drain(); return result; } };
    ctx.github = outbox.github;
    const job = ghJob("issues", { action: "opened", installation: { id: 1 }, repository: { id: 555, full_name: "acme/web" },
      sender: { login: "unmapped", id: 1, type: "User" }, issue: { number: 3, title: "Title", state: "open", labels: [{ name: "plane" }] } });
    await deliveryScope.run({ deliveryId: `github-${job.deliveryId}` }, () => handleGithubIssue(ctx, job));
    await drain();
    strictEqual(h.plane.writes().filter((c) => c.body?.comment_html?.includes("one-creation-rule")).length, 1);
    strictEqual((await h.audit("rule_match")).length, 1);
  } finally { await h.close(); }
});

test("F1/F2: an edit received while the partner is pending resumes its fields and rule after creation", async () => {
  const h = await makeHarness();
  try {
    await h.mapping({ smartCommits: false, rules: "- when: issue.edited\n  then: [{comment: deferred-edit-rule}]\n" });
    const ctx = { ...h.ctx }, planeQ = queue(), githubQ = queue();
    const outbox = createOrderedOutbox({ db: h.db, plane: h.ctx.plane as any, github: h.ctx.github as any,
      queues: { plane: planeQ as any, github: githubQ as any }, loadActorToken: async () => null,
      resumeReducer: (request) => request.kind === "mirror_pending" ? handlePendingMirroredIssue(ctx, request) : handleMirroredIssue(ctx, request) });
    ctx.plane = outbox.plane; ctx.github = outbox.github;
    const initial = { action: "opened", installation: { id: 1 }, repository: { id: 555, full_name: "acme/web" },
      sender: { login: "unmapped", id: 1, type: "User" }, issue: { number: 3, title: "Old", state: "open", labels: [{ name: "plane" }] } };
    const open = ghJob("issues", initial), edit = ghJob("issues", { ...initial, action: "edited", changes: { title: { from: "Old" } }, issue: { ...initial.issue, title: "New" } });
    for (const job of [open, edit]) await deliveryScope.run({ deliveryId: `github-${job.deliveryId}` }, () => handleGithubIssue(ctx, job));
    strictEqual((await h.db.query("SELECT 1 FROM outbound_writes WHERE write->'continuation'->'job'->'payload'->>'action' = 'edited'")).rows.length, 1,
      "pending partner edit was lost instead of durably deferred");
    const tick = async () => {
      const row = (await h.db.query<{ id: string; side: string }>("SELECT id, side FROM outbound_writes WHERE status = 'pending' ORDER BY sequence LIMIT 1")).rows[0];
      if (!row) return false;
      const wake = await intentJob(h.db, row.id);
      if (row.side === "plane") await outbox.executePlane(wake); else await outbox.executeGithub(wake);
      return true;
    };
    // Linking is earlier than the original rules' continuation. A later delivery must still join
    // the fence, otherwise its newer fields can be overwritten when the older edit resumes.
    for (let step = 0; step < 10; step++) {
      if ((await h.db.query("SELECT 1 FROM sync_links")).rows.length) break;
      ok(await tick());
    }
    strictEqual((await h.db.query("SELECT 1 FROM sync_links")).rows.length, 1);
    strictEqual((await h.db.query("SELECT 1 FROM pending_sync_links")).rows.length, 1);
    const newer = ghJob("issues", { ...initial, action: "edited", changes: { title: { from: "New" } }, issue: { ...initial.issue, title: "Newest" } });
    const comment = ghJob("issue_comment", { ...initial, action: "created", comment: { body: "pending-comment", user: { login: "unmapped" } } });
    for (const job of [newer, comment]) await deliveryScope.run({ deliveryId: `github-${job.deliveryId}` }, () => handleGithubIssue(ctx, job));
    planeQ.jobs.clear(); githubQ.jobs.clear(); await outbox.recover();
    for (let step = 0; step < 30; step++) if (!await tick()) break;
    strictEqual((await h.db.query("SELECT 1 FROM outbound_writes WHERE status = 'pending'")).rows.length, 0);
    strictEqual((await h.db.query("SELECT 1 FROM pending_sync_links")).rows.length, 0);
    strictEqual(h.plane.createdIssueIds.length, 1);
    deepStrictEqual(h.plane.writes().filter((c) => c.method === "PATCH").map((c) => c.body?.name), ["New", "Newest"]);
    strictEqual(h.plane.writes().filter((c) => c.body?.comment_html?.includes("deferred-edit-rule")).length, 2);
    strictEqual(h.plane.writes().filter((c) => c.body?.comment_html?.includes("pending-comment")).length, 1);
    // Replay now takes the ordinary path; it must reuse the pending callback's identities.
    await deliveryScope.run({ deliveryId: `github-${edit.deliveryId}` }, () => handleGithubIssue(ctx, edit));
    strictEqual((await h.db.query("SELECT 1 FROM outbound_writes WHERE status = 'pending'")).rows.length, 0);
  } finally { await h.close(); }
});

test("F1/F2: pending Plane edits and comments reach GitHub once without repeating Plane rules", async () => {
  const h = await makeHarness();
  try {
    await h.mapping({ smartCommits: false, policies: { title: "last_write_wins" }, rules: "- when: issue.updated\n  then: [{comment: plane-edit-rule}]\n" });
    const ctx = { ...h.ctx }, planeQ = queue(), githubQ = queue();
    const outbox = createOrderedOutbox({ db: h.db, plane: h.ctx.plane as any, github: h.ctx.github as any,
      queues: { plane: planeQ as any, github: githubQ as any }, loadActorToken: async () => null,
      resumeReducer: (request) => handlePendingMirroredIssue(ctx, request) });
    ctx.plane = outbox.plane; ctx.github = outbox.github;
    const data = { id: "iss-1", project: "p-qll", name: "Old", description_html: "<p>Body</p>", labels: [LABELS[0]] };
    const open = planeJob("issue", { action: "created", data });
    const edit = planeJob("issue", { action: "updated", data: { ...data, name: "New" }, activity: { field: "name", old_value: "Old", new_value: "New" } });
    const comment = planeJob("issue_comment", { action: "created", data: { id: "pc-1", issue: "iss-1", project: "p-qll", comment_html: "<p>pending-plane-comment</p>" } });
    for (const job of [open, edit, comment]) await deliveryScope.run({ deliveryId: `plane-${job.deliveryId}`, workspaceSlug: "ws" }, () => handlePlaneIssue(ctx, job));
    strictEqual(h.gh.writes().length, 0);
    strictEqual((await h.db.query("SELECT 1 FROM outbound_writes WHERE write->'continuation'->>'kind' = 'mirror_pending'")).rows.length, 2);
    planeQ.jobs.clear(); githubQ.jobs.clear(); await outbox.recover();
    for (let step = 0; step < 30; step++) {
      const row = (await h.db.query<{ id: string; side: string }>("SELECT id, side FROM outbound_writes WHERE status = 'pending' ORDER BY sequence LIMIT 1")).rows[0];
      if (!row) break;
      const wake = await intentJob(h.db, row.id);
      if (row.side === "plane") await outbox.executePlane(wake); else await outbox.executeGithub(wake);
    }
    strictEqual((await h.db.query("SELECT 1 FROM outbound_writes WHERE status = 'pending'")).rows.length, 0);
    strictEqual((await h.db.query("SELECT 1 FROM pending_sync_links")).rows.length, 0);
    strictEqual(h.gh.writes().filter((c) => c.route === "POST /repos/{owner}/{repo}/issues").length, 1);
    strictEqual(h.gh.writes().filter((c) => c.params.title === "New").length, 1);
    strictEqual(h.gh.writes().filter((c) => c.params.body?.includes("pending-plane-comment")).length, 1);
    strictEqual(h.plane.writes().filter((c) => c.body?.comment_html?.includes("plane-edit-rule")).length, 1);
  } finally { await h.close(); }
});
