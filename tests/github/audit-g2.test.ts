import test from "node:test";
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { compareDeploymentVersions, handleChecks, handleCommitStatus } from "../../src/app/checks.ts";
import { handlePush, listCommitRange } from "../../src/app/push.ts";
import { handleCreatedPr, handlePullRequest } from "../../src/app/pr.ts";
import { mappingsForRepo } from "../../src/app/mappings.ts";
import { checkPrReadiness, githubRepositoryWebUrl, prEventToRuleEvent, readGithubCollection, shouldReevaluatePrReadiness } from "../../src/github/pr-automation.ts";
import type { OctokitRequest } from "../../src/github/pr-automation.ts";
import { MAX_RANGE_COMMITS, PUSH_PAYLOAD_COMMIT_LIMIT, SmartCommitRetry, processPush } from "../../src/github/smart-commits.ts";
import type { SmartCommitDeps } from "../../src/github/smart-commits.ts";
import { backfill } from "../../src/operations/tooling.ts";
import { PlaneRateLimitError, UnknownPlaneState } from "../../src/sync/plane.ts";
import { createOrderedOutbox, deliveryScope } from "../../src/app/writers.ts";
import { nextWriteJobId } from "../../src/operations/outbox.ts";
import { queue } from "../writers/outbox-fixture.ts";
import { fakePlaneWriter, freshDb, QLL } from "./fakes.ts";
import { ghJob, makeHarness, prPayload, REPO, sha } from "../a8/harness.ts";

const HEAD = sha("a");
const WEB_REPO = { ...REPO, html_url: "https://git.example/acme/web" };
const repo = { owner: "acme", repo: "web" };
const request = (fn: (route: string, params: any) => any): OctokitRequest => ({
  request: async (route, params) => fn(route, params),
});
const currentPr = (number = 12, extra: any = {}) => ({ number, state: "open", draft: false, merged: false,
  title: "Fix QLL-1", body: "Fixes QLL-1", html_url: `https://git.example/acme/web/pull/${number}`,
  head: { sha: HEAD, ref: "fix/qll-1", repo: { id: 999 } }, base: { ref: "main", repo: WEB_REPO },
  labels: [], user: { login: "octo" }, ...extra });
const links = (h: Awaited<ReturnType<typeof makeHarness>>) => h.plane.writes().filter((c) => /\/links\/$/.test(c.path));
const comments = (h: Awaited<ReturnType<typeof makeHarness>>) => h.plane.writes().filter((c) => /\/comments\/$/.test(c.path));

function readinessClient(over: { reviews?: (page: number) => any[]; suites?: (page: number) => any; error?: any } = {}) {
  return request((route, p) => {
    if (route.endsWith("/reviews")) return { data: over.reviews?.(p.page) ?? [{ user: { id: 1 }, state: "APPROVED" }] };
    if (route.endsWith("/check-suites")) return { data: over.suites?.(p.page) ?? { check_suites: [] } };
    if (route.endsWith("/status")) {
      if (over.error) throw over.error;
      return { data: { state: "success", total_count: 1 } };
    }
    throw new Error(route);
  });
}

function configureChecks(h: Awaited<ReturnType<typeof makeHarness>>, pr: any = currentPr()) {
  h.gh.respond(/commits\/\{commit_sha\}\/pulls$/, () => []);
  h.gh.respond(/pulls\/\{pull_number\}$/, (p) => p.pull_number === pr.number ? pr : currentPr(p.pull_number));
  h.gh.respond(/commits\/\{ref\}\/check-suites$/, () => ({ check_suites: [], total_count: 0 }));
  h.gh.respond(/commits\/\{ref\}\/check-runs$/, () => ({ check_runs: [{ conclusion: "success" }], total_count: 1 }));
  h.gh.respond(/pulls\/\{pull_number\}\/reviews$/, () => [{ user: { id: 1, login: "reviewer" }, state: "APPROVED" }]);
  h.gh.respond(/commits\/\{ref\}\/status$/, () => ({ state: "success", total_count: 1 }));
}

const suiteJob = (extra: any = {}) => ghJob("check_suite", { repository: WEB_REPO, action: "completed",
  check_suite: { head_sha: HEAD, conclusion: "success", pull_requests: [], head_repository: { id: 999 }, ...extra } });

test("G5/G9/G11: fork CI paginates latest runs; page-two failure reaches the GHES rollup and suite rules", async () => {
  const h = await makeHarness();
  try {
    await h.mapping({ smartCommits: false, rules: "- when: check_suite.success\n  if: { base_branch: '^main$' }\n  then: [{ comment: suite-rule }]\n" });
    await h.link("iss-1", 12, { kind: "pr" });
    configureChecks(h);
    h.gh.respond(/commits\/\{ref\}\/check-runs$/, (p) => ({ total_count: 101,
      check_runs: p.page === 1 ? Array.from({ length: 100 }, () => ({ conclusion: "success" })) : [{ conclusion: "failure" }] }));
    await handleChecks(h.ctx, suiteJob());
    const build = links(h).find((c) => c.body.title.startsWith("[CI]"));
    strictEqual(build?.body.title, "[CI] Build · fail");
    strictEqual(build?.body.url, "https://git.example/acme/web/pull/12/checks");
    ok(comments(h).some((c) => c.body.comment_html.includes("suite-rule")));
    const reads = h.gh.calls.filter((c) => c.route.endsWith("/check-runs"));
    deepStrictEqual(reads.map((c) => c.params.page), [1, 2]);
    ok(reads.every((c) => c.params.filter === "latest" && c.params.per_page === 100));
  } finally { await h.close(); }
});

test("G5: more than 1,000 suites never publishes a falsely passing aggregate", async () => {
  const h = await makeHarness();
  try {
    await h.mapping({ smartCommits: false }); await h.link("iss-1", 12, { kind: "pr" }); configureChecks(h);
    h.gh.respond(/commits\/\{ref\}\/check-suites$/, (p) => ({ total_count: 1001,
      check_suites: Array.from({ length: p.page <= 10 ? 100 : 1 }, () => ({ status: "completed", conclusion: "success" })) }));
    await rejects(handleChecks(h.ctx, suiteJob()), /1,000-suite/);
    strictEqual(links(h).length, 0);
    strictEqual((await h.audit("build_incomplete"))[0].outcome, "partial");
  } finally { await h.close(); }
});

test("G7: an already introduced SHA still evaluates linked open PRs, with exact current-head and base checks", async () => {
  const h = await makeHarness();
  try {
    await h.mapping({ smartCommits: false, rules: "- when: pull_request.ready_for_merge\n  then: [{ comment: ready }]\n" });
    for (const n of [12, 13, 14]) await h.link("iss-1", n, { kind: "pr" });
    configureChecks(h);
    h.gh.respond(/pulls\/\{pull_number\}$/, (p) => currentPr(p.pull_number,
      p.pull_number === 13 ? { head: { sha: sha("b") } } : p.pull_number === 14 ? { base: { repo: { id: 123 } } } : {}));
    await handleCommitStatus(h.ctx, ghJob("status", { repository: WEB_REPO, sha: HEAD, state: "success" }));
    strictEqual(comments(h).length, 1);
    deepStrictEqual((await h.audit("ready_for_merge")).map((a) => a.detail.number), [12]);
  } finally { await h.close(); }
});

test("G7/G11: deployment associations paginate past 100 and fallback links preserve GHES", async () => {
  const h = await makeHarness();
  try {
    await h.mapping({ smartCommits: false }); await h.link("iss-1", 101, { kind: "pr" });
    h.gh.respond(/commits\/\{commit_sha\}\/pulls$/, (p) => p.page === 1
      ? Array.from({ length: 100 }, (_, i) => ({ number: i + 1 })) : [{ number: 101 }]);
    await handleChecks(h.ctx, ghJob("deployment_status", { repository: WEB_REPO,
      deployment: { id: 501, created_at: "2026-10-12T10:00:00Z", sha: HEAD, environment: "production" }, deployment_status: { id: 601, created_at: "2026-10-12T10:01:00Z", state: "success" } }));
    strictEqual(links(h)[0]?.body.url, "https://git.example/acme/web/pull/101");
    deepStrictEqual(h.gh.calls.filter((c) => c.route.endsWith("/pulls")).map((c) => c.params.page), [1, 2]);
  } finally { await h.close(); }
});

test("G9: a fork candidate with another head repository cannot receive build links or suite rules", async () => {
  const h = await makeHarness();
  try {
    await h.mapping({ smartCommits: false, rules: "- when: check_suite.success\n  then: [{ comment: wrong-fork }]\n" });
    await h.link("iss-1", 12, { kind: "pr" }); configureChecks(h);
    await handleChecks(h.ctx, suiteJob({ head_repository: { id: 1234 } }));
    strictEqual(links(h).length, 0); strictEqual(comments(h).length, 0);
  } finally { await h.close(); }
});

test("G11: new branch navigation uses the payload's verified repository HTML URL", async () => {
  const h = await makeHarness();
  try {
    await h.mapping({ smartCommits: false });
    await handlePush(h.ctx, ghJob("push", { repository: WEB_REPO, created: true, before: sha("0"), after: HEAD,
      ref: "refs/heads/fix/QLL-1", commits: [] }));
    strictEqual(links(h)[0]?.body.url, "https://git.example/acme/web/tree/fix/QLL-1");
  } finally { await h.close(); }
});

test("G11: missing webhook HTML URL resolves the configured server's repository URL", async () => {
  let calls = 0;
  const client = request(() => { calls++; return { data: WEB_REPO }; });
  strictEqual(await githubRepositoryWebUrl(client, { ...repo, id: 555 }, { ...WEB_REPO, id: 123 }), WEB_REPO.html_url);
  strictEqual(calls, 1);
  strictEqual(await githubRepositoryWebUrl(request(() => ({ data: {} })), { ...repo, id: 555 }, undefined,
    "https://git.example/api/v3"), WEB_REPO.html_url);
});

test("G8: compare reads beyond 3,000 in chronological order and exposes incompleteness at 10,000", async () => {
  const h = await makeHarness();
  try {
    await h.mapping({ smartCommits: false });
    const [mapping] = await mappingsForRepo(h.db, 555);
    let total = 3101;
    h.gh.respond(/compare\/\{basehead\}$/, (p) => ({ total_commits: total,
      commits: Array.from({ length: Math.min(100, total - (p.page - 1) * 100) }, (_, i) => {
        const n = (p.page - 1) * 100 + i;
        return { sha: n.toString(16).padStart(40, "0"), commit: { message: `commit ${n}` } };
      }) }));
    const complete = await listCommitRange(h.ctx, mapping!, { installation: { id: 1 } }, sha("b"), HEAD);
    strictEqual(complete.complete, true); strictEqual(complete.items.length, 3101);
    strictEqual(complete.items[3000]?.message, "commit 3000");
    total = MAX_RANGE_COMMITS + 1;
    const partial = await listCommitRange(h.ctx, mapping!, { installation: { id: 1 } }, sha("b"), HEAD);
    strictEqual(partial.complete, false); strictEqual(partial.items.length, MAX_RANGE_COMMITS); strictEqual(partial.nextPage, 101);
  } finally { await h.close(); }
});

async function smartSetup(over: Partial<SmartCommitDeps> = {}) {
  const db = await freshDb(); const writer = fakePlaneWriter();
  const deps: SmartCommitDeps = { db, writer, users: { planeUserIdForGithubLogin: async () => null }, vault: { load: async () => null },
    mapping: { workspaceSlug: "ws", smartCommitsEnabled: true }, requireVerified: false,
    listStates: async () => QLL, resolveIssue: async () => ({ projectId: "p-qll", issueId: "iss-1" }),
    getCommitVerified: async () => true, ...over };
  return { db, writer, deps };
}

const largePush = () => ({ repository: REPO, sender: { login: "bot", type: "Bot" }, before: sha("b"), after: HEAD,
  commits: Array.from({ length: PUSH_PAYLOAD_COMMIT_LIMIT }, (_, n) => ({ id: n.toString(16).padStart(40, "0"), message: "ordinary commit" })) });

test("G8: partial compare metadata writes one truncation audit and deduplicates fetched commands", async () => {
  const command = { id: HEAD, message: "QLL-1 #comment once" };
  const { db, writer, deps } = await smartSetup({ listCommitRange: async () => ({ items: [command, command], complete: false, nextPage: 101 }) });
  await processPush(largePush(), deps);
  strictEqual(writer.writes.length, 1);
  const audit = (await db.query<any>("SELECT outcome, detail FROM audit_log WHERE kind = 'smart_commit_truncated'")).rows;
  strictEqual(audit.length, 1); strictEqual(audit[0].outcome, "partial"); strictEqual(audit[0].detail.nextPage, 101);
});

test("G8: a complete range of exactly 10,000 commits is not incorrectly audited as truncated", async () => {
  const { db, deps } = await smartSetup({ listCommitRange: async () => ({ complete: true,
    items: Array.from({ length: MAX_RANGE_COMMITS }, (_, n) => ({ id: n.toString(16).padStart(40, "0"), message: "ordinary commit" })) }) });
  await processPush(largePush(), deps);
  strictEqual((await db.query("SELECT 1 FROM audit_log WHERE kind = 'smart_commit_truncated'")).rows.length, 0);
});

test("G4 relay: UnknownPlaneState finishes the failed Smart Commit instead of retrying it", async () => {
  const writer = fakePlaneWriter({ failOn: () => new UnknownPlaneState("unknown or triage state", true) });
  const { db, deps } = await smartSetup({ writer });
  const payload = { repository: REPO, sender: { login: "bot", type: "Bot" }, commits: [{ id: HEAD, message: "QLL-1 #done" }] };
  const first = await processPush(payload, deps);
  strictEqual(first.failed, 1); strictEqual(first.retry, 0);
  strictEqual((await db.query("SELECT 1 FROM processed_commits WHERE sha = $1", [HEAD])).rows.length, 1);
  strictEqual((await processPush(payload, deps)).skipped, 1);
});

test("G16: Link next and total_count both keep bounded partial collections incomplete", async () => {
  const fromLink = await readGithubCollection(request(() => ({ data: [1], headers: { Link: '<https://api.github.com/x?page=2>; rel="next"' } })),
    "GET /x", {}, (data) => data, { maxPages: 1 });
  deepStrictEqual(fromLink, { items: [1], complete: false, nextPage: 2 });
  const fromTotal = await readGithubCollection(request(() => ({ data: { values: [1], total: 2 } })),
    "GET /x", {}, (data) => data.values, { maxPages: 1, total: (data) => data.total });
  strictEqual(fromTotal.complete, false);
  // A short page cannot stand in for 100 fetched items when total_count still proves missing results.
  const shortPages = await readGithubCollection(request(() => ({ data: { values: [1], total: 101 } })),
    "GET /x", {}, (data) => data.values, { maxPages: 2, total: (data) => data.total });
  strictEqual(shortPages.items.length, 2); strictEqual(shortPages.complete, false);
  const conflicting = await readGithubCollection(request(() => ({ data: { values: [1], total: 2 },
    headers: { link: '<https://api.github.com/x?page=1>; rel="first"' } })),
    "GET /x", {}, (data) => data.values, { total: (data) => data.total });
  strictEqual(conflicting.complete, false);
});

test("G16: 2,000 approved reviews or green suites with more pages never certify readiness", async () => {
  const reviews = Array.from({ length: 100 }, (_, id) => ({ user: { id }, state: "APPROVED" }));
  strictEqual(await checkPrReadiness(readinessClient({ reviews: () => reviews }), repo, 12, HEAD), false);
  strictEqual(await checkPrReadiness(readinessClient({ suites: () => ({ total_count: 2001,
    check_suites: Array.from({ length: 100 }, () => ({ status: "completed", conclusion: "success" })) }) }), repo, 12, HEAD), false);
  strictEqual(await checkPrReadiness(readinessClient(), repo, 12, HEAD), true);
});

test("G2 shared classifier: headerless secondary limits preserve the original response for deferred retry", async () => {
  const error = Object.assign(new Error("You have exceeded a secondary rate limit"), {
    status: 403, response: { status: 403, headers: { "x-ratelimit-remaining": "100" }, data: { message: "You have exceeded a secondary rate limit" } },
  });
  await rejects(checkPrReadiness(readinessClient({ error }), repo, 12, HEAD), (e) => e === error);
  let unavailable = 0;
  strictEqual(await checkPrReadiness(readinessClient({ error: { status: 403, response: { data: { message: "Resource not accessible by integration" } } } }),
    repo, 12, HEAD, { onUnavailable: () => { unavailable++; } }), false);
  strictEqual(unavailable, 1);
});

test("G16: backfill reports partial progress and resumes unfinished lists with the returned cursor", async () => {
  const db = await freshDb(); const pages: number[] = [];
  const github = request((route, p) => {
    strictEqual(p.sort, "created"); strictEqual(p.direction, "asc");
    if (route.endsWith("/issues")) return { data: [] };
    pages.push(p.page);
    return { data: p.page <= 50 ? Array.from({ length: 100 }, (_, i) => ({ number: (p.page - 1) * 100 + i + 1, title: "ordinary" }))
      : [{ number: 5001, title: "Fixes QLL-1" }] };
  });
  const deps = { db, github, mapping: { id: 1, workspaceSlug: "ws", planeProjectId: "p-qll", ghRepoId: 555, ...repo },
    resolveIssue: async () => ({ projectId: "p-qll", issueId: "iss-1" }) };
  const partial = await backfill(deps);
  strictEqual(partial.complete, false); strictEqual(partial.pullRequests, 5000);
  deepStrictEqual(partial.cursor, { pullRequestsPage: 51, issuesPage: null });
  strictEqual((await db.query<any>("SELECT outcome FROM audit_log WHERE kind = 'backfill'")).rows[0].outcome, "partial");
  const resumed = await backfill({ ...deps, cursor: partial.cursor });
  strictEqual(resumed.pullRequests, 1); strictEqual(resumed.linked, 1);
  strictEqual(pages.at(-1), 51);
  strictEqual((await db.query("SELECT 1 FROM sync_links WHERE gh_number = 5001")).rows.length, 1);
});

test("G15: stage changes preserve lifecycle triggers and request a following readiness evaluation", () => {
  for (const [action, trigger] of [["ready_for_review", "pull_request.opened"], ["reopened", "pull_request.reopened"]]) {
    const payload = { action, pull_request: currentPr() };
    strictEqual(shouldReevaluatePrReadiness("pull_request", payload), true);
    strictEqual(prEventToRuleEvent("pull_request", payload, { isReadyForMerge: true })?.trigger, trigger);
  }
  strictEqual(prEventToRuleEvent("pull_request", { action: "ready_for_merge", pull_request: currentPr(12, { state: "closed" }) },
    { isReadyForMerge: true }), null);
});

test("G15/G3 caller: ready-for-review and reopen run lifecycle before readiness, including a created-item continuation", async () => {
  const h = await makeHarness();
  try {
    const mappingId = await h.mapping({ smartCommits: false, rules:
      "- when: pull_request.opened\n  then: [{ comment: lifecycle }]\n- when: pull_request.reopened\n  then: [{ comment: reopened }]\n- when: pull_request.ready_for_merge\n  then: [{ comment: ready }]\n" });
    await h.link("iss-1", 12, { kind: "pr", tier: "closing" }); configureChecks(h);
    const job = ghJob("pull_request", prPayload("ready_for_review", {}, currentPr()));
    await handlePullRequest(h.ctx, job);
    deepStrictEqual(comments(h).map((c) => c.body.comment_html), ["<p>lifecycle</p>", "<p>ready</p>"]);
    // Same head is guarded on a later stage delivery, even if readiness is evaluated again.
    await handlePullRequest(h.ctx, ghJob("pull_request", prPayload("reopened", {}, currentPr())));
    strictEqual((await h.audit("ready_for_merge")).length, 1);
    // A later fenced continuation at a fresh head still performs the stage's rules before readiness.
    const next = currentPr(12, { head: { sha: sha("b"), ref: "fix/qll-1", repo: { id: 999 } } });
    h.gh.respond(/pulls\/\{pull_number\}$/, () => next);
    await handleCreatedPr(h.ctx, { kind: "pr_created", mappingId, projectId: "p-qll", issueId: "iss-1", identifier: "",
      job: ghJob("pull_request", prPayload("ready_for_review", {}, next)) });
    deepStrictEqual(comments(h).slice(-2).map((c) => c.body.comment_html), ["<p>lifecycle</p>", "<p>ready</p>"]);
    strictEqual((await h.audit("ready_for_merge")).length, 2);
  } finally { await h.close(); }
});

test("G15/G3 caller: a late ready-for-review delivery cannot fire readiness after the current PR became draft", async () => {
  const h = await makeHarness();
  try {
    await h.mapping({ smartCommits: false, rules: "- when: pull_request.ready_for_merge\n  then: [{ comment: ready }]\n" });
    await h.link("iss-1", 12, { kind: "pr" });
    configureChecks(h, currentPr(12, { draft: true, updated_at: "2026-10-12T12:00:00Z" }));
    await handlePullRequest(h.ctx, ghJob("pull_request", prPayload("ready_for_review", {},
      currentPr(12, { updated_at: "2026-10-12T11:00:00Z" }))));
    strictEqual(comments(h).length, 0); strictEqual((await h.audit("ready_for_merge")).length, 0);
  } finally { await h.close(); }
});

test("G1 shared deadline: signature verification throttling reaches the deferred retry policy unchanged", async () => {
  const error = Object.assign(new Error("You have exceeded a secondary rate limit"), { status: 403 });
  const { db, deps } = await smartSetup({ requireVerified: true, getCommitVerified: async () => { throw error; } });
  await rejects(processPush({ repository: REPO, sender: { login: "bot", type: "Bot" },
    commits: [{ id: HEAD, message: "QLL-1 #done" }] }, deps), (e) => e === error);
  strictEqual((await db.query("SELECT 1 FROM processed_commits WHERE sha = $1", [HEAD])).rows.length, 0);
});

const deployJob = (deploymentId: number, statusId: number, state: string, deploymentAt: string, statusAt: string) =>
  ghJob("deployment_status", { repository: WEB_REPO,
    deployment: { id: deploymentId, created_at: deploymentAt, sha: HEAD, environment: "production" },
    deployment_status: { id: statusId, created_at: statusAt, state, environment: "production", environment_url: "https://app.vercel.app" } });

test("Round 2 A10: older status/deployment and duplicate delivery never replace the latest rollup or run stale rules", async () => {
  const h = await makeHarness();
  try {
    await h.mapping({ smartCommits: false, rules: "- when: deployment_status.*\n  then: [{ comment: deploy-rule }]\n" });
    await h.link("iss-1", 12, { kind: "pr" });
    h.gh.respond(/commits\/\{commit_sha\}\/pulls$/, () => [{ number: 12 }]);
    const latest = deployJob(502, 602, "success", "2026-10-12T10:10:00Z", "2026-10-12T10:11:00Z");
    await handleChecks(h.ctx, latest);
    const before = h.plane.writes().length;
    // An earlier status on the same deployment, even with an inconsistent larger ID, cannot win by delivery time.
    await handleChecks(h.ctx, deployJob(502, 603, "pending", "2026-10-12T10:10:00Z", "2026-10-12T10:10:30Z"));
    // A late inactive status for an older deployment cannot replace the newer deployment.
    await handleChecks(h.ctx, deployJob(501, 700, "inactive", "2026-10-12T10:00:00Z", "2026-10-12T12:00:00Z"));
    await handleChecks(h.ctx, { ...latest, deliveryId: "duplicate-new-transport" });
    strictEqual(h.plane.writes().length, before);
    strictEqual(comments(h).length, 1);
    strictEqual((await h.audit("deployment_status_stale")).length, 3);
    // Same timestamp has a deterministic status-ID tie breaker.
    await handleChecks(h.ctx, deployJob(502, 604, "failure", "2026-10-12T10:10:00Z", "2026-10-12T10:11:00Z"));
    strictEqual(h.plane.writes().filter((c) => c.body?.title?.startsWith("[Deploy]")).at(-1)?.body.title, "[Deploy] production · failure");
    const fromIds = { deploymentId: "9007199254740993", deploymentCreatedAt: null, statusId: "2", statusCreatedAt: null };
    strictEqual(compareDeploymentVersions(fromIds, { ...fromIds, deploymentId: "9007199254740992" }), 1);
  } finally { await h.close(); }
});

test("Round 2 A10: a failed newest rollup keeps its version fence and can retry without an older status winning", async () => {
  const h = await makeHarness();
  try {
    await h.mapping({ smartCommits: false }); await h.link("iss-1", 12, { kind: "pr" });
    h.gh.respond(/commits\/\{commit_sha\}\/pulls$/, () => [{ number: 12 }]);
    const original = h.ctx.plane.apply.bind(h.ctx.plane); let fail = true;
    h.ctx.plane.apply = async (write, options) => {
      if (fail) throw new Error("registration unavailable");
      return original(write, options);
    };
    const newest = deployJob(502, 602, "success", "2026-10-12T10:10:00Z", "2026-10-12T10:11:00Z");
    await rejects(handleChecks(h.ctx, newest), /registration unavailable/);
    await handleChecks(h.ctx, deployJob(502, 601, "pending", "2026-10-12T10:10:00Z", "2026-10-12T10:10:00Z"));
    strictEqual(h.plane.writes().length, 0);
    fail = false; await handleChecks(h.ctx, { ...newest, deliveryId: "retry-newest" });
    strictEqual(links(h).find((c) => c.body.title.startsWith("[Deploy]"))?.body.title, "[Deploy] production · success");
  } finally { await h.close(); }
});

test("Round 2 A10: simultaneous deployment deliveries serialize their version comparison and final rollup", async () => {
  const h = await makeHarness();
  try {
    await h.mapping({ smartCommits: false }); await h.link("iss-1", 12, { kind: "pr" });
    h.gh.respond(/commits\/\{commit_sha\}\/pulls$/, () => [{ number: 12 }]);
    await Promise.all([
      handleChecks(h.ctx, deployJob(502, 602, "success", "2026-10-12T10:00:00Z", "2026-10-12T10:02:00Z")),
      handleChecks(h.ctx, deployJob(502, 601, "pending", "2026-10-12T10:00:00Z", "2026-10-12T10:01:00Z")),
    ]);
    strictEqual(h.plane.writes().filter((c) => c.body?.title?.startsWith("[Deploy]")).at(-1)?.body.title, "[Deploy] production · success");
  } finally { await h.close(); }
});

test("Round 2 A10: historical Smart Commit retry keeps original grammar, actor, target, state and write identity", async () => {
  const ids: string[] = []; const writes: any[] = []; let fail = true;
  const { deps } = await smartSetup({ writer: { apply: async (write) => {
    ids.push(nextWriteJobId("plane", write, deliveryScope.getStore())); writes.push(write);
    if (fail && write.kind === "update_issue") throw new Error("transient write failure");
    return { ok: true };
  } } });
  const payload = { repository: REPO, sender: { login: "original[bot]", type: "Bot" },
    commits: [{ id: HEAD, message: "QLL-1 #done #comment original", url: "https://git.example/original" }] };
  await rejects(deliveryScope.run({ deliveryId: "github-first" }, () => processPush(payload, deps)), SmartCommitRetry);
  fail = false;
  await deliveryScope.run({ deliveryId: "github-later-fork" }, () => processPush({ ...payload,
    sender: { login: "later[bot]", type: "Bot" }, commits: [{ id: HEAD, message: "QLL-1 #other #comment changed", url: "https://git.example/changed" }] },
    { ...deps, resolveIssue: async () => ({ projectId: "other-project", issueId: "other-issue" }), listStates: async () => [] }));
  const states = writes.filter((w) => w.kind === "update_issue");
  strictEqual(states.length, 2); deepStrictEqual(states[0], states[1]); strictEqual(ids[0], ids.at(-1));
  const note = writes.filter((w) => w.kind === "add_comment");
  strictEqual(note.length, 1); ok(note[0].commentHtml.includes("original[bot]")); ok(!note[0].commentHtml.includes("changed"));
});

test("Round 2 A10: audit failure after durable Smart Commit registration does not create a second intent on another transport", async () => {
  const db = await freshDb(); let failReceipt = true;
  const wrapped: any = { exec: db.exec.bind(db), query: async (sql: string, params: any[]) => {
    if (failReceipt && sql.includes("INSERT INTO audit_log") && params?.[0] === "smart_commit_step") {
      failReceipt = false; throw new Error("receipt storage failed");
    }
    return db.query(sql, params);
  } };
  const outbox = createOrderedOutbox({ db: wrapped, queues: { plane: queue() as any, github: queue() as any }, loadActorToken: async () => null,
    plane: { preflight: async () => {}, apply: async () => ({ ok: true }) }, github: { apply: async () => ({ ok: true }) } });
  const { deps } = await smartSetup({ db: wrapped, writer: outbox.plane });
  const payload = { repository: REPO, sender: { login: "original[bot]", type: "Bot" }, commits: [{ id: HEAD, message: "QLL-1 #comment original" }] };
  await rejects(deliveryScope.run({ deliveryId: "github-first" }, () => processPush(payload, deps)), SmartCommitRetry);
  await deliveryScope.run({ deliveryId: "github-second" }, () => processPush({ ...payload, sender: { login: "other[bot]", type: "Bot" } }, deps));
  const rows = (await db.query<any>("SELECT delivery_id, write FROM outbound_writes")).rows;
  strictEqual(rows.length, 1); strictEqual(rows[0].delivery_id, "github-first");
  ok(rows[0].write.commentHtml.includes("original[bot]"));
});

test("Round 2 G6/G16: readiness reads an actionable review after page 20 and rejects a blocking latest decision", async () => {
  const seen: number[] = [];
  const client = readinessClient({ reviews: (page) => {
    seen.push(page);
    return page <= 20 ? Array.from({ length: 100 }, () => ({ user: { id: 1 }, state: "APPROVED" }))
      : [{ user: { id: 1 }, state: "CHANGES_REQUESTED" }];
  } });
  strictEqual(await checkPrReadiness(client, repo, 12, HEAD), false);
  strictEqual(seen.at(-1), 21);
});

test("Round 2 G4 relay: pending commands carry the latest Plane retry deadline and preserve budget-only deferral", async () => {
  const deadlines = [Date.now() + 120_000, Date.now() + 600_000];
  let n = 0;
  const { deps } = await smartSetup({ writer: { apply: async () => {
    throw new PlaneRateLimitError(deadlines[n++ % 2]!, { requestMade: false });
  } } });
  await rejects(processPush({ repository: REPO, sender: { login: "bot", type: "Bot" },
    commits: [{ id: HEAD, message: "QLL-1 #done #comment pending" }] }, deps), (error: any) => {
    strictEqual(error instanceof PlaneRateLimitError, true);
    strictEqual(error.retryAt, deadlines[1]); strictEqual(error.requestMade, false);
    return true;
  });
});

test("Round 2 A10: preview rollups shared by environments reject an older deployment's URL", async () => {
  const h = await makeHarness();
  try {
    await h.mapping({ smartCommits: false }); await h.link("iss-1", 12, { kind: "pr" });
    h.gh.respond(/commits\/\{commit_sha\}\/pulls$/, () => [{ number: 12 }]);
    const latest = deployJob(502, 602, "success", "2026-10-12T10:10:00Z", "2026-10-12T10:11:00Z");
    await handleChecks(h.ctx, latest);
    const older = deployJob(501, 601, "success", "2026-10-12T10:00:00Z", "2026-10-12T10:01:00Z");
    (older.payload as any).deployment.environment = "staging";
    (older.payload as any).deployment_status.environment = "staging";
    (older.payload as any).deployment_status.environment_url = "https://old.vercel.app";
    await handleChecks(h.ctx, older);
    strictEqual(h.plane.writes().filter((c) => c.body?.title?.startsWith("[Preview]")).at(-1)?.body.url, "https://app.vercel.app");
  } finally { await h.close(); }
});

for (const phase of ["lookup", "states"] as const) {
  test(`Round 2 G4 relay: Plane deadline survives a pending Smart Commit ${phase} read`, async () => {
    const deadline = Date.now() + 300_000;
    const limited = async () => { throw new PlaneRateLimitError(deadline); };
    const { deps } = await smartSetup(phase === "lookup" ? { resolveIssue: limited } : { listStates: limited });
    await rejects(processPush({ repository: REPO, sender: { login: "bot", type: "Bot" },
      commits: [{ id: HEAD, message: "QLL-1 #done" }] }, deps), (error: any) => {
      strictEqual(error instanceof PlaneRateLimitError, true); strictEqual(error.retryAt, deadline); return true;
    });
  });
}
