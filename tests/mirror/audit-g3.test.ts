// Docs-audit fix pass, G3: G6 (complete review reads), G10 (GitHub deliveries out of order), P3 (Plane deliveries
// out of order), plus the pr.ts part of G15 (readiness after a stage change) and the issues.ts part of G2.
import test, { afterEach } from "node:test";
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../../src/db/migrate.ts";
import { upsertSyncLink } from "../../src/db/ledgers.ts";
import { freshest, onGithubIssue, onPlaneIssue } from "../../src/sync/mirror.ts";
import type { MirrorDeps } from "../../src/sync/mirror.ts";
import { listPrReviews, staleLifecycle } from "../../src/app/pr.ts";
import { planeInstallation } from "../../src/app/issues.ts";
import type { AppContext } from "../../src/app/context.ts";
import type { Mapping } from "../../src/app/mappings.ts";
import { QLL, fakeGithubWriter, fakePlaneWriter } from "../github/fakes.ts";
import { ghJob, makeHarness, prPayload, sha } from "../a8/harness.ts";

const databases: PGlite[] = [];
afterEach(async () => { for (const db of databases.splice(0)) await db.close(); });

const OLD = "2026-10-01T10:00:00Z", NEW = "2026-10-01T10:05:00Z";

async function setup(extra: Partial<MirrorDeps> = {}) {
  const db = new PGlite();
  databases.push(db);
  await db.waitReady;
  await migrate(db);
  await db.query(`INSERT INTO repo_mappings (id, workspace_slug, gh_repo_id, gh_repo_full_name, plane_project_id, sync_direction) VALUES (1, 'qelal', 555, 'acme/web', 'p-qll', 'bidirectional')`);
  await db.query(`INSERT INTO user_map (workspace_slug, plane_user_id, gh_login, gh_id) VALUES ('qelal', 'u-octo', 'octo', 1), ('qelal', 'u-mona', 'mona', 2)`);
  // Every field last-write-wins, so only ordering decides the outcome.
  for (const f of ["title", "description", "state", "assignees", "labels"]) await db.query(`INSERT INTO conflict_policies (mapping_id, field, policy) VALUES (1, $1, 'last_write_wins')`, [f]);
  await upsertSyncLink(db, { planeWorkspaceSlug: "qelal", planeProjectId: "p-qll", planeIssueId: "pi-1", ghRepoId: 555, ghNumber: 41, ghKind: "issue", tier: "relation", createdBy: "label_sync" });
  const plane = fakePlaneWriter();
  const github = fakeGithubWriter();
  const deps: MirrorDeps = {
    db, plane, github,
    mapping: { id: 1, workspaceSlug: "qelal", planeProjectId: "p-qll", ghRepoId: 555, syncDirection: "bidirectional", installationId: 9, owner: "acme", repo: "web" },
    users: { planeUserIdForGithubLogin: async () => null, githubLoginForPlaneUserId: async (id) => ({ "u-octo": "octo", "u-mona": "mona" })[id] ?? null },
    listStates: async () => QLL,
    ...extra,
  };
  return { plane, github, deps };
}

const ghIssue = (o: object = {}) => ({ number: 41, title: "Old title", body: "old", state: "open", labels: [{ name: "plane" }], assignees: [], updated_at: OLD, ...o });

test("freshest: a newer read wins, an older or unstamped read leaves the delivery, and omitted fields are kept", () => {
  const delivered = { name: "a", state: "s1", updated_at: OLD };
  deepStrictEqual(freshest(delivered, { name: "b", updated_at: NEW }), { name: "b", state: "s1", updated_at: NEW });
  strictEqual(freshest(delivered, { name: "b", updated_at: "2026-09-01T00:00:00Z" }), delivered);
  strictEqual(freshest(delivered, { name: "b" }), delivered);
  strictEqual(freshest(delivered, null), delivered);
  strictEqual(freshest({ name: "a" }, { name: "b", updated_at: NEW }).name, "b");
});

test("G10: a delayed GitHub title edit mirrors the current title, not the delivered one", async () => {
  const { plane, deps } = await setup({ currentGithubIssue: async () => ghIssue({ title: "New title", updated_at: NEW }) });
  const r = await onGithubIssue({ action: "edited", changes: { title: { from: "x" } }, issue: ghIssue(), repository: { id: 555 } }, deps);
  strictEqual(r.action, "updated");
  strictEqual((plane.writes.find((w) => w.kind === "update_issue") as any).fields.name, "New title");
});

test("G10: a delayed `closed` after the issue was reopened leaves the Plane item unstarted", async () => {
  const { plane, deps } = await setup({ currentGithubIssue: async () => ghIssue({ state: "open", updated_at: NEW }) });
  await onGithubIssue({ action: "closed", issue: ghIssue({ state: "closed" }), repository: { id: 555 } }, deps);
  const write = plane.writes.find((w) => w.kind === "update_issue") as any;
  strictEqual(QLL.find((s) => s.id === write.fields.state)?.group, "unstarted");
});

test("G10: a delayed assignment mirrors GitHub's current assignees; a gone issue keeps the delivery", async () => {
  const { plane, deps } = await setup({ currentGithubIssue: async () => ghIssue({ assignees: [{ id: 2, login: "mona" }], updated_at: NEW }) });
  await onGithubIssue({ action: "assigned", issue: ghIssue({ assignees: [{ id: 1, login: "octo" }] }), repository: { id: 555 } }, deps);
  deepStrictEqual((plane.writes.find((w) => w.kind === "update_issue") as any).fields.assignees, ["u-mona"]);
  const gone = await setup({ currentGithubIssue: async () => null });
  await onGithubIssue({ action: "edited", changes: { title: {} }, issue: ghIssue(), repository: { id: 555 } }, gone.deps);
  strictEqual((gone.plane.writes.find((w) => w.kind === "update_issue") as any).fields.name, "Old title");
});

test("G10: a failed GitHub read fails the delivery instead of applying a possibly stale snapshot", async () => {
  const { plane, deps } = await setup({ currentGithubIssue: async () => { throw Object.assign(new Error("boom"), { status: 502 }); } });
  let failed = false;
  try { await onGithubIssue({ action: "edited", changes: { title: {} }, issue: ghIssue(), repository: { id: 555 } }, deps); } catch { failed = true; }
  ok(failed);
  strictEqual(plane.writes.length, 0);
});

const planeEvent = (field: string, data: object, activity: object = {}) => ({ event: "issue", payload: {
  action: "updated", data: { id: "pi-1", project: "p-qll", name: "Old name", labels: [], updated_at: OLD, ...data }, activity: { field, ...activity } } });

test("P3: a stale Plane rename delivered last mirrors the item's current name", async () => {
  const { github, deps } = await setup({ currentPlaneIssue: async () => ({ id: "pi-1", name: "Newest name", updated_at: NEW }) });
  await onPlaneIssue(planeEvent("name", { name: "Older name" }), deps);
  strictEqual(github.writes[0].fields.title, "Newest name");
});

test("P3: a stale assignee delivery mirrors the item's current assignees, not activity.new_value", async () => {
  const { github, deps } = await setup({ currentPlaneIssue: async () => ({ id: "pi-1", assignees: ["u-mona"], updated_at: NEW }) });
  await onPlaneIssue(planeEvent("assignees", { assignees: ["u-octo"] }, { old_value: [], new_value: ["u-octo"] }), deps);
  deepStrictEqual(github.writes[0].assignees, ["mona"]);
});

test("P3: a stale state delivery mirrors the item's current state group", async () => {
  const done = QLL.find((s) => s.group === "completed")!, todo = QLL.find((s) => s.group === "unstarted")!;
  const { github, deps } = await setup({ currentPlaneIssue: async () => ({ id: "pi-1", state: todo.id, updated_at: NEW }) });
  await onPlaneIssue(planeEvent("state", { state: { id: done.id, group: "completed" } }), deps);
  strictEqual(github.writes[0].fields.state, "open");
});

test("P3: a read older than the delivery, and a label diff, use the delivery", async () => {
  let reads = 0;
  const { github, deps } = await setup({ currentPlaneIssue: async () => { reads++; return { id: "pi-1", name: "Ancient", updated_at: "2026-09-01T00:00:00Z" }; } });
  await onPlaneIssue(planeEvent("name", { name: "Delivered" }), deps);
  strictEqual(github.writes[0].fields.title, "Delivered");
  await onPlaneIssue(planeEvent("labels", { labels: [{ id: "l-bug", name: "bug" }] }, { old_value: [], new_value: ["l-bug"] }), deps);
  strictEqual(reads, 1); // label diffs need no read
  deepStrictEqual(github.writes[1].labels, ["bug"]);
});

// ---- G6: complete chronological review reads ----------------------------------------------------------

const review = (i: number, state = "COMMENTED", login = `r${i}`) => ({ id: i, state, user: { login } });

test("G6: reviews are read across every page, following the link header", async () => {
  const pages = [Array.from({ length: 100 }, (_, i) => review(i)), [review(100, "APPROVED", "a"), review(101, "CHANGES_REQUESTED", "a")]];
  const seen: number[] = [];
  const octokit = { request: async (_route: string, params: any) => {
    seen.push(params.page);
    return { data: pages[params.page - 1], headers: params.page === 1 ? { link: '<https://api.github.com/x?page=2>; rel="next"' } : { link: '<https://api.github.com/x?page=1>; rel="first"' } };
  } } as any;
  const read = await listPrReviews(octokit, { owner: "acme", repo: "web" }, 12);
  deepStrictEqual(seen, [1, 2]);
  strictEqual(read.complete, true);
  strictEqual(read.items.length, 102);
  strictEqual(read.items.at(-1)!.state, "CHANGES_REQUESTED");
});

test("G6/G16: the shared reader reports its page bound as incomplete and rejects a non-list page", async () => {
  let calls = 0;
  const full = { request: async () => { calls++; return { data: Array.from({ length: 100 }, (_, i) => review(i)), headers: {} }; } } as any;
  strictEqual((await listPrReviews(full, { owner: "acme", repo: "web" }, 12)).complete, false);
  strictEqual(calls, 100, "readPrReviews' bound, shared with readiness");
  const odd = { request: async () => ({ data: { message: "nope" } }) } as any;
  await rejects(() => listPrReviews(odd, { owner: "acme", repo: "web" }, 12));
  const short = { request: async () => ({ data: [review(1, "APPROVED")] }) } as any;
  deepStrictEqual(await listPrReviews(short, { owner: "acme", repo: "web" }, 12), { items: [{ state: "APPROVED", user: { login: "r1" } }], complete: true });
});

test("G6/G16: an incomplete review read leaves the rollup at REVIEW, never a decision from a partial list", async () => {
  const h = await makeHarness();
  try {
    await h.mapping({ smartCommits: false });
    await h.link("iss-1", 12, { kind: "pr" });
    h.gh.respond(/pulls\/\{pull_number\}\/reviews$/, () => Array.from({ length: 100 }, (_, i) => review(i, "APPROVED")));
    await h.feed(ghJob("pull_request", prPayload("synchronize")));
    const link = h.plane.calls.find((c) => /\/links\/$/.test(c.path) && c.method !== "GET");
    ok(link, "a rollup link was written");
    ok(String(link!.body.title).includes("REVIEW") && !String(link!.body.title).includes("APPROVAL"), String(link!.body.title));
  } finally { await h.close(); }
});

test("G6: the PR rollup reflects a change request on the second page of reviews", async () => {
  const h = await makeHarness();
  try {
    await h.mapping({ smartCommits: false });
    await h.link("iss-1", 12, { kind: "pr" });
    h.gh.respond(/pulls\/\{pull_number\}\/reviews$/, (params) => params.page === 1
      ? [review(0, "APPROVED", "rev"), ...Array.from({ length: 99 }, (_, i) => review(i + 1))]
      : [review(200, "CHANGES_REQUESTED", "rev")]);
    await h.feed(ghJob("pull_request", prPayload("synchronize")));
    const link = h.plane.calls.find((c) => /\/links\/$/.test(c.path) && c.method !== "GET");
    ok(link, "a rollup link was written");
    ok(String(link!.body.title).includes("REJECTED"), String(link!.body.title));
  } finally { await h.close(); }
});

// ---- G10: PR lifecycle and rollup out of order ----------------------------------------------------------

test("G10: staleLifecycle rejects triggers the PR's current state contradicts", () => {
  const open = { state: "open", merged: false, draft: false }, draft = { ...open, draft: true };
  const closed = { state: "closed", merged: false }, merged = { state: "closed", merged: true };
  strictEqual(staleLifecycle("pull_request.closed_unmerged", open), true);
  strictEqual(staleLifecycle("pull_request.closed_unmerged", closed), false);
  strictEqual(staleLifecycle("pull_request.opened", merged), true);
  strictEqual(staleLifecycle("pull_request.opened", draft), true);
  strictEqual(staleLifecycle("pull_request.opened", open), false);
  strictEqual(staleLifecycle("pull_request.drafted", open), true);
  strictEqual(staleLifecycle("pull_request.drafted", draft), false);
  strictEqual(staleLifecycle("pull_request.reopened", closed), true);
  strictEqual(staleLifecycle("pull_request.approved", merged), true);
  strictEqual(staleLifecycle("pull_request.merged", open), false);
});

test("G10: a `closed` delivered after the PR was reopened runs no rule and the rollup stays OPEN", async () => {
  const h = await makeHarness();
  try {
    await h.mapping({ smartCommits: false, rules: "- when: pull_request.closed_unmerged\n  then: [{ comment: closed }]\n" });
    await h.link("iss-1", 12, { kind: "pr" });
    h.gh.respond(/pulls\/\{pull_number\}$/, () => ({ number: 12, title: "Fix login (v2)", state: "open", merged: false, draft: false, html_url: "https://github.com/acme/web/pull/12", head: { ref: "octo/login", sha: sha("b") }, updated_at: NEW }));
    await h.feed(ghJob("pull_request", prPayload("closed", {}, { state: "closed", updated_at: OLD })));
    strictEqual(h.plane.writes().filter((c) => /\/comments\/$/.test(c.path)).length, 0);
    ok((await h.audit("rule_match")).some((a: any) => a.outcome === "ignored" && a.detail.trigger === "pull_request.closed_unmerged"));
    const link = h.plane.calls.find((c) => /\/links\/$/.test(c.path) && c.method !== "GET");
    ok(String(link!.body.title).includes("Fix login (v2)") && String(link!.body.title).includes("OPEN"), String(link!.body.title));
  } finally { await h.close(); }
});

// ---- G15 (pr.ts part): readiness after ready_for_review -------------------------------------------------

test("G15: marking an approved, green draft ready for review fires ready_for_merge", async () => {
  const h = await makeHarness();
  try {
    await h.mapping({ smartCommits: false, rules: "- when: pull_request.ready_for_merge\n  then: [{ comment: ready }]\n" });
    await h.link("iss-1", 12, { kind: "pr" });
    const head = { ref: "octo/login", sha: sha("c") };
    h.gh.respond(/pulls\/\{pull_number\}$/, () => ({ number: 12, title: "Fix login", state: "open", merged: false, draft: false, head, updated_at: NEW }));
    h.gh.respond(/pulls\/\{pull_number\}\/reviews$/, () => [review(1, "APPROVED", "rev")]);
    h.gh.respond(/commits\/\{ref\}\/check-suites$/, () => ({ check_suites: [{ status: "completed", conclusion: "success" }] }));
    // Readiness now fails closed on a combined-status reply without a `state` (pr-automation `checkPrReadiness`), so the
    // fake answers as GitHub does for a commit with no statuses: "pending" with total_count 0.
    h.gh.respond(/commits\/\{ref\}\/status$/, () => ({ state: "pending", total_count: 0, statuses: [] }));
    await h.feed(ghJob("pull_request", prPayload("ready_for_review", {}, { head, updated_at: OLD })));
    strictEqual(h.plane.writes().filter((c) => /\/comments\/$/.test(c.path)).length, 1);
    strictEqual((await h.audit("ready_for_merge")).length, 1);
  } finally { await h.close(); }
});

test("G15: a late ready_for_review for a PR that is a draft again does not fire", async () => {
  const h = await makeHarness();
  try {
    await h.mapping({ smartCommits: false, rules: "- when: pull_request.ready_for_merge\n  then: [{ comment: ready }]\n" });
    await h.link("iss-1", 12, { kind: "pr" });
    const head = { ref: "octo/login", sha: sha("d") };
    h.gh.respond(/pulls\/\{pull_number\}$/, () => ({ number: 12, state: "open", merged: false, draft: true, head, updated_at: NEW }));
    h.gh.respond(/pulls\/\{pull_number\}\/reviews$/, () => [review(1, "APPROVED", "rev")]);
    h.gh.respond(/commits\/\{ref\}\/check-suites$/, () => ({ check_suites: [{ status: "completed", conclusion: "success" }] }));
    h.gh.respond(/commits\/\{ref\}\/status$/, () => ({ state: "pending", total_count: 0, statuses: [] })); // green otherwise: only the draft blocks it
    await h.feed(ghJob("pull_request", prPayload("ready_for_review", {}, { head, updated_at: OLD })));
    strictEqual((await h.audit("ready_for_merge")).length, 0);
  } finally { await h.close(); }
});

// ---- G2 (issues.ts part): the shared classifier decides "not installed" ------------------------------------

test("G2: a headerless secondary rate limit is retried, a permission 403 means not installed", async () => {
  const mapping = { id: 1, workspaceSlug: "ws", owner: "acme", repo: "web", installationId: null } as unknown as Mapping;
  const ctxFor = (err: unknown) => ({ db: {} as any, ghClient: { installationIdFor: async () => { throw err; } } }) as unknown as AppContext;
  const httpError = (status: number, message: string) => Object.assign(new Error(message), { status, response: { status, headers: { "x-ratelimit-remaining": "4000" }, data: { message } } });
  const secondary = httpError(403, "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.");
  let thrown: unknown = null;
  try { await planeInstallation(ctxFor(secondary), mapping); } catch (err) { thrown = err; }
  strictEqual(thrown, secondary);
  strictEqual(await planeInstallation(ctxFor(httpError(404, "Not Found")), mapping), 0);
  strictEqual(await planeInstallation(ctxFor(httpError(403, "Resource not accessible by integration")), mapping), 0);
});
