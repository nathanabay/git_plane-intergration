import test from "node:test";
import { strictEqual, deepStrictEqual, ok, throws, rejects } from "node:assert/strict";
import { parseRules, evaluate } from "../../src/rules/engine.ts";
import {
  QLL_DEFAULTS, compileLifecycleRules, createRuleExecutor, parseLifecycleMappingFromYaml,
  prEventToRuleEvent, pushToRuleEvent, resolveStateTarget, isReadyForMerge, checkPrReadiness,
} from "../../src/github/pr-automation.ts";
import { TriageWriteRejected } from "../../src/sync/plane.ts";
import { QLL, fakePlaneWriter } from "./fakes.ts";
import { parseReferences } from "../../src/parse/references.ts";

const DSAF = [{ id: "d-todo", name: "Todo", group: "unstarted" }, { id: "d-cancel", name: "Cancelled", group: "cancelled" }, { id: "d-done", name: "Done", group: "completed" }];
const rules = (m = QLL_DEFAULTS) => parseRules(compileLifecycleRules(m));
const states = (trigger: string, base = "main", m = QLL_DEFAULTS) => evaluate(rules(m), { trigger, base_branch: base }).actions.map((a: any) => a.state);

test("defaults: the §7.1 table", () => {
  deepStrictEqual(states("branch.created"), ["started:In Progress"]);
  deepStrictEqual(states("push"), []);
  deepStrictEqual(states("pull_request.drafted"), ["started:In Progress"]);
  deepStrictEqual(states("pull_request.opened"), ["started:In Progress"]);
  deepStrictEqual(states("pull_request.review_requested"), ["started:In Review"]);
  deepStrictEqual(states("pull_request.approved"), []);
  deepStrictEqual(states("pull_request.closed_unmerged"), []);
  deepStrictEqual(states("pull_request.merged", "main"), ["completed:Done"]);
});

test("F5: compiled QLL table fires In Progress for branch.created and does nothing for a plain push", () => {
  deepStrictEqual(states("branch.created"), ["started:In Progress"]);
  deepStrictEqual(states("push"), []);
});

test("defaults: merging into a non-main branch changes nothing", () => {
  deepStrictEqual(states("pull_request.merged", "develop"), []);
  deepStrictEqual(states("pull_request.merged", "main-backup"), []);
});

test("compile: branch rules come first, in order, and the first match wins", () => {
  const m = { ...QLL_DEFAULTS, branchRules: [
    { baseBranch: "^staging$", lifecycle: "merged" as const, state: "started:In Review" },
    { baseBranch: "^stag", lifecycle: "merged" as const, state: "cancelled" },
  ] };
  deepStrictEqual(states("pull_request.merged", "staging", m), ["started:In Review"]);
  deepStrictEqual(states("pull_request.merged", "stage-2", m), ["cancelled"]);
  deepStrictEqual(states("pull_request.merged", "main", m), ["completed:Done"]);
});

test("compile: invalid mappings are refused before they become rules", () => {
  throws(() => compileLifecycleRules({ ...QLL_DEFAULTS, branchRules: [{ baseBranch: "(", lifecycle: "merged", state: "Done" }] }), /regex/);
  throws(() => compileLifecycleRules({ ...QLL_DEFAULTS, branchRules: [{ baseBranch: "x", lifecycle: "bogus" as any, state: "Done" }] }), /lifecycle/);
  throws(() => compileLifecycleRules({ ...QLL_DEFAULTS, states: { opened: "  " } }), /state target/);
  throws(() => compileLifecycleRules({ ...QLL_DEFAULTS, mergedBaseBranch: "[" }), /regex/);
});

test("compile: state names with YAML-special characters survive the round trip", () => {
  const m = { ...QLL_DEFAULTS, states: { opened: "started:Won't: Do #1 {x}" } };
  deepStrictEqual(states("pull_request.opened", "main", m), ["started:Won't: Do #1 {x}"]);
});

test("compile: an empty mapping compiles to rules the engine accepts only if there is something to say", () => {
  const empty = { states: {}, mergedBaseBranch: "^main$", branchRules: [] };
  strictEqual(parseRules(compileLifecycleRules(empty)).length, 0);
});

const pr = (o: object = {}) => ({
  pull_request: { number: 7, title: "T", html_url: "https://github.com/acme/web/pull/7", draft: false, merged: false, base: { ref: "main" }, head: { ref: "web-1-x" }, labels: [{ name: "hotfix" }], user: { login: "octo" }, ...o },
  repository: { full_name: "acme/web" }, sender: { login: "octo" },
});

test("events: lifecycle triggers", () => {
  const t = (event: string, payload: object) => prEventToRuleEvent(event, payload)?.trigger ?? null;
  strictEqual(t("pull_request", { action: "opened", ...pr({ draft: true }) }), "pull_request.drafted");
  strictEqual(t("pull_request", { action: "converted_to_draft", ...pr() }), "pull_request.drafted");
  strictEqual(t("pull_request", { action: "ready_for_review", ...pr() }), "pull_request.opened");
  strictEqual(t("pull_request", { action: "closed", ...pr({ merged: true }) }), "pull_request.merged");
  strictEqual(t("pull_request", { action: "closed", ...pr() }), "pull_request.closed_unmerged");
  strictEqual(t("pull_request_review", { action: "submitted", review: { state: "APPROVED" }, ...pr() }), "pull_request.approved");
});

test("events: things that are not lifecycle points are null", () => {
  strictEqual(prEventToRuleEvent("pull_request", { action: "synchronize", ...pr() }), null);
  strictEqual(prEventToRuleEvent("pull_request_review", { action: "submitted", review: { state: "commented" }, ...pr() }), null);
  strictEqual(prEventToRuleEvent("pull_request_review", { action: "dismissed", review: { state: "approved" }, ...pr() }), null);
  strictEqual(prEventToRuleEvent("pull_request", { action: "opened" }), null);
  strictEqual(prEventToRuleEvent("issues", { action: "opened", ...pr() }), null);
});

test("events: branches, labels, author, repo and template context are filled in; absent fields are omitted", () => {
  const e = prEventToRuleEvent("pull_request", { action: "opened", ...pr() })!;
  deepStrictEqual(e, { trigger: "pull_request.opened", repo: "acme/web", base_branch: "main", head_branch: "web-1-x", labels: ["hotfix"], author: "octo",
    context: { pr: { number: 7, title: "T", url: "https://github.com/acme/web/pull/7", branch: "web-1-x", base: "main", author: "octo" } } });
  const bare = prEventToRuleEvent("pull_request", { action: "opened", pull_request: { number: 1 } })!;
  deepStrictEqual(Object.keys(bare).sort(), ["context", "trigger"]);
});

test("events: a rule's {{pr.url}} template renders from the event context", () => {
  const e = prEventToRuleEvent("pull_request", { action: "closed", ...pr({ merged: true }) })!;
  const r = parseRules("- when: pull_request.merged\n  then:\n    - comment: 'Deployed via {{pr.url}}'\n");
  deepStrictEqual(evaluate(r, e).actions, [{ type: "comment", body: "Deployed via https://github.com/acme/web/pull/7" }]);
});

test("events: branch pushes become the push trigger; deletes and tags do not", () => {
  deepStrictEqual(pushToRuleEvent({ ref: "refs/heads/web-1-x", repository: { full_name: "acme/web" }, sender: { login: "o" } }),
    { trigger: "push", head_branch: "web-1-x", repo: "acme/web", author: "o" });
  strictEqual(pushToRuleEvent({ ref: "refs/tags/v1" }), null);
  strictEqual(pushToRuleEvent({ ref: "refs/heads/x", deleted: true }), null);
});

test("states: group and name, group only, name only", () => {
  deepStrictEqual(resolveStateTarget(QLL, "started:In Review"), { ok: true, stateId: "s-review" });
  deepStrictEqual(resolveStateTarget(QLL, "STARTED:in progress"), { ok: true, stateId: "s-prog" });
  deepStrictEqual(resolveStateTarget(QLL, "completed"), { ok: true, stateId: "s-done" });
  deepStrictEqual(resolveStateTarget(QLL, "Won't Do"), { ok: true, stateId: "s-wont" });
});

test("states: a bare group prefers the project's default state", () => {
  const s = [{ id: "a", name: "A", group: "started" }, { id: "b", name: "B", group: "started", default: true }];
  deepStrictEqual(resolveStateTarget(s, "started"), { ok: true, stateId: "b" });
});

test("states: the group is the stable key across projects with different names", () => {
  deepStrictEqual(resolveStateTarget(DSAF, "cancelled:Won't Do"), { ok: true, stateId: "d-cancel" });
  deepStrictEqual(resolveStateTarget(DSAF, "unstarted:To Do"), { ok: true, stateId: "d-todo" });
  deepStrictEqual(resolveStateTarget(QLL, "started:Doing"), { ok: false, reason: "not_found" });
});

test("states: bare names must be unique; an absent group is not found", () => {
  const dup = [{ id: "a", name: "QA", group: "started" }, { id: "b", name: "QA", group: "completed" }];
  deepStrictEqual(resolveStateTarget(dup, "QA"), { ok: false, reason: "ambiguous" });
  deepStrictEqual(resolveStateTarget(dup, "started:QA"), { ok: true, stateId: "a" });
  deepStrictEqual(resolveStateTarget(DSAF, "started"), { ok: false, reason: "not_found" });
  deepStrictEqual(resolveStateTarget(DSAF, "nope"), { ok: false, reason: "not_found" });
});

const issue = (id: string, extra: object = {}) => ({ slug: "qelal", projectId: "p-qll", issueId: id, ...extra });
const ev = (trigger: string) => ({ trigger });

test("executor: set_state writes every linked issue through the writer", async () => {
  const w = fakePlaneWriter();
  const ex = createRuleExecutor({ writer: w, listStates: async () => QLL, issues: [issue("i-1"), issue("i-2")] });
  await ex.execute({ type: "set_state", state: "started:In Review" }, ev("pull_request.review_requested"));
  deepStrictEqual(w.writes.map((x: any) => [x.issueId, x.fields.state]), [["i-1", "s-review"], ["i-2", "s-review"]]);
});

test("executor: states are listed once per project, not per action", async () => {
  let calls = 0;
  const ex = createRuleExecutor({ writer: fakePlaneWriter(), listStates: async () => { calls++; return QLL; }, issues: [issue("i-1"), issue("i-2")] });
  await ex.execute({ type: "set_state", state: "started" }, ev("push"));
  await ex.execute({ type: "set_state", state: "started:In Review" }, ev("push"));
  strictEqual(calls, 1);
});

test("executor: the triage ban propagates and an unresolvable state is an error", async () => {
  const ex = createRuleExecutor({ writer: fakePlaneWriter(), listStates: async () => QLL, issues: [issue("i-1")] });
  await rejects(ex.execute({ type: "set_state", state: "triage" }, ev("x")), TriageWriteRejected);
  await rejects(ex.execute({ type: "set_state", state: "started:Nowhere" }, ev("x")), /does not exist|ambiguous/);
});

test("executor: §6 — merge advances closing links only once every linked PR merged", async () => {
  const w = fakePlaneWriter();
  const ex = createRuleExecutor({ writer: w, listStates: async () => QLL, issues: [
    issue("all-merged", { linkedPrs: [{ state: "merged" }, { state: "closed_unmerged" }] }),
    issue("one-open", { linkedPrs: [{ state: "merged" }, { state: "open" }] }),
    issue("non-closing", { tier: "non_closing" }),
    issue("relation", { tier: "relation" }),
    issue("no-info"),
  ] });
  await ex.execute({ type: "set_state", state: "completed:Done" }, ev("pull_request.merged"));
  deepStrictEqual(w.writes.map((x: any) => x.issueId), ["all-merged", "no-info"]);
});

test("executor: non-closing links still advance on non-merge events; relation links never move", async () => {
  const w = fakePlaneWriter();
  const ex = createRuleExecutor({ writer: w, listStates: async () => QLL, issues: [issue("nc", { tier: "non_closing" }), issue("rel", { tier: "relation" })] });
  await ex.execute({ type: "set_state", state: "started:In Review" }, ev("pull_request.review_requested"));
  deepStrictEqual(w.writes.map((x: any) => x.issueId), ["nc"]);
});
test("E2E-4: the parsed Ref title advances through the workflow and skips the merged state", async () => {
  const parsed = parseReferences({ branch: "e2e_run-s34", title: "Ref GITSY-82", body: "GITSY-82" });
  strictEqual(parsed.refs.length, 1); strictEqual(parsed.refs[0]!.tier, "non_closing");
  const w = fakePlaneWriter(); let stateReads = 0;
  const ex = createRuleExecutor({ writer: w, listStates: async () => { stateReads++; return QLL; }, issues: [issue("i-82", { tier: parsed.refs[0]!.tier })] });
  for (const [trigger, state] of [
    ["pull_request.opened", "started:In Progress"],
    ["pull_request.ready_for_review", "started:In Review"],
    ["pull_request.review_requested", "started:In Review"],
    ["pull_request.ready_for_merge", "started:In Review"],
  ] as const) {
    await ex.execute({ type: "set_state", state }, ev(trigger));
  }
  deepStrictEqual(w.writes.map((write: any) => write.fields.state), ["s-prog", "s-review", "s-review", "s-review"]);
  strictEqual(stateReads, 1);
  await ex.execute({ type: "set_state", state: "completed:Done" }, ev("pull_request.merged"));
  strictEqual(w.writes.length, 4); strictEqual(stateReads, 1, "a non-closing merge is skipped before state lookup");
  // Non-closing references also retain their additive development link.
  await ex.execute({ type: "add_link", url: "https://github.example/o/r/pull/82", title: "PR 82" }, ev("pull_request.opened"));
  deepStrictEqual(w.writes.map((write) => write.kind), ["update_issue", "update_issue", "update_issue", "update_issue", "add_link"]);
});

test("executor: comment, log_time and add_link become Plane writes with escaped text", async () => {
  const w = fakePlaneWriter();
  const ex = createRuleExecutor({ writer: w, listStates: async () => QLL, issues: [issue("i-1")] });
  await ex.execute({ type: "comment", body: "<b>x</b>" }, ev("x"));
  await ex.execute({ type: "log_time", duration: "2h" }, ev("x"));
  await ex.execute({ type: "add_link", url: "https://e.x", title: "T" }, ev("x"));
  deepStrictEqual(w.writes.map((x) => x.kind), ["add_comment", "add_comment", "add_link"]);
  ok(!(w.writes[0] as any).commentHtml.includes("<b>"));
});

test("executor: labels and assignees merge into the current lists and need them supplied", async () => {
  const w = fakePlaneWriter();
  const cur = { labels: ["l-old"], assignees: ["u-1"] };
  const ex = createRuleExecutor({ writer: w, listStates: async () => QLL, issues: [issue("i-1")], getIssueFields: async () => cur });
  await ex.execute({ type: "add_label", label: "shipped" }, ev("x"));
  await ex.execute({ type: "assign", assignee: "u-2" }, ev("x"));
  const updates = w.writes.filter((x) => x.kind === "update_issue") as any[];
  deepStrictEqual(updates.map((u) => u.fields), [{ labels: ["l-old", "id-1"] }, { assignees: ["u-1", "u-2"] }]);
  const bare = createRuleExecutor({ writer: fakePlaneWriter(), listStates: async () => QLL, issues: [issue("i-1")] });
  await rejects(bare.execute({ type: "add_label", label: "x" }, ev("x")), /current labels/);
});

test("executor: an unmapped assignee is skipped; the actor token rides along on writes", async () => {
  const { SecretString } = await import("../../src/auth/identity.ts");
  const w = fakePlaneWriter();
  const ex = createRuleExecutor({ writer: w, listStates: async () => QLL, issues: [issue("i-1")], actorToken: new SecretString("plane_api_ME"),
    getIssueFields: async () => ({ labels: [], assignees: [] }), resolveAssignee: async () => null });
  await ex.execute({ type: "assign", assignee: "ghost" }, ev("x"));
  strictEqual(w.writes.length, 0);
  await ex.execute({ type: "comment", body: "hi" }, ev("x"));
  strictEqual(w.writes[0]!.token, "plane_api_ME");
});

test("executor: create_issue makes one item however many issues are linked", async () => {
  const w = fakePlaneWriter();
  const ex = createRuleExecutor({ writer: w, listStates: async () => QLL, issues: [issue("a"), issue("b")] });
  await ex.execute({ type: "create_issue", project: "p-other", title: "Follow-up" }, ev("x"));
  strictEqual(w.writes.length, 1);
  deepStrictEqual((w.writes[0] as any).fields, { name: "Follow-up" });
  await rejects(createRuleExecutor({ writer: w, listStates: async () => QLL, issues: [] }).execute({ type: "create_issue", project: "p", title: "t" }, ev("x")), /slug/);
});

test("F11: compileLifecycleRules embeds mapping JSON and parseLifecycleMappingFromYaml parses it back", () => {
  const m = {
    states: { opened: "started:In Progress", approved: "started:In Review", merged: "completed:Done" },
    mergedBaseBranch: "^release/.*$",
    branchRules: [{ baseBranch: "^feature/.*$", lifecycle: "opened" as const, state: "started:Features" }],
  };
  const y = compileLifecycleRules(m);
  ok(y.startsWith("# gitsync-lifecycle-mapping: "));
  const parsed = parseLifecycleMappingFromYaml(y);
  deepStrictEqual(parsed, m);
});

test("F11: parseLifecycleMappingFromYaml returns null for hand-written YAML or missing comment", () => {
  strictEqual(parseLifecycleMappingFromYaml("- when: push\n  then:\n    - set_state: Done\n"), null);
  strictEqual(parseLifecycleMappingFromYaml(""), null);
  strictEqual(parseLifecycleMappingFromYaml("# gitsync-lifecycle-mapping: invalid-json"), null);
});

test("F11: parseLifecycleMappingFromYaml returns null when hand-written YAML diverged from comment", () => {
  const m = { ...QLL_DEFAULTS };
  const y = compileLifecycleRules(m);
  const edited = y + "\n- name: custom rule\n  when: push\n  then:\n    - comment: hello\n";
  strictEqual(parseLifecycleMappingFromYaml(edited), null);
});

test("F18: parseLifecycleMappingFromYaml returns null when comment JSON is edited by hand", () => {
  const m = { ...QLL_DEFAULTS };
  const y = compileLifecycleRules(m);
  // Modify only the comment JSON without changing the YAML body
  const editedComment = y.replace(/"opened":"started:In Progress"/, '"opened":"completed:Done"');
  strictEqual(parseLifecycleMappingFromYaml(editedComment), null);
});

test("F3: successive add_label actions within an executor retain all labels (no queued-read clobber)", async () => {
  const w = fakePlaneWriter();
  w.apply = async (write: any) => {
    if (write.kind === "upsert_label") {
      return { ok: true, id: `lbl-${write.name}` };
    }
    w.writes.push(write);
    return { ok: true };
  };
  const ex = createRuleExecutor({
    writer: w,
    listStates: async () => QLL,
    issues: [issue("i-1")],
    getIssueFields: async () => ({ labels: [], assignees: [] }),
  });
  await ex.execute({ type: "add_label", label: "backend" }, ev("x"));
  await ex.execute({ type: "add_label", label: "frontend" }, ev("x"));
  const updates = w.writes.filter((x: any) => x.kind === "update_issue") as any[];
  strictEqual(updates.length, 2);
  deepStrictEqual(updates[0]?.fields, { labels: ["lbl-backend"] });
  deepStrictEqual(updates[1]?.fields, { labels: ["lbl-backend", "lbl-frontend"] });
});

test("F3: createRuleExecutor routes add_label, remove_label and assign through writer.mutateIssue when provided", async () => {
  const w = fakePlaneWriter();
  const mutations: any[] = [];
  w.apply = async (write: any) => {
    if (write.kind === "upsert_label") {
      return { ok: true, id: `lbl-${write.name}` };
    }
    w.writes.push(write);
    return { ok: true };
  };
  const writerWithMutate = {
    ...w,
    async mutateIssue(target: any, mutation: any, opts: any) {
      mutations.push({ target, mutation, opts });
      return { ok: true };
    },
  };
  const ex = createRuleExecutor({
    writer: writerWithMutate,
    listStates: async () => QLL,
    issues: [issue("i-1")],
  });
  await ex.execute({ type: "add_label", label: "backend" }, ev("x"));
  await ex.execute({ type: "remove_label", label: "backend" }, ev("x"));
  await ex.execute({ type: "assign", assignee: "user-42" }, ev("x"));

  strictEqual(mutations.length, 3);
  deepStrictEqual(mutations[0], {
    target: { slug: "qelal", projectId: "p-qll", issueId: "i-1" },
    mutation: { kind: "add_label", name: "backend" },
    opts: undefined,
  });
  deepStrictEqual(mutations[1], {
    target: { slug: "qelal", projectId: "p-qll", issueId: "i-1" },
    mutation: { kind: "remove_label", name: "backend" },
    opts: undefined,
  });
  deepStrictEqual(mutations[2], {
    target: { slug: "qelal", projectId: "p-qll", issueId: "i-1" },
    mutation: { kind: "assign", id: "user-42" },
    opts: undefined,
  });
  const updates = w.writes.filter((x: any) => x.kind === "update_issue");
  strictEqual(updates.length, 0);
  // Also verify no upsert_label write was executed since mutateIssue handles label upsert
  const upserts = w.writes.filter((x: any) => x.kind === "upsert_label");
  strictEqual(upserts.length, 0);
});

test("F10: createRuleExecutor adds skipTerminalState: true for branch.created set_state writes only", async () => {
  const w = fakePlaneWriter();
  const ex = createRuleExecutor({
    writer: w,
    listStates: async () => QLL,
    issues: [issue("i-1")],
  });

  // branch.created trigger carries skipTerminalState: true
  await ex.execute({ type: "set_state", state: "started:In Progress" }, ev("branch.created"));
  const branchWrite = w.writes[w.writes.length - 1] as any;
  strictEqual(branchWrite.kind, "update_issue");
  strictEqual(branchWrite.skipTerminalState, true);

  // Other triggers (e.g. push, pull_request.opened) do NOT carry skipTerminalState
  await ex.execute({ type: "set_state", state: "started:In Progress" }, ev("push"));
  const pushWrite = w.writes[w.writes.length - 1] as any;
  strictEqual(pushWrite.kind, "update_issue");
  strictEqual(pushWrite.skipTerminalState, undefined);

  await ex.execute({ type: "set_state", state: "started:In Progress" }, ev("pull_request.opened"));
  const prWrite = w.writes[w.writes.length - 1] as any;
  strictEqual(prWrite.kind, "update_issue");
  strictEqual(prWrite.skipTerminalState, undefined);
});

test("F7: isReadyForMerge requires all check suites passed and latest review per reviewer approved", () => {
  const reviews = [
    { user: { login: "alice" }, state: "APPROVED" },
    { user: { login: "bob" }, state: "APPROVED" },
  ];
  const suites = [
    { status: "completed", conclusion: "success" },
  ];
  strictEqual(isReadyForMerge(reviews, suites), true);

  const withChanges = [
    { user: { login: "alice" }, state: "APPROVED" },
    { user: { login: "charlie" }, state: "CHANGES_REQUESTED" },
  ];
  strictEqual(isReadyForMerge(withChanges, suites), false);

  const resolved = [
    { user: { login: "alice" }, state: "APPROVED" },
    { user: { login: "charlie" }, state: "CHANGES_REQUESTED" },
    { user: { login: "charlie" }, state: "APPROVED" },
  ];
  strictEqual(isReadyForMerge(resolved, suites), true);

  const failingSuites = [
    { status: "completed", conclusion: "failure" },
  ];
  strictEqual(isReadyForMerge(reviews, failingSuites), false);

  const neutralSuites = [
    { status: "completed", conclusion: "neutral" },
  ];
  strictEqual(isReadyForMerge(reviews, neutralSuites), true);

  const runningSuites = [
    { status: "in_progress", conclusion: null as any },
  ];
  strictEqual(isReadyForMerge(reviews, runningSuites), false);

  strictEqual(isReadyForMerge([], suites), false);
  strictEqual(isReadyForMerge(reviews, []), true);
});

test("F7: checkPrReadiness queries GitHub reviews, check-suites, and commit-status endpoints", async () => {
  const calls: string[] = [];
  const fakeOctokit = {
    async request<T = any>(route: string, params?: Record<string, unknown>): Promise<{ data: T }> {
      calls.push(route);
      if (route.includes("/reviews")) {
        return { data: [{ user: { login: "alice" }, state: "APPROVED" }] as unknown as T };
      }
      if (route.includes("/check-suites")) {
        return { data: { check_suites: [{ status: "completed", conclusion: "success" }] } as unknown as T };
      }
      if (route.includes("/status")) {
        return { data: { state: "success", total_count: 1 } as unknown as T };
      }
      return { data: {} as unknown as T };
    },
  };
  const ready = await checkPrReadiness(fakeOctokit, { owner: "acme", repo: "web" }, 7, "abc123");
  strictEqual(ready, true);
  deepStrictEqual(calls.sort(), [
    "GET /repos/{owner}/{repo}/commits/{ref}/check-suites",
    "GET /repos/{owner}/{repo}/commits/{ref}/status",
    "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
  ]);
});

test("F9: isReadyForMerge handles skipped suites, stale suites, ignores 0-run suites, and allows zero suites", () => {
  const reviews = [{ user: { login: "alice" }, state: "APPROVED" }];

  // Zero suites allowed
  strictEqual(isReadyForMerge(reviews, []), true);

  // Ignore latest_check_runs_count === 0
  const zeroRunSuite = [{ status: "queued", conclusion: null, latest_check_runs_count: 0 }];
  strictEqual(isReadyForMerge(reviews, zeroRunSuite), true);

  // Queued suite with runs > 0 blocks
  const realQueuedSuite = [{ status: "queued", conclusion: null, latest_check_runs_count: 1 }];
  strictEqual(isReadyForMerge(reviews, realQueuedSuite), false);

  // Skipped suite accepted
  const skippedSuite = [{ status: "completed", conclusion: "skipped" }];
  strictEqual(isReadyForMerge(reviews, skippedSuite), true);

  // Stale suite non-blocking
  const staleSuite = [{ status: "completed", conclusion: "stale" }];
  strictEqual(isReadyForMerge(reviews, staleSuite), true);
  const staleInProgress = [{ status: "in_progress", conclusion: "stale" }];
  strictEqual(isReadyForMerge(reviews, staleInProgress), true);
});

test("F9: isReadyForMerge evaluates commit status: blocks on failure/pending and passes on success or zero statuses", () => {
  const reviews = [{ user: { login: "alice" }, state: "APPROVED" }];
  const suites = [{ status: "completed", conclusion: "success" }];

  // Success status passes
  strictEqual(isReadyForMerge(reviews, suites, { state: "success", total_count: 1 }), true);

  // Zero commit statuses passes (GitHub returns state "pending" with total_count: 0 when no statuses)
  strictEqual(isReadyForMerge(reviews, suites, { state: "pending", total_count: 0 }), true);
  strictEqual(isReadyForMerge(reviews, suites, { total_count: 0 }), true);

  // Pending with statuses > 0 blocks
  strictEqual(isReadyForMerge(reviews, suites, { state: "pending", total_count: 1 }), false);

  // Failure or error status blocks
  strictEqual(isReadyForMerge(reviews, suites, { state: "failure", total_count: 1 }), false);
  strictEqual(isReadyForMerge(reviews, suites, { state: "error", total_count: 1 }), false);
  strictEqual(isReadyForMerge(reviews, suites, { state: "failure" }), false);
});

test("F9: checkPrReadiness paginates reviews and check-suites across pages and queries combined commit status", async () => {
  const pagesRequested: Record<string, number[]> = {};
  const fakeOctokit = {
    async request<T = any>(route: string, params?: Record<string, unknown>): Promise<{ data: T }> {
      const page = Number(params?.page ?? 1);
      pagesRequested[route] = pagesRequested[route] ?? [];
      pagesRequested[route].push(page);

      if (route.includes("/reviews")) {
        if (page === 1) {
          // Page 1: 100 reviews ending with a CHANGES_REQUESTED
          const page1 = Array.from({ length: 99 }, (_, i) => ({ user: { login: `user-${i}` }, state: "COMMENTED" }));
          page1.push({ user: { login: "alice" }, state: "CHANGES_REQUESTED" });
          return { data: page1 as unknown as T };
        }
        // Page 2: alice approves!
        return { data: [{ user: { login: "alice" }, state: "APPROVED" }] as unknown as T };
      }
      if (route.includes("/check-suites")) {
        if (page === 1) {
          // Page 1: 100 check suites all completed
          const page1 = Array.from({ length: 100 }, () => ({ status: "completed", conclusion: "success" }));
          return { data: { total_count: 101, check_suites: page1 } as unknown as T };
        }
        return { data: { total_count: 101, check_suites: [{ status: "completed", conclusion: "success" }] } as unknown as T };
      }
      if (route.includes("/commits/{ref}/status")) {
        return { data: { state: "success", total_count: 2 } as unknown as T };
      }
      return { data: {} as unknown as T };
    },
  };

  const ready = await checkPrReadiness(fakeOctokit, { owner: "acme", repo: "web" }, 7, "abc123");
  strictEqual(ready, true);
  deepStrictEqual(pagesRequested["GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews"], [1, 2]);
  deepStrictEqual(pagesRequested["GET /repos/{owner}/{repo}/commits/{ref}/check-suites"], [1, 2]);
  strictEqual(pagesRequested["GET /repos/{owner}/{repo}/commits/{ref}/status"]?.length, 1);
});

test("F7: prEventToRuleEvent emits ready_for_merge only on verified readiness, not auto_merge_enabled", () => {
  const t = (event: string, payload: object, opts?: any) => prEventToRuleEvent(event, payload, opts)?.trigger ?? null;

  const reviewPayload = {
    action: "submitted",
    review: { state: "approved" },
    ...pr(),
  };

  strictEqual(t("pull_request_review", reviewPayload), "pull_request.approved");
  strictEqual(t("pull_request_review", reviewPayload, { isReadyForMerge: true }), "pull_request.ready_for_merge");

  const checkSuitePayload = {
    action: "completed",
    check_suite: { conclusion: "success", head_sha: "abc123", pull_requests: [pr().pull_request] },
    repository: { full_name: "acme/web" },
    sender: { login: "octo" },
  };

  strictEqual(t("check_suite", checkSuitePayload, { isReadyForMerge: true }), "pull_request.ready_for_merge");
  strictEqual(t("check_suite", checkSuitePayload, { isReadyForMerge: false }), null);

  const draftPayload = {
    action: "submitted",
    review: { state: "approved" },
    ...pr({ draft: true }),
  };
  strictEqual(t("pull_request_review", draftPayload, { isReadyForMerge: true }), "pull_request.approved");

  strictEqual(t("pull_request", { action: "auto_merge_enabled", ...pr() }), null);
  strictEqual(t("pull_request", { action: "ready_for_merge", ...pr() }), null);
});

