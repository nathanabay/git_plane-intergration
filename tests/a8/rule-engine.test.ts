// Fixture-driven reducer tests (spec §10): recorded-shape pull request payloads through the composed
// reducers, asserting the exact outbound Plane and GitHub calls.
import test from "node:test";
import { strictEqual, deepStrictEqual, ok } from "node:assert/strict";
import { ghJob, makeHarness, prPayload } from "./harness.ts";

type H = Awaited<ReturnType<typeof makeHarness>>;
const states = (h: H) => h.plane.writes().filter((c) => c.method === "PATCH" && c.body && "state" in c.body).map((c) => c.body.state);
const pr = (action: string, pull: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ghJob("pull_request", prPayload(action, extra, pull));
const prWith = (body: string) => ({ body });

async function setup() { const h = await makeHarness(); await h.mapping(); return h; }

test("opened with `Fixes QLL-1` links the item at tier closing and moves it to In Progress", async () => {
  const h = await setup();
  await h.feed(pr("opened", prWith("Fixes QLL-1")));
  deepStrictEqual(states(h), ["s-prog"]);
  const link = (await h.db.query<any>("SELECT tier, created_by, gh_kind FROM sync_links WHERE plane_issue_id = 'iss-1'")).rows[0];
  deepStrictEqual({ ...link }, { tier: "closing", created_by: "magic_word", gh_kind: "pr" });
  await h.close();
});

test("a key in the branch name links with created_by `branch`", async () => {
  const h = await setup();
  await h.feed(pr("opened", { head: { ref: "octo/qll-1-login" } }));
  strictEqual((await h.db.query<any>("SELECT created_by FROM sync_links")).rows[0].created_by, "branch");
  deepStrictEqual(states(h), ["s-prog"]);
  await h.close();
});

test("a draft PR is `drafted`: In Progress", async () => {
  const h = await setup();
  await h.feed(pr("opened", { draft: true, body: "Fixes QLL-1" }));
  deepStrictEqual(states(h), ["s-prog"]);
  await h.close();
});

test("review requested moves the item to In Review", async () => {
  const h = await setup();
  await h.feed(pr("review_requested", prWith("Fixes QLL-1")));
  deepStrictEqual(states(h), ["s-review"]);
  await h.close();
});

test("merged into main moves a closing item to Done", async () => {
  const h = await setup();
  await h.feed(pr("closed", { merged: true, state: "closed", body: "Fixes QLL-1" }));
  deepStrictEqual(states(h), ["s-done"]);
  await h.close();
});

test("merged into another base branch changes nothing", async () => {
  const h = await setup();
  await h.feed(pr("closed", { merged: true, state: "closed", body: "Fixes QLL-1", base: { ref: "develop" } }));
  deepStrictEqual(states(h), []);
  await h.close();
});

test("closed without merging, and approvals, change no state (§7.1 defaults)", async () => {
  const h = await setup();
  await h.feed(pr("closed", { state: "closed", body: "Fixes QLL-1" }));
  await h.feed(ghJob("pull_request_review", { ...prPayload("submitted", {}, { body: "Fixes QLL-1" }), review: { state: "approved", user: { login: "rev" } } }));
  deepStrictEqual(states(h), []);
  await h.close();
});

test("a non-closing link advances through the workflow but never takes the merge state", async () => {
  const h = await setup();
  await h.feed(pr("opened", prWith("Part of QLL-1")));
  await h.feed(pr("closed", { merged: true, state: "closed", body: "Part of QLL-1" }));
  deepStrictEqual(states(h), ["s-prog"]);
  await h.close();
});

test("a relation link is recorded and shown but never changes state", async () => {
  const h = await setup();
  await h.feed(pr("opened", prWith("Relates to QLL-1")));
  deepStrictEqual(states(h), []);
  strictEqual((await h.db.query<any>("SELECT tier FROM sync_links")).rows[0].tier, "relation");
  ok(h.plane.writes().some((c) => /\/links\/$/.test(c.path)), "the rollup link is still added");
  await h.close();
});

test("all linked PRs must merge: the item stays put while another linked PR is open", async () => {
  const h = await setup();
  await h.link("iss-1", 13, { kind: "pr", tier: "closing", project: "p-qll" });
  h.gh.respond(/GET \/repos\/\{owner\}\/\{repo\}\/pulls\/\{pull_number\}$/, () => ({ state: "open", merged: false }));
  await h.feed(pr("closed", { merged: true, state: "closed", body: "Fixes QLL-1" }));
  deepStrictEqual(states(h), []);
  await h.close();
});

test("once the other linked PR has merged too, the item takes the merge state", async () => {
  const h = await setup();
  await h.link("iss-1", 13, { kind: "pr", tier: "closing", project: "p-qll" });
  h.gh.respond(/GET \/repos\/\{owner\}\/\{repo\}\/pulls\/\{pull_number\}$/, () => ({ state: "closed", merged: true }));
  await h.feed(pr("closed", { merged: true, state: "closed", body: "Fixes QLL-1" }));
  deepStrictEqual(states(h), ["s-done"]);
  await h.close();
});

test("a PR closed unmerged beside the merged one does not block the item", async () => {
  const h = await setup();
  await h.link("iss-1", 13, { kind: "pr", tier: "closing", project: "p-qll" });
  h.gh.respond(/GET \/repos\/\{owner\}\/\{repo\}\/pulls\/\{pull_number\}$/, () => ({ state: "closed", merged: false }));
  await h.feed(pr("closed", { merged: true, state: "closed", body: "Fixes QLL-1" }));
  deepStrictEqual(states(h), ["s-done"]);
  await h.close();
});

test("`skip QLL-1` in the body opts the item out entirely", async () => {
  const h = await setup();
  await h.feed(pr("opened", { head: { ref: "octo/qll-1-x" }, body: "Fixes QLL-1\nskip QLL-1" }));
  strictEqual(h.plane.writes().length, 0);
  strictEqual((await h.db.query("SELECT 1 FROM sync_links")).rows.length, 0);
  await h.close();
});

test("an identifier Plane does not know is audited and writes nothing", async () => {
  const h = await setup();
  await h.feed(pr("opened", prWith("Fixes QLL-404")));
  strictEqual(h.plane.writes().length, 0);
  deepStrictEqual((await h.audit("reference_unresolved"))[0]!.detail.identifiers, ["QLL-404"]);
  await h.close();
});

test("a repository with no mapping is skipped with an audit row", async () => {
  const h = await makeHarness();
  await h.feed(pr("opened", prWith("Fixes QLL-1")));
  strictEqual(h.plane.calls.length, 0);
  strictEqual((await h.audit("pull_request"))[0]!.outcome, "unmapped_repo");
  await h.close();
});

test("a saved rule set replaces the defaults for its mapping", async () => {
  const h = await makeHarness();
  await h.mapping({ rules: "- name: custom\n  when: pull_request.opened\n  then:\n    - set_state: unstarted:Todo\n    - comment: PR opened\n" });
  await h.feed(pr("opened", prWith("Fixes QLL-1")));
  deepStrictEqual(states(h), ["s-todo"]);
  ok(h.plane.writes().some((c) => /\/comments\/$/.test(c.path) && JSON.stringify(c.body).includes("PR opened")));
  await h.close();
});

test("a rule that names a state the project lacks is audited as failed, not retried forever", async () => {
  const h = await makeHarness();
  await h.mapping({ rules: "- when: pull_request.opened\n  then:\n    - set_state: Nonexistent\n" });
  strictEqual(await h.feed(pr("opened", prWith("Fixes QLL-1"))), "handled");
  const [row] = await h.audit("rule_match");
  strictEqual(row!.outcome, "failed");
  ok(/does not exist/.test(row!.error));
  await h.close();
});

test("the rule match itself is audited with its actions", async () => {
  const h = await setup();
  await h.feed(pr("opened", prWith("Fixes QLL-1")));
  const [row] = await h.audit("rule_match");
  strictEqual(row!.outcome, "applied");
  deepStrictEqual(row!.detail.actions, [{ type: "set_state", state: "started:In Progress" }]);
  await h.close();
});

test("the PR rollup link is added once, then edited in place with the new status", async () => {
  const h = await setup();
  await h.feed(pr("opened", prWith("Fixes QLL-1")));
  const added = h.plane.writes().find((c) => c.method === "POST" && /\/links\/$/.test(c.path));
  strictEqual(added!.body.title, "[PR] #12 Fix login · OPEN · REVIEW");
  await h.feed(pr("closed", { merged: true, state: "closed", body: "Fixes QLL-1" }));
  const patch = h.plane.writes().find((c) => c.method === "PATCH" && /\/links\//.test(c.path));
  ok(patch, "link was not updated in place");
  strictEqual(patch!.body.title, "[PR] #12 Fix login · MERGED");
  strictEqual(h.plane.writes().filter((c) => c.method === "POST" && /\/links\/$/.test(c.path)).length, 1);
  await h.close();
});

test("an approving review turns an open PR's rollup into APPROVAL", async () => {
  const h = await setup();
  h.gh.respond(/GET \/repos\/\{owner\}\/\{repo\}\/pulls\/\{pull_number\}\/reviews$/, () => [{ state: "APPROVED", user: { login: "rev" } }]);
  await h.feed(pr("opened", prWith("Fixes QLL-1")));
  strictEqual(h.plane.writes().find((c) => /\/links\/$/.test(c.path))!.body.title, "[PR] #12 Fix login · OPEN · APPROVAL");
  await h.close();
});

test("`QLL-NEW` creates a work item in that project, links it and starts it", async () => {
  const h = await setup();
  await h.feed(pr("opened", { body: "QLL-NEW" }));
  const created = h.plane.writes().find((c) => c.method === "POST" && /\/projects\/p-qll\/issues\/$/.test(c.path));
  deepStrictEqual(created!.body, { name: "Fix login", state: "s-prog" });
  strictEqual((await h.db.query("SELECT 1 FROM sync_links WHERE plane_issue_id = $1", [h.plane.createdIssueIds[0]])).rows.length, 1);
  await h.feed(pr("edited", { body: "QLL-NEW" }));
  strictEqual(h.plane.createdIssueIds.length, 1, "an edit must not create a second item");
  await h.close();
});

test("linkback: a comment on the PR names the item once, only when the toggle is on", async () => {
  const h = await makeHarness();
  await h.mapping({ linkback: true });
  await h.feed(pr("opened", prWith("Fixes QLL-1")));
  await h.feed(pr("edited", prWith("Fixes QLL-1")));
  const comments = h.gh.writes().filter((c) => c.route.endsWith("/comments"));
  strictEqual(comments.length, 1);
  ok(comments[0]!.params.body.includes("https://tasks.example/ws/projects/p-qll/issues/iss-1"));
  await h.close();
  const off = await setup();
  await off.feed(pr("opened", prWith("Fixes QLL-1")));
  strictEqual(off.gh.writes().length, 0);
  await off.close();
});
