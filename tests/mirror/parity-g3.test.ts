// Parity plan wave 1, G3: C4 (per-mapping open/closed states, Plane completed/cancelled → GitHub `state_reason`)
// and C5 (one Plane link and one GitHub comment per mirrored pair, durable, gated by linkback).
import test, { afterEach } from "node:test";
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../../src/db/migrate.ts";
import { upsertSyncLink } from "../../src/db/ledgers.ts";
import { githubStateForGroup, markdownLiteral, mirrorStateFor, onGithubIssue, onPlaneIssue } from "../../src/sync/mirror.ts";
import type { MirrorDeps, MirrorMapping } from "../../src/sync/mirror.ts";
import { createOrderedOutbox, deliveryScope } from "../../src/app/writers.ts";
import { handleGithubIssue, handleMirroredIssue, handlePendingMirroredIssue, handlePlaneIssue } from "../../src/app/issues.ts";
import { QLL, fakeGithubWriter, fakePlaneWriter } from "../github/fakes.ts";
import { LABELS, ghJob, makeHarness, planeJob, prPayload } from "../a8/harness.ts";
import { intentJob, queue } from "../writers/outbox-fixture.ts";
import { GithubWritePath } from "../../src/sync/github.ts";
import { opHash } from "../../src/sync/ophash.ts";

const databases: PGlite[] = [];
afterEach(async () => { for (const db of databases.splice(0)) await db.close(); });

async function setup(opts: { mapping?: Partial<MirrorMapping>; linkback?: boolean; open?: string | null; closed?: string | null; deps?: Partial<MirrorDeps> } = {}) {
  const db = new PGlite();
  databases.push(db);
  await db.waitReady;
  await migrate(db);
  // Migration 010 (G4) adds these; the guard keeps this file independent of the order the two land in.
  await db.query("ALTER TABLE repo_mappings ADD COLUMN IF NOT EXISTS open_state_id TEXT");
  await db.query("ALTER TABLE repo_mappings ADD COLUMN IF NOT EXISTS closed_state_id TEXT");
  await db.query(`INSERT INTO repo_mappings (id, workspace_slug, gh_repo_id, gh_repo_full_name, plane_project_id, sync_direction, linkback_enabled, open_state_id, closed_state_id)
    VALUES (1, 'qelal', 555, 'acme/web', 'p-qll', 'bidirectional', $1, $2, $3)`, [opts.linkback ?? true, opts.open ?? null, opts.closed ?? null]);
  for (const f of ["title", "description", "state", "assignees", "labels"]) await db.query(`INSERT INTO conflict_policies (mapping_id, field, policy) VALUES (1, $1, 'last_write_wins')`, [f]);
  await upsertSyncLink(db, { planeWorkspaceSlug: "qelal", planeProjectId: "p-qll", planeIssueId: "pi-1", ghRepoId: 555, ghNumber: 41, ghKind: "issue", tier: "relation", createdBy: "label_sync" });
  const plane = fakePlaneWriter();
  const github = fakeGithubWriter();
  const deps: MirrorDeps = {
    db, plane, github,
    mapping: { id: 1, workspaceSlug: "qelal", planeProjectId: "p-qll", ghRepoId: 555, syncDirection: "bidirectional", installationId: 9, owner: "acme", repo: "web", ...opts.mapping },
    users: { planeUserIdForGithubLogin: async () => null, githubLoginForPlaneUserId: async () => null },
    listStates: async () => QLL,
    planeIssueUrl: (slug, pid, id) => `https://tasks.example/${slug}/projects/${pid}/issues/${id}`,
    ...opts.deps,
  };
  return { db, plane, github, deps };
}

const ghIssue = (o: object = {}) => ({ number: 41, title: "T", body: "b", state: "open", labels: [{ name: "plane" }], assignees: [], ...o });
const stateWrite = (plane: ReturnType<typeof fakePlaneWriter>) => (plane.writes.find((w) => w.kind === "update_issue") as any)?.fields?.state;
const planeStateJob = (state: { id: string; group: string }) => ({ event: "issue",
  payload: { action: "updated", data: { id: "pi-1", project: "p-qll", state }, activity: { field: "state_id" } } });

// ---- C4 ---------------------------------------------------------------------------------------------------
test("C4: mirrorStateFor uses the chosen state, skips triage and gone states, and falls back to the defaults", () => {
  const chosen = { openStateId: "s-prog", closedStateId: "s-wont" };
  deepStrictEqual(mirrorStateFor(QLL, true, chosen), { ok: true, stateId: "s-wont", chosen: true });
  deepStrictEqual(mirrorStateFor(QLL, false, chosen), { ok: true, stateId: "s-prog", chosen: true });
  deepStrictEqual(mirrorStateFor(QLL, true, { openStateId: null, closedStateId: "s-gone" }), { ok: true, stateId: "s-done", chosen: false });
  deepStrictEqual(mirrorStateFor(QLL, false, { openStateId: "s-triage", closedStateId: null }), { ok: true, stateId: "s-todo", chosen: false });
  strictEqual(mirrorStateFor(QLL, false, { openStateId: null, closedStateId: null }, { openFallback: false }).ok, false);
});

test("C4: a closed and a reopened GitHub issue move the Plane item to the mapping's chosen states (read from the row)", async () => {
  const { plane, deps } = await setup({ open: "s-prog", closed: "s-wont" });
  await onGithubIssue({ action: "closed", issue: ghIssue({ state: "closed" }), repository: { id: 555 } }, deps);
  strictEqual(stateWrite(plane), "s-wont");
  plane.writes.length = 0;
  await onGithubIssue({ action: "reopened", issue: ghIssue({ state: "open" }), repository: { id: 555 } }, deps);
  strictEqual(stateWrite(plane), "s-prog");
});

test("C4: values on the mapping win over the row", async () => {
  const { plane, deps } = await setup({ closed: "s-wont", mapping: { closedStateId: "s-review", openStateId: null, linkbackEnabled: true } });
  await onGithubIssue({ action: "closed", issue: ghIssue({ state: "closed" }), repository: { id: 555 } }, deps);
  strictEqual(stateWrite(plane), "s-review");
});

test("C4: a chosen state that was deleted falls back to the default completed state and is audited", async () => {
  const { db, plane, deps } = await setup({ closed: "s-deleted" });
  await onGithubIssue({ action: "closed", issue: ghIssue({ state: "closed" }), repository: { id: 555 } }, deps);
  strictEqual(stateWrite(plane), "s-done");
  const audit = (await db.query<{ detail: any }>("SELECT detail FROM audit_log WHERE kind = 'mirror_state_fallback'")).rows;
  strictEqual(audit.length, 1);
  strictEqual(audit[0]!.detail.chosenStateId, "s-deleted");
  strictEqual(audit[0]!.detail.usedStateId, "s-done");
});

test("C4: without chosen states the mirror keeps today's defaults and audits nothing", async () => {
  const { db, plane, deps } = await setup();
  await onGithubIssue({ action: "closed", issue: ghIssue({ state: "closed" }), repository: { id: 555 } }, deps);
  strictEqual(stateWrite(plane), "s-done");
  strictEqual((await db.query("SELECT 1 FROM audit_log WHERE kind = 'mirror_state_fallback'")).rows.length, 0);
});

test("C4: Plane completed closes as completed, cancelled as not_planned, any other group reopens", async () => {
  deepStrictEqual(githubStateForGroup("completed"), { state: "closed", state_reason: "completed" });
  deepStrictEqual(githubStateForGroup("cancelled"), { state: "closed", state_reason: "not_planned" });
  deepStrictEqual(githubStateForGroup("started"), { state: "open", state_reason: "reopened" });
  for (const [state, want] of [[{ id: "s-wont", group: "cancelled" }, { state: "closed", state_reason: "not_planned" }],
    [{ id: "s-done", group: "completed" }, { state: "closed", state_reason: "completed" }],
    [{ id: "s-todo", group: "unstarted" }, { state: "open", state_reason: "reopened" }]] as const) {
    const { github, deps } = await setup();
    await onPlaneIssue(planeStateJob(state), deps);
    const w = github.writes.find((x) => x.kind === "update_issue");
    deepStrictEqual(w.fields, want);
    strictEqual(w.number, 41);
  }
});

test("C4: a GitHub issue created closed lands in the chosen closed state; an open one in the chosen open state", async () => {
  const closed = await setup({ closed: "s-wont", open: "s-prog" });
  await onGithubIssue({ action: "opened", issue: ghIssue({ number: 7, state: "closed" }), repository: { id: 555 } }, closed.deps);
  strictEqual((closed.plane.writes.find((w) => w.kind === "create_issue") as any).fields.state, "s-wont");
  const open = await setup({ open: "s-prog" });
  await onGithubIssue({ action: "opened", issue: ghIssue({ number: 7 }), repository: { id: 555 } }, open.deps);
  strictEqual((open.plane.writes.find((w) => w.kind === "create_issue") as any).fields.state, "s-prog");
  const none = await setup();
  await onGithubIssue({ action: "opened", issue: ghIssue({ number: 7 }), repository: { id: 555 } }, none.deps);
  strictEqual((none.plane.writes.find((w) => w.kind === "create_issue") as any).fields.state, undefined, "Plane's own default applies");
});

test("C4: the GitHub write path sends state_reason but records only the state as an echo", async () => {
  const { db } = await setup();
  const calls: { route: string; params: any }[] = [];
  const octokit = { request: async (route: string, params: any) => { calls.push({ route, params }); return { data: { id: 1 }, status: 200, headers: {} }; } };
  const path = new GithubWritePath({ app: { installationOctokit: async () => octokit }, db });
  await path.apply({ kind: "update_issue", installationId: 9, owner: "acme", repo: "web", repoId: 555, number: 41,
    fields: { state: "closed", state_reason: "not_planned" } });
  deepStrictEqual(calls.map((c) => [c.route, c.params]), [["PATCH /repos/{owner}/{repo}/issues/{issue_number}",
    { owner: "acme", repo: "web", issue_number: 41, state: "closed", state_reason: "not_planned" }]]);
  const hashes = (await db.query<{ op_hash: string }>("SELECT op_hash FROM applied_ops")).rows.map((r) => r.op_hash);
  deepStrictEqual(hashes, [opHash("github", "555#41", "state", "closed")]);
});

// ---- C5, direct write path ----------------------------------------------------------------------------------
test("C5: a GitHub → Plane pair gets one Plane link to the issue and one GitHub comment to the item", async () => {
  const { plane, github, deps } = await setup();
  await onGithubIssue({ action: "opened", issue: ghIssue({ number: 7, html_url: "https://github.com/acme/web/issues/7" }), repository: { id: 555 } }, deps);
  const links = plane.writes.filter((w) => w.kind === "add_link") as any[];
  strictEqual(links.length, 1);
  strictEqual(links[0].url, "https://github.com/acme/web/issues/7");
  strictEqual(links[0].title, "GitHub issue acme/web#7");
  // The fake Plane writer answers write n with `id-<n>`.
  strictEqual(links[0].issueId, `id-${plane.writes.findIndex((w) => w.kind === "create_issue") + 1}`);
  const comments = github.writes.filter((w) => w.kind === "comment");
  strictEqual(comments.length, 1);
  strictEqual(comments[0].number, 7);
  ok(comments[0].body.includes("https://tasks.example/qelal/projects/p-qll/issues/"));
});

test("C5: linkback off posts neither the link nor the GitHub comment", async () => {
  const { plane, github, deps } = await setup({ linkback: false });
  await onGithubIssue({ action: "opened", issue: ghIssue({ number: 7, html_url: "https://github.com/acme/web/issues/7" }), repository: { id: 555 } }, deps);
  strictEqual(plane.writes.filter((w) => w.kind === "add_link").length, 0);
  strictEqual(github.writes.filter((w) => w.kind === "comment").length, 0);
  strictEqual(plane.writes.filter((w) => w.kind === "create_issue").length, 1, "the mirror itself still happens");
});

test("C5: a Plane → GitHub pair links the new issue on the configured GitHub host and comments once", async () => {
  const { plane, github, deps } = await setup({ deps: { githubWebOrigin: "https://git.example.com/" } });
  await onPlaneIssue({ event: "issue", payload: { action: "created", data: { id: "pi-new", project: "p-qll", name: "N", description_html: "<p>d</p>",
    labels: [{ id: LABELS[0]!.id, name: "github" }] } } }, deps);
  const created = github.writes.find((w) => w.kind === "create_issue");
  ok(created);
  const number = 900 + github.writes.indexOf(created) + 1;
  const links = plane.writes.filter((w) => w.kind === "add_link") as any[];
  strictEqual(links.length, 1);
  strictEqual(links[0].url, `https://git.example.com/acme/web/issues/${number}`);
  strictEqual(links[0].issueId, "pi-new");
  const comments = github.writes.filter((w) => w.kind === "comment");
  strictEqual(comments.length, 1);
  strictEqual(comments[0].number, number);
  ok(comments[0].body.includes("/issues/pi-new"));
});

test("C5: a Plane → GitHub pair with linkback off adds no link and no comment", async () => {
  const { plane, github, deps } = await setup({ linkback: false });
  await onPlaneIssue({ event: "issue", payload: { action: "created", data: { id: "pi-new", project: "p-qll", name: "N",
    labels: [{ id: LABELS[0]!.id, name: "github" }] } } }, deps);
  strictEqual(plane.writes.filter((w) => w.kind === "add_link").length, 0);
  strictEqual(github.writes.filter((w) => w.kind === "comment").length, 0);
});

// ---- C5, durable outbox ----------------------------------------------------------------------------------
async function outboxHarness(linkback: boolean) {
  const h = await makeHarness();
  await h.mapping({ smartCommits: false, linkback });
  const planeQ = queue(), githubQ = queue(), ctx = { ...h.ctx };
  const outbox = createOrderedOutbox({ db: h.db, plane: h.ctx.plane as any, github: h.ctx.github as any,
    queues: { plane: planeQ as any, github: githubQ as any }, loadActorToken: async () => null,
    resumeReducer: (request) => request.kind === "mirror_pending" ? handlePendingMirroredIssue(ctx, request) : handleMirroredIssue(ctx, request) });
  ctx.plane = outbox.plane; ctx.github = outbox.github;
  const drain = async () => {
    for (let step = 0; step < 30; step++) {
      const row = (await h.db.query<{ id: string; side: string }>("SELECT id, side FROM outbound_writes WHERE status = 'pending' ORDER BY sequence LIMIT 1")).rows[0];
      if (!row) return;
      const wake = await intentJob(h.db, row.id);
      if (row.side === "plane") await outbox.executePlane(wake); else await outbox.executeGithub(wake);
    }
    throw new Error("outbox fixture exceeded 30 steps");
  };
  const linkPosts = () => h.plane.calls.filter((c) => c.method === "POST" && /\/links\/$/.test(c.path));
  const ghComments = () => h.gh.writes().filter((c) => /\/comments$/.test(c.route));
  return { h, ctx, drain, linkPosts, ghComments };
}

const ghOpened = () => ghJob("issues", { action: "opened", installation: { id: 1 }, repository: { id: 555, full_name: "acme/web" },
  sender: { login: "unmapped", id: 1, type: "User" },
  issue: { number: 3, title: "Title", state: "open", labels: [{ name: "plane" }], html_url: "https://github.com/acme/web/issues/3" } });

test("C5: through the outbox a GitHub → Plane pair gets exactly one link and one comment, also after replays", async () => {
  const { h, ctx, drain, linkPosts, ghComments } = await outboxHarness(true);
  try {
    const job = ghOpened();
    await deliveryScope.run({ deliveryId: `github-${job.deliveryId}` }, () => handleGithubIssue(ctx, job));
    // A replay while the create is still pending, then another after it completed.
    await deliveryScope.run({ deliveryId: `github-${job.deliveryId}` }, () => handleGithubIssue(ctx, job));
    await drain();
    await deliveryScope.run({ deliveryId: `github-${job.deliveryId}` }, () => handleGithubIssue(ctx, job));
    await drain();
    strictEqual(h.plane.createdIssueIds.length, 1);
    strictEqual(linkPosts().length, 1);
    strictEqual(linkPosts()[0]!.body.url, "https://github.com/acme/web/issues/3");
    ok(linkPosts()[0]!.path.includes(h.plane.createdIssueIds[0]!));
    strictEqual(ghComments().length, 1);
    strictEqual(ghComments()[0]!.params.issue_number, 3);
  } finally { await h.close(); }
});

test("C5: through the outbox, linkback off registers no cross-link work", async () => {
  const { h, ctx, drain, linkPosts, ghComments } = await outboxHarness(false);
  try {
    const job = ghOpened();
    await deliveryScope.run({ deliveryId: `github-${job.deliveryId}` }, () => handleGithubIssue(ctx, job));
    await drain();
    strictEqual(h.plane.createdIssueIds.length, 1);
    strictEqual(linkPosts().length, 0);
    strictEqual(ghComments().length, 0);
  } finally { await h.close(); }
});

test("C5: through the outbox a Plane → GitHub pair links the created issue number once, also after a replay", async () => {
  const { h, ctx, drain, linkPosts, ghComments } = await outboxHarness(true);
  try {
    const job = planeJob("issue", { action: "created", data: { id: "iss-1", project: "p-qll", name: "Title", description_html: "<p>Body</p>", labels: [LABELS[0]] } });
    await deliveryScope.run({ deliveryId: "plane-created" }, () => handlePlaneIssue(ctx, job));
    await drain();
    await deliveryScope.run({ deliveryId: "plane-created" }, () => handlePlaneIssue(ctx, job));
    await drain();
    const creates = h.gh.writes().filter((c) => c.route === "POST /repos/{owner}/{repo}/issues");
    strictEqual(creates.length, 1);
    const number = (await h.db.query<{ gh_number: number }>("SELECT gh_number FROM sync_links WHERE created_by = 'label_sync' AND plane_issue_id = 'iss-1'")).rows[0]!.gh_number;
    strictEqual(linkPosts().length, 1);
    ok(linkPosts()[0]!.path.includes("iss-1"));
    strictEqual(linkPosts()[0]!.body.url, `https://github.com/acme/web/issues/${number}`);
    strictEqual(ghComments().length, 1);
    strictEqual(ghComments()[0]!.params.issue_number, number);
  } finally { await h.close(); }
});

// ---- C2 attribution (wave 2c): Plane users' own changes carry asUser; automated writes do not -------------------
const linkUser = (db: PGlite, id: string, ghId: number) =>
  db.query("INSERT INTO user_map (workspace_slug, plane_user_id, gh_login, gh_id) VALUES ('qelal', $1, $2, $3)", [id, `gh-${id}`, ghId]);

test("C2 attribution: a Plane comment by a linked user is written to GitHub as that user; an unlinked author keeps the service identity", async () => {
  const { db, github, deps } = await setup();
  await linkUser(db, "u-lin", 501);
  const comment = (actor: string) => ({ event: "issue_comment", payload: { action: "created",
    data: { id: `c-${actor}`, issue: "pi-1", comment_html: "<p>hi</p>", actor: { id: actor, display_name: actor } }, activity: { actor: { id: actor } } } });
  await onPlaneIssue(comment("u-lin"), deps);
  await onPlaneIssue(comment("u-stranger"), deps);
  const writes = github.writes.filter((w) => w.kind === "comment");
  strictEqual(writes.length, 2);
  strictEqual(writes[0].asUser, "u-lin");
  ok(writes[0].body.includes("commented in Plane"), "the attribution line stays for the service-identity fallback");
  strictEqual("asUser" in writes[1], false);
});

test("C2 attribution: a field edit by a linked Plane user carries asUser on every GitHub write it makes", async () => {
  const { db, github, deps } = await setup();
  await linkUser(db, "u-lin", 501);
  await onPlaneIssue({ event: "issue", payload: { action: "updated", data: { id: "pi-1", project: "p-qll", name: "Renamed" },
    activity: { field: "name", actor: { id: "u-lin" } } } }, deps);
  await onPlaneIssue({ event: "issue", payload: { action: "updated", data: { id: "pi-1", project: "p-qll", state: { id: "s-done", group: "completed" } },
    activity: { field: "state_id", actor: { id: "u-lin" } } } }, deps);
  await onPlaneIssue({ event: "issue", payload: { action: "updated", data: { id: "pi-1", project: "p-qll", name: "Other" },
    activity: { field: "name", actor: { id: "u-stranger" } } } }, deps);
  deepStrictEqual(github.writes.map((w) => [w.kind, w.asUser]), [["update_issue", "u-lin"], ["update_issue", "u-lin"], ["update_issue", undefined]]);
});

test("C2 attribution: creates and cross-link comments stay on the service identity even when a linked user triggered them", async () => {
  const { db, github, deps } = await setup();
  await linkUser(db, "u-lin", 501);
  await onPlaneIssue({ event: "issue", payload: { action: "created", data: { id: "pi-new", project: "p-qll", name: "N",
    labels: [{ id: LABELS[0]!.id, name: "github" }] }, activity: { actor: { id: "u-lin" } } } }, deps);
  ok(github.writes.length >= 2);
  ok(github.writes.every((w) => !("asUser" in w)));
});

// ---- C6/C7: mentions and issue references through G2's converter (src/sync/text.ts) ---------------------------
const mappedUsers: MirrorDeps["users"] = {
  planeUserIdForGithubLogin: async (login) => (login.toLowerCase() === "octo" ? "u-octo" : null),
  githubLoginForPlaneUserId: async (id) => (id === "u-octo" ? "Octo" : null),
};
const MENTION_OCTO = `<mention-component entity_identifier="u-octo" entity_name="user_mention"></mention-component>`;
const ghComment = (body: string) => ({ action: "created", repository: { id: 555 }, issue: ghIssue(),
  comment: { user: { login: "mona" }, body, html_url: "https://github.com/acme/web/issues/41#c9" } });

test("C6/C7: a GitHub comment's mentions and references become Plane mentions and links; code is untouched", async () => {
  const { plane, deps } = await setup({ deps: { users: mappedUsers } });
  await onGithubIssue(ghComment("Hi @Octo and @stranger, see #7, other/x#9 and https://github.com/acme/web/issues/3.\n\n`@Octo #7` stays"), deps);
  const html = (plane.writes.find((w) => w.kind === "add_comment") as any).commentHtml as string;
  ok(html.includes(MENTION_OCTO), html);
  ok(html.includes(`<a href="https://github.com/stranger">@stranger</a>`), html);
  ok(html.includes(`<a href="https://github.com/acme/web/issues/7">acme/web#7</a>`), html);
  ok(html.includes(`<a href="https://github.com/other/x/issues/9">other/x#9</a>`), html);
  ok(html.includes(`<a href="https://github.com/acme/web/issues/3">acme/web#3</a>`), html);
  ok(html.includes(`<code>@Octo #7</code>`), html);
});

test("C7: references link to the configured GitHub host, never a hardcoded github.com", async () => {
  const { plane, deps } = await setup({ deps: { users: mappedUsers, githubWebOrigin: "https://git.example.com" } });
  await onGithubIssue({ action: "edited", changes: { body: { from: "x" } }, repository: { id: 555 },
    issue: ghIssue({ body: "Fixes #7 and @stranger" }) }, deps);
  const html = (plane.writes.find((w) => w.kind === "update_issue") as any).fields.description_html as string;
  ok(html.includes(`<a href="https://git.example.com/acme/web/issues/7">acme/web#7</a>`), html);
  ok(html.includes(`<a href="https://git.example.com/stranger">@stranger</a>`), html);
  ok(!html.includes("https://github.com"), html);
});

test("C6: a created Plane item gets the converted description", async () => {
  const { plane, deps } = await setup({ deps: { users: mappedUsers } });
  await onGithubIssue({ action: "opened", repository: { id: 555 }, issue: ghIssue({ number: 7, body: "cc @octo" }) }, deps);
  ok(((plane.writes.find((w) => w.kind === "create_issue") as any).fields.description_html as string).includes(MENTION_OCTO));
});

test("C6: Plane mentions become @login for a linked user and the display name otherwise, in comments and descriptions", async () => {
  const { github, deps } = await setup({ deps: { users: mappedUsers, planeUserDisplayName: async (id) => (id === "u-ana" ? "Ana Bekele" : null) } });
  const mentions = `<p>ping ${MENTION_OCTO} and <mention-component entity_identifier="u-ana" entity_name="user_mention"></mention-component></p><pre><code>@keep #1</code></pre>`;
  await onPlaneIssue({ event: "issue_comment", payload: { action: "created",
    data: { id: "c1", issue: "pi-1", comment_html: mentions, actor: { id: "u-x", display_name: "X" } } } }, deps);
  await onPlaneIssue({ event: "issue", payload: { action: "updated", data: { id: "pi-1", project: "p-qll", description_html: mentions },
    activity: { field: "description_html" } } }, deps);
  const comment = github.writes.find((w) => w.kind === "comment").body as string;
  const body = github.writes.find((w) => w.kind === "update_issue").fields.body as string;
  for (const text of [comment, body]) {
    ok(text.includes("ping @Octo and Ana Bekele"), text);
    ok(text.includes("```\n@keep #1\n```"), text);
  }
});

test("C6/C7: a mirrored description round trip settles after one step, so mirrored edits cannot loop", async () => {
  const { plane, github, deps } = await setup({ deps: { users: mappedUsers } });
  const fromGithub = async (body: string) => {
    plane.writes.length = 0;
    await onGithubIssue({ action: "edited", changes: { body: { from: "x" } }, repository: { id: 555 }, issue: ghIssue({ body }) }, deps);
    return (plane.writes.find((w) => w.kind === "update_issue") as any).fields.description_html as string;
  };
  const fromPlane = async (html: string) => {
    github.writes.length = 0;
    await onPlaneIssue({ event: "issue", payload: { action: "updated", data: { id: "pi-1", project: "p-qll", description_html: html },
      activity: { field: "description_html" } } }, deps);
    return github.writes.find((w) => w.kind === "update_issue").fields.body as string;
  };
  const html1 = await fromGithub("Hi @Octo, see #7 and `#8`");
  const text1 = await fromPlane(html1);
  strictEqual(text1, "Hi @Octo, see acme/web#7 and `#8`", "references come back in canonical form, code as it was");
  strictEqual(await fromGithub(text1), html1, "the canonical text maps to the same Plane HTML");
  strictEqual(await fromPlane(html1), text1, "and back to the same GitHub text: a fixpoint, so each echo matches its hash");
});

// ---- N2 (pr.ts): an unresolved work-item key is reported once on the PR, edited in place when the set changes ----
async function prReportHarness(reportProblems: boolean) {
  const h = await makeHarness();
  await h.mapping({ smartCommits: false });
  await h.db.query("UPDATE repo_mappings SET report_problems = $1", [reportProblems]);
  // The harness sender (HUMAN, GitHub id 1) is a linked member; reports are only for linked senders.
  await h.db.query("INSERT INTO user_map (workspace_slug, plane_user_id, gh_login, gh_id) VALUES ('ws', 'u-octo', 'octo', 1) ON CONFLICT DO NOTHING");
  const outbox = createOrderedOutbox({ db: h.db, plane: h.ctx.plane as any, github: h.ctx.github as any,
    queues: { plane: queue() as any, github: queue() as any }, loadActorToken: async () => null });
  h.ctx.plane = outbox.plane; h.ctx.github = outbox.github;
  const reports = async () => (await h.db.query<{ write: any }>(
    "SELECT write FROM outbound_writes WHERE write->>'kind' = 'problem_report' ORDER BY sequence")).rows.map((r) => r.write);
  return { h, reports };
}
const prJob = (body: string, action = "opened") => ghJob("pull_request", prPayload(action, {}, { body }));

test("N2: a PR key that names no work item registers one report on the PR, and a replay registers nothing new", async () => {
  const { h, reports } = await prReportHarness(true);
  try {
    await h.feed(prJob("Fixes QLL-99"));
    await h.feed(prJob("Fixes QLL-99", "edited"));
    const r = await reports();
    strictEqual(r.length, 1, "the same unresolved set reuses its intent");
    deepStrictEqual(r[0].target, { kind: "issue", number: 12 });
    ok(r[0].body.includes("QLL-99 does not match a work item"), r[0].body);
    ok(r[0].body.includes(`<!-- git-sync-problem:${r[0].key} -->`));
  } finally { await h.close(); }
});

test("N2: a changed unresolved set updates the same report (same key, new content), not a second comment", async () => {
  const { h, reports } = await prReportHarness(true);
  try {
    await h.feed(prJob("Fixes QLL-99"));
    await h.feed(prJob("Fixes QLL-98 and QLL-99", "edited"));
    const r = await reports();
    strictEqual(r.length, 2);
    strictEqual(r[0].key, r[1].key, "one remote comment identity per PR");
    ok(r[1].body.includes("QLL-98") && r[1].body.includes("QLL-99"));
  } finally { await h.close(); }
});

test("N2: with report_problems off, or when every key resolves, nothing is reported", async () => {
  const off = await prReportHarness(false);
  try {
    await off.h.feed(prJob("Fixes QLL-99"));
    strictEqual((await off.reports()).length, 0);
  } finally { await off.h.close(); }
  const on = await prReportHarness(true);
  try {
    await on.h.feed(prJob("Fixes QLL-2"));
    strictEqual((await on.reports()).length, 0, "QLL-2 exists in the harness");
  } finally { await on.h.close(); }
});

// ---- security-audit self-review fixes ----------------------------------------------------------------------
test("security N2: an unlinked sender gets no report, so outsiders cannot probe which Plane keys exist", async () => {
  const { h, reports } = await prReportHarness(true);
  try {
    await h.db.query("DELETE FROM user_map");
    await h.feed(prJob("Fixes QLL-99"));
    strictEqual((await reports()).length, 0);
  } finally { await h.close(); }
});

test("security C6: a Plane display name cannot mention, link or format on GitHub", async () => {
  strictEqual(markdownLiteral("Ana Bekele"), "Ana Bekele");
  const evil = markdownLiteral("x** @acme/security [click](https://evil.example) ![t](https://evil.example/p.png)\nline");
  ok(!evil.includes("@"), evil);
  ok(!/(^|[^\\])[\[\]()!*]/.test(evil), evil);
  ok(!evil.includes("\n"));
  const { github, deps } = await setup({ deps: { users: mappedUsers, planeUserDisplayName: async () => "@acme/everyone [x](https://evil.example)" } });
  await onPlaneIssue({ event: "issue_comment", payload: { action: "created", data: { id: "c1", issue: "pi-1",
    comment_html: `<p>hi <mention-component entity_identifier="u-z" entity_name="user_mention"></mention-component></p>`,
    actor: { id: "u-x", display_name: "**@acme/team**" } } } }, deps);
  const body = github.writes.find((w) => w.kind === "comment").body as string;
  ok(!body.includes("@acme"), body);
  ok(!body.includes("](https://evil.example)"), body);
});
