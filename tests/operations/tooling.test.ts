import test, { afterEach } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../../src/db/migrate.ts";
import { strictEqual, deepStrictEqual, ok, rejects } from "node:assert/strict";
import { OperationError, backfill, dryRun, replayDelivery, toRuleEvent, toRuleEvents } from "../../src/operations/tooling.ts";
import type { ReplayJob } from "../../src/operations/tooling.ts";
import { ruleEventsFor } from "../../src/app/rule-events.ts";
import { appendAudit, upsertSyncLink } from "../../src/db/ledgers.ts";

const databases: PGlite[] = [];
// Release each test's WASM database before starting the next test on the live Plane host.
afterEach(async () => {
  for (const db of databases.splice(0)) await db.close();
});

async function freshDb() {
  const db = new PGlite();
  databases.push(db);
  await db.waitReady;
  await migrate(db);
  return db;
}

const MERGE_RULES = "- name: ship\n  when: pull_request.merged\n  if: { base_branch: \"^main$\" }\n  then:\n    - set_state: Done\n    - comment: 'Deployed via {{pr.url}}'\n";
const prPayload = (o: object = {}, base = "main") => ({ action: "closed", repository: { full_name: "acme/web" },
  pull_request: { number: 1, merged: true, html_url: "https://gh/pr/1", base: { ref: base }, head: { ref: "x" }, labels: [], user: { login: "o" }, ...o } });

test("dry-run: reports the trigger, the matched rule and the rendered actions", async () => {
  const r = await dryRun({ rulesYaml: MERGE_RULES, event: "pull_request", payload: prPayload() });
  deepStrictEqual(r, { dryRun: true, trigger: "pull_request.merged", matched: { index: 0, name: "ship" },
    actions: [{ type: "set_state", state: "Done" }, { type: "comment", body: "Deployed via https://gh/pr/1" }] });
});

test("dry-run: no match and non-automation events report no actions", async () => {
  const miss = await dryRun({ rulesYaml: MERGE_RULES, event: "pull_request", payload: prPayload({}, "develop") });
  deepStrictEqual([miss.trigger, miss.matched, miss.actions], ["pull_request.merged", null, []]);
  const none = await dryRun({ rulesYaml: MERGE_RULES, event: "pull_request", payload: { action: "synchronize", pull_request: { number: 1 } } });
  deepStrictEqual([none.trigger, none.matched, none.actions], [null, null, []]);
});

test("dry-run: a push is evaluated as the push trigger", async () => {
  const r = await dryRun({ rulesYaml: "- when: push\n  then:\n    - set_state: started\n", event: "push", payload: { ref: "refs/heads/web-1-x" } });
  deepStrictEqual(r.actions, [{ type: "set_state", state: "started" }]);
});

test("dry-run: a default-branch push agrees with the live mapper and evaluates both triggers in order", async () => {
  const payload = { ref: "refs/heads/main", repository: { full_name: "acme/web", default_branch: "main" },
    sender: { login: "octo" }, pusher: { name: "forged-author" } };
  const live = ruleEventsFor("github", "push", payload);
  deepStrictEqual(live.map((e) => e.trigger), ["push", "commit.pushed_to_default"]);
  deepStrictEqual(toRuleEvents("push", payload), live);
  deepStrictEqual(toRuleEvent("push", payload), live[0]);
  const result = await dryRun({ event: "push", payload, rulesYaml:
    "- name: branch\n  when: push\n  if: { author: octo }\n  then: [{ add_label: pushed }]\n" +
    "- name: main\n  when: commit.pushed_to_default\n  if: { head_branch: '^main$' }\n  then: [{ add_label: shipped }]\n" });
  deepStrictEqual(result.events?.map((e) => [e.trigger, e.matched?.name]), [["push", "branch"], ["commit.pushed_to_default", "main"]]);
  deepStrictEqual(result.actions, [{ type: "add_label", label: "pushed" }, { type: "add_label", label: "shipped" }]);
});

test("dry-run: a completed check suite agrees with the live mapper and renders the matched action", async () => {
  const payload = { action: "completed", repository: { full_name: "acme/web" }, sender: { login: "octo" },
    check_suite: { conclusion: "failure", head_branch: "fix/web-12" } };
  const live = ruleEventsFor("github", "check_suite", payload);
  strictEqual(live[0]?.trigger, "check_suite.failure");
  deepStrictEqual(toRuleEvents("check_suite", payload), live);
  deepStrictEqual(toRuleEvent("check_suite", payload), live[0]);
  deepStrictEqual(await dryRun({ event: "check_suite", payload, rulesYaml:
    "- name: failed\n  when: check_suite.failure\n  if: { head_branch: '^fix/', author: octo }\n  then: [{ add_label: failing }]\n" }),
  { dryRun: true, trigger: "check_suite.failure", matched: { index: 0, name: "failed" }, actions: [{ type: "add_label", label: "failing" }] });
});

test("dry-run: invalid rules throw the engine's reason; an unresolved template throws", async () => {
  await rejects(dryRun({ rulesYaml: "- when: nope\n  then: [ { comment: x } ]\n", event: "push", payload: {} }), /index 0/);
  await rejects(dryRun({ rulesYaml: "- when: pull_request.merged\n  then:\n    - comment: '{{pr.missing}}'\n", event: "pull_request", payload: prPayload() }), /pr\.missing/);
});

async function original(db: any, over: object = {}) {
  return appendAudit(db, { kind: "inbound_delivery", source: "github", deliveryId: "gd-1", workspaceSlug: "qelal",
    detail: { event: "pull_request", payload: { action: "opened" } }, outcome: "failed", error: "boom", ...over });
}

test("replay: enqueues the stored event under a fresh id and links the audit rows", async () => {
  const db = await freshDb();
  const id = await original(db);
  const jobs: ReplayJob[] = [];
  const out = await replayDelivery({ db, enqueue: async (j) => { jobs.push(j); }, now: () => new Date("2026-10-10T10:00:00Z") }, id);
  strictEqual(jobs.length, 1);
  deepStrictEqual([jobs[0]!.source, jobs[0]!.event, jobs[0]!.payload], ["github", "pull_request", { action: "opened" }]);
  strictEqual(jobs[0]!.deliveryId, `replay-${id}-${Date.parse("2026-10-10T10:00:00Z")}`);
  strictEqual(jobs[0]!.receivedAt, "2026-10-10T10:00:00.000Z");
  strictEqual(jobs[0]!.writeDeliveryId, "gd-1");
  strictEqual(out.deliveryId, jobs[0]!.deliveryId);
  const row = (await db.query<any>(`SELECT * FROM audit_log WHERE id = $1`, [out.auditId])).rows[0];
  deepStrictEqual([String(row.replay_of), row.kind, row.workspace_slug, row.delivery_id], [String(id), "replay", "qelal", out.deliveryId]);
});

test("replay: two replays of one delivery use different ids", async () => {
  const db = await freshDb();
  const id = await original(db);
  const seen: string[] = [];
  let t = 1000;
  for (let i = 0; i < 2; i++) await replayDelivery({ db, enqueue: async (j) => { seen.push(j.deliveryId); }, now: () => new Date(t++) }, id);
  ok(seen[0] !== seen[1]);
});

test("replay: only stored inbound deliveries can be replayed", async () => {
  const db = await freshDb();
  const enqueue = async () => { throw new Error("must not enqueue"); };
  await rejects(replayDelivery({ db, enqueue }, 999), (e: any) => e instanceof OperationError && e.status === 404);
  const other = await appendAudit(db, { kind: "smart_commit", outcome: "applied", detail: { x: 1 } });
  await rejects(replayDelivery({ db, enqueue }, other), (e: any) => e.status === 422 && /inbound/.test(e.message));
  const dup = await original(db, { detail: { event: "push" }, outcome: "duplicate" });
  await rejects(replayDelivery({ db, enqueue }, dup), (e: any) => e.status === 422 && /payload/.test(e.message));
  const sourceless = await appendAudit(db, { kind: "inbound_delivery", detail: { event: "push", payload: {} }, outcome: "handled" });
  await rejects(replayDelivery({ db, enqueue }, sourceless), (e: any) => e.status === 422);
});

test("replay: a failing enqueue leaves no replay row behind", async () => {
  const db = await freshDb();
  const id = await original(db);
  await rejects(replayDelivery({ db, enqueue: async () => { throw new Error("redis down"); } }, id), /redis down/);
  strictEqual((await db.query(`SELECT 1 FROM audit_log WHERE kind = 'replay'`)).rows.length, 0);
});

const mapping = { id: 1, workspaceSlug: "qelal", planeProjectId: "p-qll", ghRepoId: 555, owner: "acme", repo: "web" };
const resolveIssue = async (key: string) => (key === "QLL-404" ? null : { projectId: "p-qll", issueId: `iss-${key}` });

function gh(pages: { pulls?: any[][]; issues?: any[][] }) {
  const calls: { route: string; page: number; params: any }[] = [];
  return { calls, request: async (route: string, params: any = {}) => {
    calls.push({ route, page: params.page, params });
    const list = route.includes("pulls") ? pages.pulls : pages.issues;
    return { data: list?.[(params.page ?? 1) - 1] ?? [] };
  } };
}

test("backfill: links PRs from branch, title and body and issues from title and body", async () => {
  const db = await freshDb();
  const github = gh({
    pulls: [[{ number: 1, title: "Fixes QLL-1", body: "", head: { ref: "x" } }, { number: 2, title: "Plain", body: "refs QLL-2", head: { ref: "nathan/qll-3-thing" } }]],
    issues: [[{ number: 3, title: "bug", body: "relates to QLL-4" }, { number: 1, title: "the PR again", pull_request: {}, body: "closes QLL-9" }]],
  });
  const out = await backfill({ db, github, mapping, resolveIssue });
  deepStrictEqual(out, { linked: 4, unresolved: 0, pullRequests: 2, issues: 1 });
  const rows = (await db.query<any>(`SELECT gh_number, gh_kind, tier, plane_issue_id, created_by FROM sync_links ORDER BY plane_issue_id`)).rows;
  deepStrictEqual(rows.map((r) => [r.plane_issue_id, r.gh_kind, r.gh_number, r.tier, r.created_by]), [
    ["iss-QLL-1", "pr", 1, "closing", "magic_word"], ["iss-QLL-2", "pr", 2, "non_closing", "magic_word"],
    ["iss-QLL-3", "pr", 2, "closing", "branch"], ["iss-QLL-4", "issue", 3, "relation", "magic_word"]]);
});

test("backfill: unknown work items are counted, not linked; a skipped key is not linked", async () => {
  const db = await freshDb();
  const github = gh({ pulls: [[{ number: 1, title: "Fixes QLL-404 QLL-5", body: "skip QLL-5", head: { ref: "x" } }]] });
  const out = await backfill({ db, github, mapping, resolveIssue });
  deepStrictEqual([out.linked, out.unresolved], [0, 1]);
});

test("backfill: pages through the lists and asks only for open items", async () => {
  const db = await freshDb();
  const full = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, title: `T${i}`, head: { ref: "x" } }));
  const github = gh({ pulls: [full, [{ number: 101, title: "Fixes QLL-1", head: { ref: "x" } }]] });
  const out = await backfill({ db, github, mapping, resolveIssue });
  strictEqual(out.pullRequests, 101);
  strictEqual(out.linked, 1);
  ok(github.calls.every((c) => c.params.state === "open" && c.params.owner === "acme" && c.params.repo === "web"));
  deepStrictEqual(github.calls.filter((c) => c.route.includes("pulls")).map((c) => c.page), [1, 2]);
});

test("backfill: resolves each reference once and is idempotent on rerun", async () => {
  const db = await freshDb();
  let lookups = 0;
  const github = gh({ pulls: [[{ number: 1, title: "Fixes QLL-1", head: { ref: "x" } }, { number: 2, title: "Fixes QLL-1", head: { ref: "y" } }]] });
  const counting = async (k: string) => { lookups++; return resolveIssue(k); };
  await backfill({ db, github, mapping, resolveIssue: counting });
  await backfill({ db, github, mapping, resolveIssue: counting });
  strictEqual(lookups, 2);
  strictEqual((await db.query(`SELECT 1 FROM sync_links`)).rows.length, 2);
});

test("backfill: custom magic words are honoured and the run is audited for the workspace", async () => {
  const db = await freshDb();
  const github = gh({ pulls: [[{ number: 1, title: "Shipping QLL-1", head: { ref: "x" } }]], issues: [[]] });
  const words = { closing: ["shipping"], non_closing: ["ref"], relation: ["see"] };
  await backfill({ db, github, mapping, resolveIssue, words });
  strictEqual((await db.query<any>(`SELECT tier FROM sync_links`)).rows[0].tier, "closing");
  const audit = (await db.query<any>(`SELECT workspace_slug, outcome, detail FROM audit_log WHERE kind = 'backfill'`)).rows[0];
  deepStrictEqual([audit.workspace_slug, audit.outcome, audit.detail.linked], ["qelal", "done", 1]);
});

test("backfill: preserves label-sync ownership when an opted-in issue is referenced again", async () => {
  const db = await freshDb();
  await upsertSyncLink(db, { planeWorkspaceSlug: mapping.workspaceSlug, planeProjectId: mapping.planeProjectId,
    planeIssueId: "iss-QLL-1", ghRepoId: mapping.ghRepoId, ghNumber: 5, ghKind: "issue",
    tier: "relation", createdBy: "label_sync" });
  const github = gh({ issues: [[{ number: 5, title: "Fixes QLL-1", body: "" }]] });
  for (let attempt = 0; attempt < 2; attempt++) {
    strictEqual((await backfill({ db, github, mapping, resolveIssue })).linked, 1);
    const rows = (await db.query<{ created_by: string; tier: string; status: string }>(
      `SELECT created_by, tier, status FROM sync_links WHERE gh_number = 5`)).rows;
    deepStrictEqual(rows, [{ created_by: "label_sync", tier: "relation", status: "active" }]);
  }
});
