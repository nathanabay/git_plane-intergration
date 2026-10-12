import test from "node:test";
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { compileLifecycleRules, QLL_DEFAULTS } from "../../src/github/pr-automation.ts";
import { ruleEventsFor } from "../../src/app/rule-events.ts";
import { dryRun, toRuleEvents } from "../../src/operations/tooling.ts";
import type { AppContext } from "../../src/app/context.ts";
import { inboundHandler } from "../../src/app/reducers.ts";
import { deliveryScope } from "../../src/app/writers.ts";
import { EventRouter } from "../../src/sync/router.ts";
import { ghJob, makeHarness, planeJob, REPO, sha } from "./harness.ts";

const repo = { ...REPO, default_branch: "main" };
const patches = (h: Awaited<ReturnType<typeof makeHarness>>) => h.plane.writes().filter((w) => w.method === "PATCH" && !/\/links\//.test(w.path));
const pr = (number: number, ref: string, repoId = 555) => ({ number, head: { ref, repo: { id: repoId, full_name: repoId === 555 ? "acme/web" : "fork/web" } } });

test("F6 inbound scope correlates Plane-origin writes to their declared workspace", async () => {
  const router = new EventRouter();
  const scopes: unknown[] = [];
  for (const source of ["plane", "github"] as const) router.on(source, "scope", async () => { scopes.push(deliveryScope.getStore()); });
  const ctx = {} as AppContext; // The registered reducer only observes scope; it performs no database or network calls.
  const plane = inboundHandler(ctx, router, "plane");
  await plane(planeJob("scope", { workspace_slug: "ws" }, "scope-plane"));
  await plane(planeJob("scope", { workspace_slug: undefined, workspace_id: "workspace-uuid" }, "scope-uuid"));
  await inboundHandler(ctx, router, "github")(ghJob("scope", { workspace_slug: "spoofed" }, "scope-github"));
  deepStrictEqual(scopes, [
    // transportDeliveryId lets the outbox tell an explicit replay (which carries its own writeDeliveryId) from a redelivery.
    { deliveryId: "plane-scope-plane", seq: 0, transportDeliveryId: "scope-plane", workspaceSlug: "ws" },
    { deliveryId: "plane-scope-uuid", seq: 0, transportDeliveryId: "scope-uuid" },
    { deliveryId: "github-scope-github", seq: 0, transportDeliveryId: "scope-github" },
  ]);
  strictEqual(deliveryScope.getStore(), undefined, "delivery scope must not leak into the next job");
});

test("F7 GitHub status routes through the live inbound handler and fires readiness only after success", async (t) => {
  const h = await makeHarness(); t.after(() => h.close());
  await h.mapping({ smartCommits: false, rules: "- when: pull_request.ready_for_merge\n  then: [{ comment: ready }]\n" });
  await h.link("iss-1", 12, { kind: "pr" });
  const head = sha("a");
  h.gh.respond(/commits\/\{commit_sha\}\/pulls$/, () => [{ ...pr(12, "topic"), state: "open", draft: false, merged: false, head: { ...pr(12, "topic").head, sha: head } }]);
  h.gh.respond(/pulls\/\{pull_number\}\/reviews$/, () => [{ state: "APPROVED", user: { login: "reviewer", id: 9 } }]);
  h.gh.respond(/commits\/\{ref\}\/check-suites$/, () => ({ check_suites: [{ status: "completed", conclusion: "success" }] }));
  await h.feed(ghJob("status", { repository: repo, sha: head, state: "failure" }));
  strictEqual(h.plane.writes().length, 0);
  strictEqual(h.gh.calls.filter((c) => /commits\/\{commit_sha\}\/pulls$/.test(c.route)).length, 0);
  await h.feed(ghJob("status", { repository: repo, sha: head, state: "success" }));
  deepStrictEqual(h.plane.writes().filter((w) => /\/comments\/$/.test(w.path)).map((w) => w.path), ["/workspaces/ws/projects/p-qll/issues/iss-1/comments/"]);
  deepStrictEqual((await h.audit("rule_match")).map((r) => r.detail.trigger), ["pull_request.ready_for_merge"]);
  strictEqual((await h.audit("ready_for_merge")).length, 1);
  strictEqual((await h.audit("inbound")).filter((r) => r.outcome === "unhandled").length, 0);
  await h.feed(ghJob("status", { repository: repo, sha: head, state: "success" }));
  strictEqual(h.plane.writes().filter((w) => /\/comments\/$/.test(w.path)).length, 1, "another status delivery for this head cannot fire readiness twice");
});

for (const commits of [[], [{ id: sha("a"), message: "ordinary initial commit" }]]) {
  test(`F4 first push with ${commits.length} commits cannot reopen the base tip's merged PR item`, async (t) => {
    const h = await makeHarness(); t.after(() => h.close());
    await h.mapping({ smartCommits: false });
    await h.link("iss-1", 12, { kind: "pr" });
    h.gh.respond(/commits\/\{commit_sha\}\/pulls$/, () => [pr(12, "finished-feature")]);
    await h.feed(ghJob("push", { repository: repo, created: true, before: sha("0"), ref: "refs/heads/unrelated-work", after: sha("a"), head_commit: { id: sha("a") }, commits }));
    deepStrictEqual(patches(h), []);
    strictEqual((await h.audit("rule_match")).length, 0);
    strictEqual(h.gh.calls.filter((c) => /commits\/\{commit_sha\}\/pulls$/.test(c.route)).length, 0, "a first push does not inherit PR associations from its base");
  });
}

test("F4 later push association requires this branch and this repository, and ignores the tip outside introduced commits", async (t) => {
  const h = await makeHarness(); t.after(() => h.close());
  await h.mapping({ smartCommits: false, rules: "- when: push\n  then: [{ comment: association }]\n" });
  for (const n of [12, 13, 14, 15, 16]) await h.link(`item-${n}`, n, { kind: "pr" });
  h.gh.respond(/commits\/\{commit_sha\}\/pulls$/, (p) => p.commit_sha === sha("b") ? [pr(12, "other"), pr(13, "topic", 999), pr(14, "topic"), { number: 16, head: { ref: "topic" } }] : [pr(15, "topic")]);
  await h.feed(ghJob("push", { repository: repo, ref: "refs/heads/topic", created: false, before: sha("a"), after: sha("c"), head_commit: { id: sha("c") }, commits: [{ id: sha("b"), message: "ordinary new commit" }] }));
  deepStrictEqual(h.plane.writes().filter((w) => /\/comments\/$/.test(w.path)).map((w) => w.path), ["/workspaces/ws/projects/p-qll/issues/item-14/comments/"]);
  deepStrictEqual(h.gh.calls.filter((c) => /commits\/\{commit_sha\}\/pulls$/.test(c.route)).map((c) => c.params.commit_sha), [sha("b")]);
});

for (const saved of [false, true]) {
  for (const kind of ["first-topic", "later-topic", "main", "first-main"] as const) {
    test(`F5 ${saved ? "saved" : "unsaved"} lifecycle defaults: ${kind}`, async (t) => {
      const h = await makeHarness(); t.after(() => h.close());
      await h.mapping({ smartCommits: false, ...(saved ? { rules: compileLifecycleRules(QLL_DEFAULTS) } : {}) });
      const first = kind.startsWith("first-");
      const branch = kind.includes("main") ? "main" : "octo/qll-1-login";
      const payload = { repository: repo, created: first, before: first ? sha("0") : sha("a"), ref: `refs/heads/${branch}`, commits: [{ id: sha("d"), message: "Fixes QLL-1" }] };
      await h.feed(ghJob("push", payload));
      const simulation = await dryRun({ rulesYaml: compileLifecycleRules(QLL_DEFAULTS), event: "push", payload });
      deepStrictEqual(simulation.actions, kind === "first-topic" ? [{ type: "set_state", state: "started:In Progress" }] : []);
      deepStrictEqual(patches(h).map((w) => w.body), kind === "first-topic" ? [{ state: "s-prog" }] : []);
      deepStrictEqual((await h.audit("rule_match")).map((r) => r.detail.trigger), kind === "first-topic" ? ["branch.created"] : []);
    });
  }
}

test("F5 branch-created translation is shared with dry-run and general push stays available", () => {
  const p = { repository: repo, created: true, before: sha("0"), ref: "refs/heads/topic", commits: [] };
  deepStrictEqual(ruleEventsFor("github", "push", p).map((e) => e.trigger), ["push", "branch.created"]);
  deepStrictEqual(toRuleEvents("push", p), ruleEventsFor("github", "push", p));
  for (const over of [{ created: false, before: sha("a") }, { deleted: true }, { ref: "refs/heads/main" }, { ref: "refs/tags/v1" }]) {
    strictEqual(ruleEventsFor("github", "push", { ...p, ...over }).some((e) => e.trigger === "branch.created"), false);
  }
});

for (const conclusion of ["success", "failure"]) {
  test(`F10 a check_run.${conclusion} never translates to check_suite automation`, () => {
    const p = { repository: repo, action: "completed", check_run: { conclusion, head_sha: sha("e"), check_suite: { id: 500 }, pull_requests: [pr(12, "topic")] } };
    deepStrictEqual(ruleEventsFor("github", "check_run", p), []);
    deepStrictEqual(toRuleEvents("check_run", p), []);
  });
}

test("F10 live run completions keep CI rollups, but only a completed suite runs the suite rule", async (t) => {
  const h = await makeHarness(); t.after(() => h.close());
  await h.mapping({ rules: "- when: check_suite.*\n  then: [{ comment: suite-only }]\n" });
  await h.link("iss-1", 12, { kind: "pr" });
  h.gh.respond(/check-runs$/, () => ({ check_runs: [{ conclusion: "success" }, { conclusion: "failure" }] }));
  const subject = { head_sha: sha("f"), head_branch: "topic", pull_requests: [pr(12, "topic")] };
  for (const conclusion of ["success", "failure"]) await h.feed(ghJob("check_run", { action: "completed", check_run: { ...subject, conclusion } }));
  strictEqual(h.plane.writes().filter((w) => /\/comments\/$/.test(w.path)).length, 0);
  strictEqual((await h.audit("rule_match")).length, 0);
  strictEqual(h.plane.writes().filter((w) => /\/links(?:\/[^/]+)?\/$/.test(w.path)).length, 2, "individual check runs still refresh CI rollups");
  await h.feed(ghJob("check_suite", { action: "completed", check_suite: { ...subject, conclusion: "failure" } }));
  strictEqual(h.plane.writes().filter((w) => /\/comments\/$/.test(w.path)).length, 1);
  deepStrictEqual((await h.audit("rule_match")).map((r) => r.detail.trigger), ["check_suite.failure"]);
});

test("F4 default-branch push targets introduced commit references only, even for a PR headed by main", async (t) => {
  const h = await makeHarness(); t.after(() => h.close());
  await h.mapping({ smartCommits: false, rules: "- when: [push, commit.pushed_to_default]\n  then: [{ comment: introduced }]\n" });
  await h.link("iss-1", 12, { kind: "pr" });
  h.gh.respond(/commits\/\{commit_sha\}\/pulls$/, () => [pr(12, "main")]);
  await h.feed(ghJob("push", { repository: repo, ref: "refs/heads/main", created: false, before: sha("a"), after: sha("b"), head_commit: { id: sha("b") }, commits: [{ id: sha("b"), message: "Fixes QLL-2" }] }));
  deepStrictEqual(h.plane.writes().filter((w) => /\/comments\/$/.test(w.path)).map((w) => w.path), ["/workspaces/ws/projects/p-qll/issues/iss-2/comments/", "/workspaces/ws/projects/p-qll/issues/iss-2/comments/"]);
  strictEqual(h.gh.calls.filter((c) => /commits\/\{commit_sha\}\/pulls$/.test(c.route)).length, 0);
});

test("F4 an explicit first-push rule can target an introduced commit reference without inheriting associated PR items", async (t) => {
  const h = await makeHarness(); t.after(() => h.close());
  await h.mapping({ smartCommits: false, rules: "- when: push\n  then: [{ set_state: started }]\n" });
  await h.link("iss-1", 12, { kind: "pr" });
  h.gh.respond(/commits\/\{commit_sha\}\/pulls$/, () => [pr(12, "topic")]);
  await h.feed(ghJob("push", { repository: repo, ref: "refs/heads/topic", created: true, before: sha("0"), after: sha("b"), commits: [{ id: sha("b"), message: "Fixes QLL-2" }] }));
  deepStrictEqual(patches(h).map((w) => [w.path, w.body]), [["/workspaces/ws/projects/p-qll/issues/iss-2/", { state: "s-prog" }]]);
  strictEqual(h.gh.calls.filter((c) => /commits\/\{commit_sha\}\/pulls$/.test(c.route)).length, 0);
});

test("F4 default-branch names containing a key do not supply targets without introduced commit references", async (t) => {
  const h = await makeHarness(); t.after(() => h.close());
  await h.mapping({ smartCommits: false, rules: "- when: commit.pushed_to_default\n  then: [{ comment: default }]\n" });
  await h.feed(ghJob("push", { repository: { ...repo, default_branch: "release/qll-1" }, ref: "refs/heads/release/qll-1", created: false, commits: [{ id: sha("a"), message: "ordinary" }] }));
  deepStrictEqual(h.plane.writes(), []);
});

test("F5 a zero before SHA qualifies, but missing default metadata and empty branches do not", () => {
  const p = { repository: repo, ref: "refs/heads/topic", before: sha("0"), commits: [] };
  strictEqual(ruleEventsFor("github", "push", p).some((e) => e.trigger === "branch.created"), true);
  for (const over of [{ repository: REPO, ref: "refs/heads/" }, { repository: { id: 555 } }, { repository: { ...repo, default_branch: "" } }]) {
    strictEqual(ruleEventsFor("github", "push", { ...p, ...over }).some((e) => e.trigger === "branch.created"), false);
  }
});
