#!/usr/bin/env node
// Oracle for tasks B4 (§7.2), B5 (§7.1), B6 (§7.3), B7 (§7.4) and B8 (§7.6). Every Plane write
// goes through A4's PlaneWritePath; here a recording fake stands in for it.
import { resolve, join } from "node:path";
import { strictEqual, deepStrictEqual, ok, throws, rejects } from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";

const root = resolve(import.meta.dirname, "..");
const results = [];
async function check(name, fn, ms = 60000) {
  let timer;
  const limit = new Promise((_, no) => { timer = setTimeout(() => no(new Error(`timed out after ${ms}ms`)), ms); });
  try { await Promise.race([fn(), limit]); results.push([name, null]); console.log(`ok   ${name}`); }
  catch (e) { results.push([name, e]); console.error(`FAIL: ${name}: ${String(e?.message ?? e).split("\n")[0]}`); }
  finally { clearTimeout(timer); }
}

const SC = await import(join(root, "src/github/smart-commits.ts"));
const PR = await import(join(root, "src/github/pr-automation.ts"));
const MI = await import(join(root, "src/sync/mirror.ts"));
const DI = await import(join(root, "src/sync/dev-info.ts"));
const OPS = await import(join(root, "src/operations/tooling.ts"));
const { parseRules, evaluate } = await import(join(root, "src/rules/engine.ts"));
const { migrate } = await import(join(root, "src/db/migrate.ts"));
const L = await import(join(root, "src/db/ledgers.ts"));
const { SecretString, TokenVault } = await import(join(root, "src/auth/identity.ts"));
const { PgTokenStore } = await import(join(root, "src/db/token-store.ts"));
const { TriageWriteRejected } = await import(join(root, "src/sync/plane.ts"));

const db = new PGlite(); await db.waitReady; await migrate(db);
const QLL = [
  { id: "s-backlog", name: "Backlog", group: "backlog" }, { id: "s-todo", name: "To Do", group: "unstarted" },
  { id: "s-prog", name: "In Progress", group: "started" }, { id: "s-review", name: "In Review", group: "started" },
  { id: "s-done", name: "Done", group: "completed" }, { id: "s-wont", name: "Won't Do", group: "cancelled" },
  { id: "s-triage", name: "Triage", group: "triage" },
];
const DSAF = [{ id: "d-todo", name: "Todo", group: "unstarted" }, { id: "d-cancel", name: "Cancelled", group: "cancelled" }, { id: "d-done", name: "Done", group: "completed" }];
function fakeWriter() {
  const writes = [];
  return { writes, apply: async (w, opts) => {
    writes.push({ ...w, token: opts?.actorToken ? opts.actorToken.reveal() : "SERVICE" });
    if (w.kind === "update_issue" && w.fields.state === "s-triage") throw new TriageWriteRejected();
    return { ok: true, id: w.kind === "add_link" ? `link-${writes.length}` : `id-${writes.length}` };
  } };
}

// ---- B4 Smart Commits ---------------------------------------------------------------------------
await check("B4 grammar: §7.2 examples, multi-key multi-command lines, hyphenated transitions, per-line keys", () => {
  deepStrictEqual(SC.parseSmartCommits("WEB-34 #comment corrected indent issue"), [{ keys: ["WEB-34"], comment: "corrected indent issue", transitions: [] }]);
  const t = SC.parseSmartCommits("WEB-34 #time 1w 2d 4h 30m logged")[0];
  deepStrictEqual(t.keys, ["WEB-34"]); strictEqual(t.time.minutes, ((5 + 2) * 8 + 4) * 60 + 30);
  deepStrictEqual(SC.parseSmartCommits("WEB-1 WEB-2 #done #time 2d 5h #comment shipped"), [{ keys: ["WEB-1", "WEB-2"], transitions: ["done"], time: { raw: "2d 5h", minutes: (2 * 8 + 5) * 60 }, comment: "shipped" }]);
  deepStrictEqual(SC.parseSmartCommits("fix WEB-90 #in-review").map((c) => c.transitions), [["in-review"]]);
  deepStrictEqual(SC.parseSmartCommits("WEB-5 #comment first\n#comment orphan line has no key\nWEB-6 #done"), [
    { keys: ["WEB-5"], comment: "first", transitions: [] }, { keys: ["WEB-6"], transitions: ["done"] }]);
  deepStrictEqual(SC.parseSmartCommits("just a message, no commands WEB-7"), []);
  strictEqual(SC.durationToMinutes("1.5h"), 90);
  throws(() => SC.durationToMinutes("soon"));
});

await check("B4 transitions resolve per project by hyphenated name, ambiguity and absence are failures (§7.1, §7.2)", () => {
  deepStrictEqual(SC.resolveTransition(QLL, "in-review"), { ok: true, stateId: "s-review" });
  deepStrictEqual(SC.resolveTransition(QLL, "won't-do"), { ok: true, stateId: "s-wont" });
  deepStrictEqual(SC.resolveTransition(DSAF, "todo"), { ok: true, stateId: "d-todo" });
  strictEqual(SC.resolveTransition(DSAF, "won't-do").ok, false);
  strictEqual(SC.resolveTransition([{ id: "a", name: "QA", group: "started" }, { id: "b", name: "QA", group: "completed" }], "qa").reason, "ambiguous");
});

const push = (sha, message, sender, extra = {}) => ({ ref: "refs/heads/main", repository: { id: 555, full_name: "acme/web" }, sender,
  pusher: { name: "victim", email: "victim@corp.example" },
  commits: [{ id: sha, message, author: { name: "Victim", email: "victim@corp.example", username: "victim" }, committer: { name: "Victim", email: "victim@corp.example" } }], ...extra });
const vault = new TokenVault(new PgTokenStore(db), Buffer.alloc(32, 5));
await vault.store("u-victim", "plane_pat", "plane_api_VICTIM");
await vault.store("u-octo", "plane_pat", "plane_api_OCTO");
const users = { planeUserIdForGithubLogin: async (l) => ({ victim: "u-victim", octo: "u-octo" })[l.toLowerCase()] ?? null };
const scDeps = (writer, over = {}) => ({ db, writer, users, vault, requireVerified: false, mapping: { workspaceSlug: "qelal", smartCommitsEnabled: true },
  listStates: async () => QLL, resolveIssue: async (key) => ({ projectId: "p-qll", issueId: `iss-${key}` }), getCommitVerified: async () => true, ...over });

await check("B4 security: a forged --author is ignored; an unmapped sender acts as the service and is audited; a mapped sender acts as themself (§7.2, §10)", async () => {
  const w1 = fakeWriter();
  await SC.processPush(push("a".repeat(40), "WEB-1 #comment forged", { login: "attacker", id: 66, type: "User" }), scDeps(w1));
  ok(w1.writes.length >= 1, "no write happened");
  ok(w1.writes.every((x) => x.token === "SERVICE"), `acted with ${w1.writes.map((x) => x.token)} — the forged author's identity was used`);
  const fb = (await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE kind ILIKE '%fallback%' OR kind ILIKE '%identity%'`)).rows[0].n;
  ok(fb >= 1, "the identity fallback was not recorded in the audit log");
  const w2 = fakeWriter();
  await SC.processPush(push("b".repeat(40), "WEB-2 #comment real", { login: "octo", id: 1, type: "User" }), scDeps(w2));
  ok(w2.writes.length >= 1 && w2.writes.every((x) => x.token === "plane_api_OCTO"), `mapped sender wrote as ${w2.writes.map((x) => x.token)}`);
  const w3 = fakeWriter();
  await SC.processPush(push("c".repeat(40), "WEB-3 #comment bot", { login: "dependabot[bot]", id: 2, type: "Bot" }), scDeps(w3));
  ok(w3.writes.every((x) => x.token === "SERVICE"));
});

await check("B4 once per commit SHA: the same commit via another push or branch has one effect (§5)", async () => {
  const w = fakeWriter();
  const p = push("d".repeat(40), "WEB-4 #comment once", { login: "octo", id: 1, type: "User" });
  await SC.processPush(p, scDeps(w));
  await SC.processPush({ ...p, ref: "refs/heads/feature", repository: { id: 777, full_name: "fork/web" } }, scDeps(w));
  strictEqual(w.writes.filter((x) => x.kind === "add_comment").length, 1);
});

await check("B4 transitions write the resolved state; #time becomes a comment; a missing state fails loudly and does not stop other commands", async () => {
  const w = fakeWriter();
  await SC.processPush(push("e".repeat(40), "WEB-5 #in-review #time 2h #comment ok\nWEB-6 #deployed #comment still here", { login: "octo", id: 1, type: "User" }), scDeps(w));
  ok(w.writes.some((x) => x.kind === "update_issue" && x.issueId === "iss-WEB-5" && x.fields.state === "s-review"), JSON.stringify(w.writes));
  ok(w.writes.some((x) => x.kind === "add_comment" && x.issueId === "iss-WEB-5" && /2h|120/.test(x.commentHtml)), "#time was not attached as a comment");
  ok(w.writes.some((x) => x.kind === "add_comment" && x.issueId === "iss-WEB-6" && /still here/.test(x.commentHtml)), "a failed transition stopped the comment");
  const loud = (await db.query(`SELECT error FROM audit_log WHERE error ILIKE '%deployed%'`)).rows;
  ok(loud.length >= 1, "the nonexistent transition was not recorded as a failure");
});

await check("B4 honours the per-repo toggle and the optional verified-signature requirement (§7.2)", async () => {
  const w = fakeWriter();
  await SC.processPush(push("f".repeat(40), "WEB-7 #comment off", { login: "octo", id: 1, type: "User" }), scDeps(w, { mapping: { workspaceSlug: "qelal", smartCommitsEnabled: false } }));
  strictEqual(w.writes.length, 0);
  await SC.processPush(push("1".repeat(40), "WEB-8 #comment unsigned", { login: "octo", id: 1, type: "User" }), scDeps(w, { requireVerified: true, getCommitVerified: async () => false }));
  strictEqual(w.writes.length, 0);
});

// ---- B5 PR and branch automation ---------------------------------------------------------------
await check("B5 compiles the §7.1 QLL defaults into A6 rules (no second evaluator)", () => {
  const rules = parseRules(PR.compileLifecycleRules(PR.QLL_DEFAULTS));
  const act = (trigger, base = "main") => evaluate(rules, { trigger, base_branch: base, repo: "acme/web" }).actions;
  deepStrictEqual(act("pull_request.opened").map((a) => a.type), ["set_state"]);
  ok(/In Progress/.test(act("pull_request.drafted")[0].state));
  ok(/In Review/.test(act("pull_request.review_requested")[0].state));
  ok(/Done/.test(act("pull_request.merged")[0].state));
  deepStrictEqual(act("pull_request.closed_unmerged"), []);
});

await check("B5 branch-aware rules match the base branch and come before lifecycle defaults (§7.1)", () => {
  const m = { ...PR.QLL_DEFAULTS, branchRules: [{ baseBranch: "^staging$", lifecycle: "merged", state: "started:In Review" }] };
  const rules = parseRules(PR.compileLifecycleRules(m));
  strictEqual(evaluate(rules, { trigger: "pull_request.merged", base_branch: "staging" }).actions[0].state, "started:In Review");
  ok(/Done/.test(evaluate(rules, { trigger: "pull_request.merged", base_branch: "main" }).actions[0].state));
});

await check("B5 maps GitHub events onto §7.1 lifecycle triggers", () => {
  const pr = (o) => ({ pull_request: { number: 1, draft: false, merged: false, base: { ref: "main" }, head: { ref: "web-1-x" }, labels: [], user: { login: "octo" }, ...o }, repository: { full_name: "acme/web" }, sender: { login: "octo" } });
  strictEqual(PR.prEventToRuleEvent("pull_request", { action: "opened", ...pr({ draft: true }) }).trigger, "pull_request.drafted");
  strictEqual(PR.prEventToRuleEvent("pull_request", { action: "opened", ...pr({}) }).trigger, "pull_request.opened");
  strictEqual(PR.prEventToRuleEvent("pull_request", { action: "review_requested", ...pr({}) }).trigger, "pull_request.review_requested");
  strictEqual(PR.prEventToRuleEvent("pull_request_review", { action: "submitted", review: { state: "changes_requested" }, ...pr({}) }).trigger, "pull_request.changes_requested");
  strictEqual(PR.prEventToRuleEvent("pull_request_review", { action: "submitted", review: { state: "approved" }, ...pr({}) }).trigger, "pull_request.approved");
  strictEqual(PR.prEventToRuleEvent("pull_request", { action: "closed", ...pr({ merged: true }) }).trigger, "pull_request.merged");
  strictEqual(PR.prEventToRuleEvent("pull_request", { action: "closed", ...pr({ merged: false }) }).trigger, "pull_request.closed_unmerged");
  strictEqual(PR.prEventToRuleEvent("pull_request", { action: "reopened", ...pr({}) }).trigger, "pull_request.reopened");
  strictEqual(PR.prEventToRuleEvent("pull_request", { action: "opened", ...pr({}) }).base_branch, "main");
});

await check("B5 resolves states by (project, group) with the name as fallback, never by name alone across projects (§7.1)", () => {
  deepStrictEqual(PR.resolveStateTarget(QLL, "started:In Review"), { ok: true, stateId: "s-review" });
  deepStrictEqual(PR.resolveStateTarget(DSAF, "cancelled"), { ok: true, stateId: "d-cancel" });
  deepStrictEqual(PR.resolveStateTarget(QLL, "cancelled"), { ok: true, stateId: "s-wont" });
  deepStrictEqual(PR.resolveStateTarget(QLL, "Done"), { ok: true, stateId: "s-done" });
  strictEqual(PR.resolveStateTarget(DSAF, "started:In Review").ok, false);
});

await check("B5 executor writes through A4 for each linked issue, and A4's triage ban propagates (§7.1)", async () => {
  const w = fakeWriter();
  const ex = PR.createRuleExecutor({ writer: w, listStates: async () => QLL, issues: [{ slug: "qelal", projectId: "p-qll", issueId: "i-1" }, { slug: "qelal", projectId: "p-qll", issueId: "i-2" }] });
  await ex.execute({ type: "set_state", state: "started:In Review" }, { trigger: "pull_request.review_requested" });
  deepStrictEqual(w.writes.map((x) => [x.issueId, x.fields?.state]), [["i-1", "s-review"], ["i-2", "s-review"]]);
  await rejects(ex.execute({ type: "set_state", state: "triage" }, { trigger: "pull_request.opened" }));
});

// ---- B6 mirroring -------------------------------------------------------------------------------
await check("B6 conflict defaults and sync direction (§7.3)", () => {
  strictEqual(MI.defaultPolicy("title"), "source_of_truth:github"); strictEqual(MI.defaultPolicy("description"), "source_of_truth:github");
  strictEqual(MI.defaultPolicy("state"), "last_write_wins"); strictEqual(MI.defaultPolicy("assignees"), "last_write_wins");
  strictEqual(MI.shouldApply({ field: "title", from: "plane", policy: "source_of_truth:github", direction: "bidirectional" }), false);
  strictEqual(MI.shouldApply({ field: "title", from: "github", policy: "source_of_truth:github", direction: "bidirectional" }), true);
  strictEqual(MI.shouldApply({ field: "state", from: "plane", policy: "last_write_wins", direction: "bidirectional" }), true);
  strictEqual(MI.shouldApply({ field: "state", from: "plane", policy: "last_write_wins", direction: "github_to_plane" }), false);
});

await check("B6 is label-gated: a GitHub issue labelled `plane` creates a linked Plane item with a cross-link comment; an unlabelled one does nothing", async () => {
  const w = fakeWriter(); const gh = [];
  const deps = { db, plane: w, github: { apply: async (x) => { gh.push(x); return { ok: true, id: 1 }; } }, mapping: { id: 1, workspaceSlug: "qelal", planeProjectId: "p-qll", ghRepoId: 555, syncDirection: "bidirectional", installationId: 1, owner: "acme", repo: "web" }, users };
  await MI.onGithubIssue({ action: "opened", issue: { number: 40, title: "No label", body: "", labels: [], state: "open" }, repository: { id: 555 } }, deps);
  strictEqual(w.writes.length, 0);
  await MI.onGithubIssue({ action: "labeled", label: { name: "plane" }, issue: { number: 41, title: "Mirror me", body: "b", labels: [{ name: "plane" }], state: "open" }, repository: { id: 555 } }, deps);
  ok(w.writes.some((x) => x.kind === "create_issue" && x.fields.name === "Mirror me"), JSON.stringify(w.writes));
  const link = (await db.query(`SELECT created_by, gh_number FROM sync_links WHERE gh_number = 41`)).rows[0];
  strictEqual(link?.created_by, "label_sync");
  ok(gh.some((x) => x.kind === "comment"), "no cross-link comment confirming the connection");
});

// ---- B7 development information -----------------------------------------------------------------
await check("B7 rollups use Jira's vocabulary and previews are detected by provider and by 'Preview' links (§7.4)", () => {
  ok(/OPEN/.test(DI.prRollupTitle({ number: 12, title: "T", state: "open", merged: false, reviews: [] })));
  ok(/MERGED/.test(DI.prRollupTitle({ number: 12, title: "T", state: "closed", merged: true, reviews: [{ state: "APPROVED" }] })));
  ok(/DECLINED/.test(DI.prRollupTitle({ number: 12, title: "T", state: "closed", merged: false, reviews: [] })));
  strictEqual(DI.buildStatus([{ conclusion: "success" }, { conclusion: "success" }]), "pass");
  strictEqual(DI.buildStatus([{ conclusion: "success" }, { conclusion: "failure" }]), "fail");
  const p = DI.detectPreviews({ environmentUrls: ["https://web-git-x.vercel.app", "https://x.netlify.app", "https://y.pages.dev", "https://main.d1.amplifyapp.com", "https://example.com"], body: "[Storybook Preview](https://sb.example.com) and [docs](https://d.example.com)" });
  deepStrictEqual(p.map((x) => x.url).sort(), ["https://main.d1.amplifyapp.com", "https://sb.example.com", "https://web-git-x.vercel.app", "https://x.netlify.app", "https://y.pages.dev"].sort());
  ok(DI.categorisedTitle("CI", "Build #42").startsWith("[CI] "));
});

await check("B7 updates a rollup link in place on later events, keeping its id (§7.4)", async () => {
  const w = fakeWriter();
  const target = { slug: "qelal", projectId: "p-qll", issueId: "i-dev" };
  await DI.upsertRollupLink({ db, writer: w }, target, "pr:555:12", { title: "[PR] #12 T · OPEN", url: "https://github.com/acme/web/pull/12" });
  await DI.upsertRollupLink({ db, writer: w }, target, "pr:555:12", { title: "[PR] #12 T · MERGED", url: "https://github.com/acme/web/pull/12" });
  deepStrictEqual(w.writes.map((x) => x.kind), ["add_link", "update_link"]);
  strictEqual(w.writes[1].linkId, "link-1");
});

// ---- B8 operations ------------------------------------------------------------------------------
await check("B8 dry-run renders what would happen with no writes (§7.6)", async () => {
  const yaml = "- when: pull_request.merged\n  if: { base_branch: \"^main$\" }\n  then:\n    - set_state: Done\n";
  const r = await OPS.dryRun({ rulesYaml: yaml, event: "pull_request", payload: { action: "closed", pull_request: { merged: true, number: 1, base: { ref: "main" }, head: { ref: "x" }, labels: [], user: { login: "o" } }, repository: { full_name: "acme/web" } } });
  deepStrictEqual(r.actions, [{ type: "set_state", state: "Done" }]);
  strictEqual(r.dryRun, true);
});

await check("B8 replays an audited delivery onto its inbound queue under a fresh delivery id, linked to the original (§7.6)", async () => {
  const orig = await L.appendAudit(db, { kind: "inbound_delivery", source: "github", deliveryId: "gd-orig", detail: { event: "push", payload: { ref: "refs/heads/main" } }, outcome: "failed", error: "boom" });
  const enq = [];
  const r = await OPS.replayDelivery({ db, enqueue: async (j) => { enq.push(j); } }, orig);
  strictEqual(enq.length, 1); strictEqual(enq[0].source, "github"); strictEqual(enq[0].event, "push");
  deepStrictEqual(enq[0].payload, { ref: "refs/heads/main" });
  ok(enq[0].deliveryId !== "gd-orig", "a replay must not reuse the original delivery id, or the duplicate ledger drops it");
  const row = (await db.query(`SELECT replay_of FROM audit_log WHERE id = $1`, [r.auditId])).rows[0];
  strictEqual(String(row.replay_of), String(orig));
});

await check("B8 backfill on connect links existing open PRs and issues that reference work items (§7.6)", async () => {
  const github = { request: async (route) => {
    if (/pulls/.test(route)) return { data: [{ number: 70, title: "Fixes QLL-9", body: "", head: { ref: "x" }, state: "open" }] };
    if (/issues/.test(route)) return { data: [{ number: 71, title: "plain", body: "relates to QLL-10" }] };
    return { data: [] };
  } };
  const out = await OPS.backfill({ db, github, mapping: { id: 1, workspaceSlug: "qelal", planeProjectId: "p-qll", ghRepoId: 555, owner: "acme", repo: "web" },
    resolveIssue: async (key) => ({ projectId: "p-qll", issueId: `iss-${key}` }) });
  ok(out.linked >= 2, JSON.stringify(out));
  const rows = (await db.query(`SELECT gh_number, gh_kind, tier FROM sync_links WHERE gh_number IN (70, 71) ORDER BY gh_number`)).rows;
  deepStrictEqual(rows.map((r) => [r.gh_number, r.gh_kind, r.tier]), [[70, "pr", "closing"], [71, "issue", "relation"]]);
});

await db.close();
let bad = 0;
for (const [, err] of results) if (err) bad++;
if (bad) process.exit(1);
console.log(`B4-B8 verification passed (${results.length} checks)`);
process.exit(0);
