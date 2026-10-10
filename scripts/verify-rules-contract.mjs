#!/usr/bin/env node
// Oracle for task A6 (spec §7.5, §7.1). Driver-held fixtures exercising the rule engine's public
// contract, independent of the leaf's own tests.
import { resolve, join } from "node:path";
import { deepStrictEqual, strictEqual, ok, throws, rejects } from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const results = [];
async function check(name, fn) {
  try { await fn(); results.push([name, null]); } catch (e) { results.push([name, e]); }
}

const eng = await import(join(root, "src/rules/engine.ts"));
const { parseRules, evaluate, run } = eng;

const SPEC_EXAMPLE = `
- when: pull_request.merged
  if:   { base_branch: "^main$", labels_any: ["hotfix"] }
  then:
    - set_state: Deployed
    - add_label: shipped
    - comment: "Deployed via {{pr.url}}"
`;
const merged = (o = {}) => ({ trigger: "pull_request.merged", repo: "acme/web", base_branch: "main", head_branch: "fix/x", labels: ["hotfix"], author: "octo", project: "QLL", context: { pr: { url: "https://github.com/acme/web/pull/7" } }, ...o });

await check("spec §7.5 example parses and evaluates to its three actions in order", () => {
  const rules = parseRules(SPEC_EXAMPLE);
  strictEqual(rules.length, 1);
  const ev = evaluate(rules, merged());
  strictEqual(ev.matched?.index, 0);
  deepStrictEqual(ev.actions, [
    { type: "set_state", state: "Deployed" },
    { type: "add_label", label: "shipped" },
    { type: "comment", body: "Deployed via https://github.com/acme/web/pull/7" },
  ]);
});

await check("base_branch is an anchored regex against the PR base branch", () => {
  const rules = parseRules(SPEC_EXAMPLE);
  strictEqual(evaluate(rules, merged({ base_branch: "main2" })).matched, null);
  strictEqual(evaluate(rules, merged({ base_branch: undefined })).matched, null);
  deepStrictEqual(evaluate(rules, merged({ base_branch: "main2" })).actions, []);
});

await check("labels_any fails when no label matches; labels_all needs every label", () => {
  const rules = parseRules(SPEC_EXAMPLE);
  strictEqual(evaluate(rules, merged({ labels: ["feature"] })).matched, null);
  const all = parseRules(`- when: pull_request.opened\n  if: { labels_all: [a, b] }\n  then: [ { add_label: c } ]\n`);
  strictEqual(evaluate(all, { trigger: "pull_request.opened", labels: ["a"] }).matched, null);
  strictEqual(evaluate(all, { trigger: "pull_request.opened", labels: ["b", "a", "z"] }).matched?.index, 0);
});

await check("first match wins: a later matching rule contributes nothing", () => {
  const rules = parseRules(`
- when: pull_request.merged
  if: { base_branch: "^staging$" }
  then: [ { set_state: In QA } ]
- when: pull_request.merged
  then: [ { set_state: Done } ]
- when: pull_request.merged
  then: [ { set_state: Never } ]
`);
  const staging = evaluate(rules, merged({ base_branch: "staging" }));
  strictEqual(staging.matched?.index, 0);
  deepStrictEqual(staging.actions, [{ type: "set_state", state: "In QA" }]);
  const main = evaluate(rules, merged());
  strictEqual(main.matched?.index, 1);
  deepStrictEqual(main.actions, [{ type: "set_state", state: "Done" }]);
});

await check("family glob triggers match their family only; `when` may be a list", () => {
  const rules = parseRules(`
- when: check_suite.*
  then: [ { comment: "ci" } ]
- when: [ deployment_status.success, push ]
  then: [ { comment: "dep-or-push" } ]
`);
  strictEqual(evaluate(rules, { trigger: "check_suite.completed" }).matched?.index, 0);
  strictEqual(evaluate(rules, { trigger: "check_suite_x.completed" }).matched, null);
  strictEqual(evaluate(rules, { trigger: "deployment_status.success" }).matched?.index, 1);
  strictEqual(evaluate(rules, { trigger: "push" }).matched?.index, 1);
  strictEqual(evaluate(rules, { trigger: "deployment_status.failure" }).matched, null);
});

await check("every §7.1 lifecycle trigger and every §7.5 trigger family is accepted", () => {
  const triggers = ["drafted", "opened", "review_requested", "changes_requested", "approved", "ready_for_merge", "merged", "closed_unmerged", "reopened"]
    .map((t) => `pull_request.${t}`)
    .concat(["push", "commit.pushed_to_default", "check_suite.*", "deployment_status.*", "issue.*", "comment.*"]);
  for (const t of triggers) parseRules(`- when: ${t}\n  then: [ { comment: x } ]\n`);
});

await check("all eight §7.5 action kinds parse to typed actions", () => {
  const rules = parseRules(`
- when: issue.opened
  then:
    - set_state: In Progress
    - add_label: a
    - remove_label: b
    - assign: octo
    - comment: hello
    - add_link: { url: "https://example.com/x", title: "X" }
    - log_time: "1w 2d 4h 30m"
    - create_issue: { project: QLL, title: "From PR" }
`);
  deepStrictEqual(evaluate(rules, { trigger: "issue.opened" }).actions, [
    { type: "set_state", state: "In Progress" },
    { type: "add_label", label: "a" },
    { type: "remove_label", label: "b" },
    { type: "assign", assignee: "octo" },
    { type: "comment", body: "hello" },
    { type: "add_link", url: "https://example.com/x", title: "X" },
    { type: "log_time", duration: "1w 2d 4h 30m" },
    { type: "create_issue", project: "QLL", title: "From PR" },
  ]);
});

await check("author, repo and project conditions; author and repo are case-insensitive", () => {
  const rules = parseRules(`
- when: push
  if: { author: [Octo, hubot], repo: ACME/Web, project: QLL }
  then: [ { comment: hit } ]
`);
  strictEqual(evaluate(rules, { trigger: "push", author: "octo", repo: "acme/web", project: "QLL" }).matched?.index, 0);
  strictEqual(evaluate(rules, { trigger: "push", author: "someone", repo: "acme/web", project: "QLL" }).matched, null);
  strictEqual(evaluate(rules, { trigger: "push", author: "octo", repo: "acme/api", project: "QLL" }).matched, null);
  strictEqual(evaluate(rules, { trigger: "push", author: "octo", repo: "acme/web", project: "DSAFDSF" }).matched, null);
});

await check("head_branch regex condition", () => {
  const rules = parseRules(`- when: pull_request.opened\n  if: { head_branch: "^feature/" }\n  then: [ { add_label: feat } ]\n`);
  strictEqual(evaluate(rules, { trigger: "pull_request.opened", head_branch: "feature/abc" }).matched?.index, 0);
  strictEqual(evaluate(rules, { trigger: "pull_request.opened", head_branch: "bugfix/abc" }).matched, null);
});

await check("invalid rule sets fail loudly at parse time", () => {
  const bad = {
    unknownAction: `- when: push\n  then: [ { explode: now } ]\n`,
    unknownCondition: `- when: push\n  if: { colour: red }\n  then: [ { comment: x } ]\n`,
    unknownTrigger: `- when: pull_request.teleported\n  then: [ { comment: x } ]\n`,
    unknownFamily: `- when: wiki.*\n  then: [ { comment: x } ]\n`,
    badRegex: `- when: push\n  if: { base_branch: "([" }\n  then: [ { comment: x } ]\n`,
    emptyThen: `- when: push\n  then: []\n`,
    missingWhen: `- then: [ { comment: x } ]\n`,
    notAList: `when: push\nthen: [ { comment: x } ]\n`,
    twoKeyAction: `- when: push\n  then: [ { comment: x, add_label: y } ]\n`,
    misspelledIf: `- when: push\n  iff: { base_branch: "^main$" }\n  then: [ { comment: x } ]\n`,
    unknownRuleKey: `- when: push\n  unless: { labels_any: [x] }\n  then: [ { comment: x } ]\n`,
    nonStringName: `- name: { a: 1 }\n  when: push\n  then: [ { comment: x } ]\n`,
    emptyFamilyMember: `- when: "issue."\n  then: [ { comment: x } ]\n`,
    junkFamilyMember: `- when: "issue.Opened Now"\n  then: [ { comment: x } ]\n`,
  };
  for (const [k, src] of Object.entries(bad)) throws(() => parseRules(src), Error, `parseRules accepted ${k}`);
});

await check("an unresolved template variable is a loud error, not an empty string", () => {
  const rules = parseRules(SPEC_EXAMPLE);
  throws(() => evaluate(rules, merged({ context: {} })), Error);
});

await check("evaluate is pure: rules are not mutated", () => {
  const rules = parseRules(SPEC_EXAMPLE);
  const before = JSON.stringify(rules);
  evaluate(rules, merged()); evaluate(rules, merged({ base_branch: "x" }));
  strictEqual(JSON.stringify(rules), before);
});

await check("dry-run executes nothing; apply executes matched actions in order", async () => {
  const rules = parseRules(SPEC_EXAMPLE);
  const calls = [];
  const executor = { execute: async (a) => { calls.push(a.type); return true; } };
  const dry = await run(rules, merged(), executor, { dryRun: true });
  deepStrictEqual(calls, []);
  strictEqual(dry.dryRun, true);
  deepStrictEqual(dry.executed, []);
  strictEqual(dry.evaluation.actions.length, 3);
  const live = await run(rules, merged(), executor, { dryRun: false });
  deepStrictEqual(calls, ["set_state", "add_label", "comment"]);
  strictEqual(live.executed.length, 3);
});

await check("an executor failure surfaces instead of being swallowed", async () => {
  const rules = parseRules(SPEC_EXAMPLE);
  await rejects(run(rules, merged(), { execute: async () => { throw new Error("boom"); } }, { dryRun: false }));
});

let bad = 0;
for (const [name, err] of results) {
  if (err) { bad++; console.error(`FAIL: ${name}: ${err.message.split("\n")[0]}`); } else console.log(`ok   ${name}`);
}
if (bad) process.exit(1);
console.log(`rules contract verification passed (${results.length} checks)`);
