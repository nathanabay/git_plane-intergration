import test from "node:test";
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { ruleEventsFor } from "../../src/app/rule-events.ts";
import { toRuleEvents } from "../../src/operations/tooling.ts";
import { ghJob, makeHarness, planeJob, REPO, sha } from "./harness.ts";

const commentRule = (trigger: string) => `- when: ${trigger}\n  then: [{ comment: "rule:${trigger}" }]\n`;
const comments = (h: Awaited<ReturnType<typeof makeHarness>>) => h.plane.writes().filter((c) => /\/comments\/$/.test(c.path));

for (const [event, payload, triggers] of [
  ["push", { ref: "refs/heads/main", repository: { ...REPO, default_branch: "main" } }, ["push", "commit.pushed_to_default"]],
  ["push", { ref: "refs/heads/topic" }, ["push"]],
  ["check_suite", { action: "completed", check_suite: { conclusion: "success" } }, ["check_suite.success"]],
  ["check_run", { action: "completed", check_run: { conclusion: "failure" } }, []],
  ["deployment_status", { deployment_status: { state: "success" } }, ["deployment_status.success"]],
  ["issues", { action: "closed", issue: { number: 7, labels: [{ name: "bug" }] } }, ["issue.closed"]],
  ["issue_comment", { action: "edited", issue: { number: 7 }, comment: { body: "hello" } }, ["comment.edited"]],
] as const) {
  test(`F7 shared live/dry-run translation: ${event} → ${triggers.join(",")}`, () => {
    const p = { repository: REPO, ...payload };
    strictEqual(ruleEventsFor("github", event, p).map((e) => e.trigger).join(","), triggers.join(","));
    deepStrictEqual(toRuleEvents(event, p), ruleEventsFor("github", event, p));
  });
}

test("F7 deleted branches, tags, and incomplete checks do not emit automation events", () => {
  for (const p of [{ ref: "refs/tags/v1" }, { ref: "refs/heads/main", deleted: true, repository: { default_branch: "main" } }]) {
    deepStrictEqual(ruleEventsFor("github", "push", p), []);
  }
  deepStrictEqual(ruleEventsFor("github", "check_run", { action: "created", check_run: { conclusion: "success" } }), []);
});

for (const action of ["created", "edited", "deleted"]) {
  test(`F7 live GitHub comment.${action} reaches linked PR targets`, async (t) => {
    const h = await makeHarness(); t.after(() => h.close());
    await h.mapping({ rules: commentRule(`comment.${action}`) });
    await h.link("iss-1", 12, { kind: "pr" });
    await h.feed(ghJob("issue_comment", { action, issue: { number: 12, pull_request: {}, labels: [] }, comment: { body: "Human", user: { login: "octo" } } }));
    strictEqual(comments(h).length, 1);
    strictEqual(comments(h)[0]!.body.comment_html, `<p>rule:comment.${action}</p>`);
    deepStrictEqual((await h.audit("rule_match")).map((r) => r.detail.trigger), [`comment.${action}`]);
  });
}

test("F7 live issue rule targets active links in this mapping only, without requiring mirror opt-in", async (t) => {
  const h = await makeHarness(); t.after(() => h.close());
  await h.mapping({ rules: commentRule("issue.opened") });
  await h.link("iss-1", 7);
  await h.db.query("UPDATE sync_links SET created_by = 'magic_word', tier = 'non_closing'");
  await h.link("other-workspace", 7, { slug: "other" });
  await h.db.query("UPDATE sync_links SET created_by = 'magic_word'");
  await h.link("other-project", 7, { project: "p-web" });
  await h.db.query("UPDATE sync_links SET created_by = 'magic_word'");
  await h.link("gone", 7);
  await h.db.query("UPDATE sync_links SET status = 'orphaned' WHERE plane_issue_id = 'gone'");
  await h.feed(ghJob("issues", { action: "opened", issue: { number: 7, title: "T", labels: [] } }));
  deepStrictEqual(comments(h).map((c) => c.path), ["/workspaces/ws/projects/p-qll/work-items/iss-1/comments/"]);
});

for (const event of ["check_suite"]) {
  test(`F7 live ${event}.success fires once for a repeated PR entry`, async (t) => {
    const h = await makeHarness(); t.after(() => h.close());
    await h.mapping({ rules: commentRule("check_suite.success") });
    await h.link("iss-1", 12, { kind: "pr" });
    h.gh.respond(/pulls\/\{pull_number\}$/, () => ({ number: 12, state: "open", head: { sha: sha("a"), ref: "topic" }, base: { repo: REPO } }));
    h.gh.respond(/commits\/\{commit_sha\}\/pulls$/, () => []);
    h.gh.respond(/check-suites$/, () => ({ check_suites: [], total_count: 0 }));
    h.gh.respond(/reviews$/, () => []);
    h.gh.respond(/commits\/\{ref\}\/status$/, () => ({ state: "pending", total_count: 0 }));
    h.gh.respond(/check-runs$/, () => ({ total_count: 1, check_runs: [{ conclusion: "success" }] }));
    await h.feed(ghJob(event, { action: "completed", [event]: { head_sha: sha("a"), head_branch: "topic", conclusion: "success", pull_requests: [{ number: 12 }, { number: 12 }] } }));
    strictEqual(comments(h).length, 1);
    deepStrictEqual((await h.audit("rule_match")).map((r) => r.detail.trigger), ["check_suite.success"]);
  });
}

test("F7 live deployment success resolves linked PR targets", async (t) => {
  const h = await makeHarness(); t.after(() => h.close());
  await h.mapping({ rules: commentRule("deployment_status.success") });
  await h.link("iss-1", 12, { kind: "pr" });
  h.gh.respond(/commits\/\{commit_sha\}\/pulls$/, () => [{ number: 12, head: { ref: "topic", repo: REPO } }]);
  await h.feed(ghJob("deployment_status", { deployment: { id: 501, created_at: "2026-10-12T10:00:00Z", sha: sha("b"), ref: "main" }, deployment_status: { id: 601, created_at: "2026-10-12T10:01:00Z", state: "success", environment: "production" } }));
  strictEqual(comments(h).length, 1);
  deepStrictEqual((await h.audit("rule_match")).map((r) => r.detail.trigger), ["deployment_status.success"]);
});

for (const trigger of ["push", "commit.pushed_to_default"]) {
  test(`F7 live ${trigger} on an existing branch resolves its permitted targets`, async (t) => {
    const h = await makeHarness(); t.after(() => h.close());
    await h.mapping({ rules: commentRule(trigger), smartCommits: false });
    await h.link("iss-1", 12, { kind: "pr" });
    await h.link("iss-1", 13, { kind: "pr" });
    const branch = trigger === "push" ? "topic" : "main";
    h.gh.respond(/commits\/\{commit_sha\}\/pulls$/, () => [{ number: 12, head: { ref: branch, repo: REPO } }, { number: 13, head: { ref: branch, repo: REPO } }]);
    await h.feed(ghJob("push", { ref: `refs/heads/${branch}`, created: false, repository: { ...REPO, default_branch: "main" }, commits: [{ id: sha("c"), message: trigger === "push" ? "ordinary commit" : "Fixes QLL-1" }], after: sha("c") }));
    strictEqual(comments(h).length, 1, "one work item linked from two PRs is one target");
    deepStrictEqual((await h.audit("rule_match")).map((r) => r.detail.trigger), [trigger]);
  });
}

test("F7 push references and linked PRs share one target and retain the closing tier", async (t) => {
  const h = await makeHarness(); t.after(() => h.close());
  await h.mapping({ rules: "- when: push\n  then: [{ set_state: 'completed:Done' }]\n", smartCommits: false });
  await h.link("iss-1", 12, { kind: "pr", tier: "relation" });
  await h.db.query("UPDATE sync_links SET created_by = 'magic_word'");
  h.gh.respond(/commits\/\{commit_sha\}\/pulls$/, () => [{ number: 12, head: { ref: "topic", repo: REPO } }]);
  await h.feed(ghJob("push", { ref: "refs/heads/topic", repository: { ...REPO, default_branch: "main" }, commits: [{ id: sha("d"), message: "Fixes QLL-1" }] }));
  deepStrictEqual(h.plane.writes().filter((c) => c.method === "PATCH").map((c) => c.body), [{ state: "s-done" }]);
});

test("F7 Plane issue/comment spellings use the shared translator and Plane audit source", async (t) => {
  const h = await makeHarness(); t.after(() => h.close());
  await h.mapping({ rules: "- when: [issue.updated, comment.updated]\n  then: [{ comment: 'Plane rule' }]\n" });
  for (const [event, action, data, trigger] of [
    ["issue", "update", { id: "iss-1", project: "p-qll", name: "T" }, "issue.updated"],
    ["issue_comment", "updated", { id: "c-human", issue: "iss-1", project: "p-qll", comment_html: "<p>human</p>" }, "comment.updated"],
  ] as const) {
    strictEqual(ruleEventsFor("plane", event, { action, data })[0]?.trigger, trigger);
  }
  await h.feed(planeJob("issue", { action: "updated", data: { id: "iss-1", project: "p-qll", name: "T" }, activity: { field: "name", new_value: "T" } }));
  await h.feed(planeJob("issue_comment", { action: "update", data: { id: "c-human", issue: "iss-1", project: "p-qll", comment_html: "<p>human</p>" }, activity: { field: "comment_html", new_value: "<p>human</p>" } }));
  strictEqual(comments(h).length, 2);
  deepStrictEqual((await h.audit("rule_match")).map((r) => [r.source, r.detail.trigger]), [["plane", "issue.updated"], ["plane", "comment.updated"]]);
});

test("F7 a new branch with a reference runs a saved push rule exactly once", async (t) => {
  const h = await makeHarness(); t.after(() => h.close());
  await h.mapping({ rules: commentRule("push"), smartCommits: false });
  await h.feed(ghJob("push", { ref: "refs/heads/octo/qll-1-login", created: true, commits: [] }));
  strictEqual(comments(h).length, 1, "branch rollups must not execute the same rule a second time");
  deepStrictEqual((await h.audit("rule_match")).map((r) => r.detail.trigger), ["push"]);
});

test("F7 a default-branch push executes both configured triggers in shared translator order", async (t) => {
  const h = await makeHarness(); t.after(() => h.close());
  await h.mapping({ rules: commentRule("push") + commentRule("commit.pushed_to_default"), smartCommits: false });
  await h.feed(ghJob("push", { ref: "refs/heads/main", repository: { ...REPO, default_branch: "main" }, commits: [{ id: sha("e"), message: "Fixes QLL-1" }] }));
  deepStrictEqual(comments(h).map((c) => c.body.comment_html), ["<p>rule:push</p>", "<p>rule:commit.pushed_to_default</p>"]);
  deepStrictEqual((await h.audit("rule_match")).map((r) => r.detail.trigger), ["push", "commit.pushed_to_default"]);
});
