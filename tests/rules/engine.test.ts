import test from "node:test";
import assert from "node:assert/strict";
import { parseRules, evaluate, run } from "../../src/rules/engine.ts";

test("parseRules successfully parses valid rules", () => {
  const rules = parseRules(`
- when: pull_request.opened
  if: { base_branch: "^main$" }
  then: [ { set_state: "Review" } ]
`);
  assert.equal(rules.length, 1);
});

test("parseRules fails on invalid YAML list", () => {
  assert.throws(() => parseRules(`{ a: 1 }`), /input is not a list/);
});

test("parseRules fails on unknown top-level keys", () => {
  assert.throws(() => parseRules(`
- when: push
  iff: { base_branch: "^main$" }
  then: [ { set_state: "Review" } ]
`), /unknown key iff/);
});

test("parseRules fails on invalid family members", () => {
  assert.throws(() => parseRules(`
- when: issue.Opened Now
  then: [ { set_state: "Review" } ]
`), /unknown trigger issue\.Opened Now/);
});

test("evaluate matches glob triggers", () => {
  const rules = parseRules(`
- when: check_suite.*
  then: [ { comment: "CI passed" } ]
`);
  const res = evaluate(rules, { trigger: "check_suite.completed" });
  assert.equal(res.matched?.index, 0);
  assert.equal(res.actions[0]!.type, "comment");
});

test("evaluate respects branch conditions", () => {
  const rules = parseRules(`
- when: push
  if: { head_branch: "^feat/" }
  then: [ { add_label: "feature" } ]
`);
  assert.equal(evaluate(rules, { trigger: "push", head_branch: "feat/123" }).matched?.index, 0);
  assert.equal(evaluate(rules, { trigger: "push", head_branch: "fix/123" }).matched, null);
});

test("evaluate resolves context in actions", () => {
  const rules = parseRules(`
- when: push
  then: [ { comment: "Commit: {{commit.sha}}" } ]
`);
  const res = evaluate(rules, { trigger: "push", context: { commit: { sha: "abc" } } });
  assert.equal((res.actions[0] as any).body, "Commit: abc");
});

test("run returns executed actions", async () => {
  const rules = parseRules(`
- when: push
  then: [ { set_state: "Done" } ]
`);
  const executed: string[] = [];
  const executor = {
    execute: async (action: any) => { executed.push(action.state); return Promise.resolve(); }
  };
  const res = await run(rules, { trigger: "push" }, executor, { dryRun: false });
  assert.deepEqual(executed, ["Done"]);
  assert.equal(res.executed.length, 1);
  assert.equal(res.dryRun, false);
});

test("evaluate respects labels_any", () => {
  const rules = parseRules(`
- when: push
  if: { labels_any: ["bug", "urgent"] }
  then: [ { add_label: "triage" } ]
`);
  assert.equal(evaluate(rules, { trigger: "push", labels: ["bug"] }).matched?.index, 0);
  assert.equal(evaluate(rules, { trigger: "push", labels: ["feature"] }).matched, null);
});

test("evaluate respects labels_all", () => {
  const rules = parseRules(`
- when: push
  if: { labels_all: ["bug", "urgent"] }
  then: [ { add_label: "triage" } ]
`);
  assert.equal(evaluate(rules, { trigger: "push", labels: ["bug"] }).matched, null);
  assert.equal(evaluate(rules, { trigger: "push", labels: ["bug", "urgent", "x"] }).matched?.index, 0);
});

test("evaluate respects author", () => {
  const rules = parseRules(`
- when: push
  if: { author: ["alice", "bob"] }
  then: [ { set_state: "Done" } ]
`);
  assert.equal(evaluate(rules, { trigger: "push", author: "Bob" }).matched?.index, 0);
  assert.equal(evaluate(rules, { trigger: "push", author: "Charlie" }).matched, null);
});

test("evaluate respects repo", () => {
  const rules = parseRules(`
- when: push
  if: { repo: "my/repo" }
  then: [ { set_state: "Done" } ]
`);
  assert.equal(evaluate(rules, { trigger: "push", repo: "MY/REPO" }).matched?.index, 0);
  assert.equal(evaluate(rules, { trigger: "push", repo: "other/repo" }).matched, null);
});

test("evaluate respects project", () => {
  const rules = parseRules(`
- when: push
  if: { project: "PROJ1" }
  then: [ { set_state: "Done" } ]
`);
  assert.equal(evaluate(rules, { trigger: "push", project: "PROJ1" }).matched?.index, 0);
  assert.equal(evaluate(rules, { trigger: "push", project: "proj1" }).matched, null); // project is exact
});

test("evaluate ignores unmatched triggers", () => {
  const rules = parseRules(`
- when: push
  then: [ { set_state: "Done" } ]
`);
  assert.equal(evaluate(rules, { trigger: "pull_request.opened" }).matched, null);
});

test("evaluate picks first matching rule", () => {
  const rules = parseRules(`
- when: push
  if: { author: "alice" }
  then: [ { add_label: "first" } ]
- when: push
  then: [ { add_label: "second" } ]
`);
  const res1 = evaluate(rules, { trigger: "push", author: "alice" });
  assert.equal(res1.matched?.index, 0);
  assert.equal((res1.actions[0] as any).label, "first");

  const res2 = evaluate(rules, { trigger: "push", author: "bob" });
  assert.equal(res2.matched?.index, 1);
  assert.equal((res2.actions[0] as any).label, "second");
});

test("run propagates executor error", async () => {
  const rules = parseRules(`
- when: push
  then: [ { set_state: "Done" } ]
`);
  const executor = {
    execute: async () => { throw new Error("executor fail"); }
  };
  await assert.rejects(run(rules, { trigger: "push" }, executor, { dryRun: false }), /executor fail/);
});

test("run in dryRun mode does not execute", async () => {
  const rules = parseRules(`
- when: push
  then: [ { set_state: "Done" } ]
`);
  let called = false;
  const executor = {
    execute: async () => { called = true; return Promise.resolve(); }
  };
  const res = await run(rules, { trigger: "push" }, executor, { dryRun: true });
  assert.equal(called, false);
  assert.equal(res.dryRun, true);
  assert.deepEqual(res.executed, []);
});

test("templates handle nested context", () => {
  const rules = parseRules(`
- when: push
  then: [ { comment: "nested {{user.details.name}}" } ]
`);
  const res = evaluate(rules, { trigger: "push", context: { user: { details: { name: "alice" } } } });
  assert.equal((res.actions[0] as any).body, "nested alice");
});

test("templates throw on missing context field", () => {
  const rules = parseRules(`
- when: push
  then: [ { comment: "nested {{user.name}}" } ]
`);
  assert.throws(() => evaluate(rules, { trigger: "push", context: {} }), /Cannot resolve/);
});

test("evaluate works with all action types", () => {
  const rules = parseRules(`
- when: push
  then:
    - set_state: "a"
    - add_label: "b"
    - remove_label: "c"
    - assign: "d"
    - comment: "e"
    - log_time: "f"
    - add_link: { url: "g", title: "h" }
    - create_issue: { project: "i", title: "j" }
`);
  const res = evaluate(rules, { trigger: "push" });
  assert.equal(res.actions.length, 8);
});

test("branch.created is an exact trigger; other branch.* words and globs stay unknown", () => {
  const rules = parseRules(`
- when: branch.created
  if: { head_branch: "^feat/" }
  then: [ { set_state: "In Progress" } ]
`);
  assert.equal(evaluate(rules, { trigger: "branch.created", head_branch: "feat/x" }).matched?.index, 0);
  assert.equal(evaluate(rules, { trigger: "push", head_branch: "feat/x" }).matched, null);
  for (const t of ["branch.deleted", "branch.*", "branch.created.now"]) {
    assert.throws(() => parseRules(`\n- when: ${t}\n  then: [ { set_state: "Review" } ]\n`), /unknown trigger/, t);
  }
});
