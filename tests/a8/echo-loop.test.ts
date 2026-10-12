// Spec §10, the test that earns its keep: a change on one side is written to the other, the webhook that
// write causes is synthesised, and it must be dropped on ingress — in both directions.
import test from "node:test";
import type { TestContext } from "node:test";
import { strictEqual, deepStrictEqual, ok } from "node:assert/strict";
import { BOT, ghJob, LABELS, makeHarness, planeJob } from "./harness.ts";

const planeIssue = (over: Record<string, unknown> = {}) => ({ id: "i1", project: "p-qll", name: "T", ...over });
const planeUpdate = (field: string, newValue: unknown, data: Record<string, unknown> = {}, actor = "u-human", oldValue: unknown = null) =>
  planeJob("issue", { action: "update", data: planeIssue(data), activity: { field, new_value: newValue, old_value: oldValue, actor: { id: actor, email: "human@test.local" } } });
const ghIssue = (action: string, issue: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  ghJob("issues", { action, issue: { number: 7, title: "Old", body: "", state: "open", labels: [], assignees: [], ...issue }, ...extra });

async function setup(t: TestContext) {
  const h = await makeHarness();
  t.after(() => h.close());
  await h.mapping({ policies: { title: "last_write_wins", description: "last_write_wins" } });
  await h.link("i1", 7);
  return h;
}

test("plane → github: a title change is written once, and the GitHub edit it causes is dropped", async (t) => {
  const h = await setup(t);
  strictEqual(await h.feed(planeUpdate("name", "New title", { name: "New title" })), "handled");
  const w = h.gh.writes();
  strictEqual(w.length, 1);
  strictEqual(w[0]!.route, "PATCH /repos/{owner}/{repo}/issues/{issue_number}");
  deepStrictEqual(w[0]!.params, { owner: "acme", repo: "web", issue_number: 7, title: "New title" });
  // The webhook GitHub sends for that PATCH.
  const echo = ghIssue("edited", { title: "New title" }, { changes: { title: { from: "Old" } }, sender: BOT });
  strictEqual(await h.feed(echo), "echo");
  strictEqual(h.gh.writes().length, 1, "the echo caused a GitHub write");
  strictEqual(h.plane.writes().length, 0, "the echo caused a Plane write");
});

test("github → plane: a title change is written once, and the Plane update it causes is dropped", async (t) => {
  const h = await setup(t);
  strictEqual(await h.feed(ghIssue("edited", { title: "From GitHub" }, { changes: { title: { from: "Old" } } })), "handled");
  const patch = h.plane.writes().find((c) => c.method === "PATCH");
  deepStrictEqual(patch?.body, { name: "From GitHub" });
  strictEqual(await h.feed(planeUpdate("name", "From GitHub", { name: "From GitHub" })), "echo");
  strictEqual(h.plane.writes().length, 1);
  strictEqual(h.gh.writes().length, 0);
});

test("plane → github state: completed closes the issue and GitHub's `closed` event is dropped", async (t) => {
  const h = await setup(t);
  await h.feed(planeUpdate("state", "s-done", { state: { id: "s-done", group: "completed" } }));
  deepStrictEqual(h.gh.writes().map((c) => c.params.state), ["closed"]);
  strictEqual(await h.feed(ghIssue("closed", { state: "closed" }, { sender: BOT })), "echo");
  strictEqual(h.gh.writes().length, 1);
  strictEqual(h.plane.writes().length, 0);
});

test("github → plane state: closing moves the item to a completed state and Plane's echo is dropped", async (t) => {
  const h = await setup(t);
  await h.feed(ghIssue("closed", { state: "closed" }));
  deepStrictEqual(h.plane.writes().map((c) => c.body), [{ state: "s-done" }]);
  strictEqual(await h.feed(planeUpdate("state", "s-done", { state: { id: "s-done", group: "completed" } })), "echo");
  strictEqual(h.plane.writes().length, 1);
});

test("plane → github comment: mirrored once, and GitHub's issue_comment event for it is dropped", async (t) => {
  const h = await setup(t);
  await h.feed(planeJob("issue_comment", { action: "create", data: { id: "c1", issue: "i1", project: "p-qll", comment_html: "<p>hello</p>", actor: { display_name: "Ana" } }, activity: { field: "comment", actor: { id: "u-human" } } }));
  const w = h.gh.writes();
  strictEqual(w.length, 1);
  strictEqual(w[0]!.route, "POST /repos/{owner}/{repo}/issues/{issue_number}/comments");
  const echo = ghJob("issue_comment", { action: "created", issue: { number: 7, title: "Old" }, comment: { body: w[0]!.params.body, user: BOT }, sender: BOT });
  strictEqual(await h.feed(echo), "echo");
  strictEqual(h.gh.writes().length, 1);
});

test("github → plane comment: mirrored once, and Plane's creation event for it is dropped", async (t) => {
  const h = await setup(t);
  await h.feed(ghJob("issue_comment", { action: "created", issue: { number: 7, title: "Old" }, comment: { body: "from github", user: { login: "octo" }, html_url: "https://github.com/acme/web/issues/7#c" } }));
  const post = h.plane.writes().find((c) => /\/comments\/$/.test(c.path));
  ok(post, "no Plane comment");
  const commentId = "c-1";
  strictEqual(await h.feed(planeJob("issue_comment", { action: "create", data: { id: commentId, issue: "i1", project: "p-qll" }, activity: { field: null, actor: { id: "u-x" } } })), "echo", "the creation we made is dropped");
  strictEqual(await h.feed(planeJob("issue_comment", { action: "create", data: { id: "c-human", issue: "i1", project: "p-qll" }, activity: { field: null, actor: { id: "u-x" } } })), "handled", "a creation we did not make is not an echo");
});

test("a plane item created by the github mirror: the creation event is an echo", async (t) => {
  const h = await setup(t);
  await h.feed(ghJob("issues", { action: "labeled", label: { name: "plane" }, issue: { number: 31, title: "Mirror me", body: "b", state: "open", labels: [{ name: "plane" }], assignees: [] } }));
  const created = h.plane.writes().find((c) => c.method === "POST" && /\/issues\/$/.test(c.path));
  ok(created);
  const id = h.plane.createdIssueIds[0]!;
  strictEqual(await h.feed(planeJob("issue", { action: "create", data: { id, project: "p-qll" }, activity: { field: null, actor: { id: "u-service" } } })), "echo");
});

test("a github issue created by the plane mirror: the opened event is an echo", async (t) => {
  const h = await makeHarness();
  t.after(() => h.close());
  await h.mapping();
  h.gh.respond(/POST \/repos\/\{owner\}\/\{repo\}\/issues$/, () => ({ id: 5001, number: 55 }));
  await h.feed(planeJob("issue", { action: "update", data: planeIssue({ id: "i9", name: "Ship it", labels: [LABELS[0]], description_html: "<p>d</p>" }), activity: { field: "label_ids", old_value: [], new_value: [LABELS[0]!.id], actor: { id: "u-human", email: "human@test.local" } } }));
  ok(h.gh.writes().some((c) => c.route === "POST /repos/{owner}/{repo}/issues"));
  strictEqual(await h.feed(ghJob("issues", { action: "opened", issue: { number: 55, title: "Ship it", body: "", state: "open", labels: [{ name: "plane" }] }, sender: BOT })), "echo");
});

test("an echo is consumed once: the same human edit afterwards is handled and written", async (t) => {
  const h = await setup(t);
  await h.feed(planeUpdate("name", "Same", { name: "Same" }));
  strictEqual(await h.feed(ghIssue("edited", { title: "Same" }, { changes: { title: { from: "Old" } }, sender: BOT })), "echo");
  strictEqual(await h.feed(ghIssue("edited", { title: "Same" }, { changes: { title: { from: "x" } } })), "handled");
  strictEqual(h.plane.writes().length, 1, "the human edit was mirrored to Plane");
});

test("a different value is never an echo even when the field matches", async (t) => {
  const h = await setup(t);
  await h.feed(planeUpdate("name", "A", { name: "A" }));
  strictEqual(await h.feed(ghIssue("edited", { title: "B" }, { changes: { title: { from: "Old" } } })), "handled");
});

test("the service-actor pre-filter drops events by the service user, consuming the matching op", async (t) => {
  const h = await makeHarness({ serviceUserId: "u-service" });
  t.after(() => h.close());
  await h.mapping({ policies: { title: "last_write_wins" } });
  await h.link("i1", 7);
  await h.feed(ghIssue("edited", { title: "X" }, { changes: { title: { from: "Old" } } }));
  strictEqual(await h.feed(planeUpdate("name", "X", { name: "X" }, "u-service")), "echo");
  strictEqual(await h.feed(planeUpdate("name", "X", { name: "X" })), "handled", "the consumed op must not swallow a later human edit");
});

test("F10 API label UUID-array echo terminates with exactly zero extra writes", async (t) => {
  const h = await setup(t);
  // Match the probe's multi-label update, including a pre-existing UUID.
  h.plane.issues.set("fixture", { id: "i1", project: "p-qll", labels: [LABELS[2]!.id] });
  await h.feed(ghIssue("labeled", { labels: [{ name: "feature" }, { name: "bug" }] }, { label: { name: "bug" } }));
  const patch = h.plane.writes().find((c) => c.method === "PATCH" && Array.isArray(c.body?.labels));
  ok(patch, "no label PATCH");
  deepStrictEqual(patch.body.labels, [LABELS[2]!.id, LABELS[1]!.id]);
  const before = [h.plane.writes().length, h.gh.writes().length];
  strictEqual(await h.feed(planeUpdate("labels", patch.body.labels, { labels: [LABELS[2], LABELS[1]] }, "u-human", [LABELS[2]!.id])), "echo");
  deepStrictEqual([h.plane.writes().length, h.gh.writes().length], before, "label echo must cause zero extra writes");
});

for (const field of ["labels", "label_ids"]) {
  test(`F10 human ${field} UUID-array edit adds and removes GitHub label names`, async (t) => {
    const h = await setup(t);
    strictEqual(await h.feed(planeUpdate(field, [LABELS[1]!.id], { labels: [LABELS[1]] }, "u-human", [])), "handled");
    deepStrictEqual(h.gh.writes().map((c) => [c.route, c.params.labels]), [["POST /repos/{owner}/{repo}/issues/{issue_number}/labels", ["bug"]]]);
    strictEqual(await h.feed(ghIssue("labeled", { labels: [{ name: "bug" }] }, { label: { name: "bug" }, sender: BOT })), "echo");
    const before = [h.plane.writes().length, h.gh.writes().length];
    strictEqual(await h.feed(planeUpdate(field, [], { labels: [] }, "u-human", [LABELS[1]!.id])), "handled");
    const removed = h.gh.writes().at(-1)!;
    strictEqual(removed.route, "DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}");
    strictEqual(removed.params.name, "bug");
    ok(h.plane.calls.some((c) => c.method === "GET" && /\/labels\/$/.test(c.path)), "removed label must be resolved through the project label endpoint");
    strictEqual(await h.feed(ghIssue("unlabeled", { labels: [] }, { label: { name: "bug" }, sender: BOT })), "echo");
    deepStrictEqual([h.plane.writes().length, h.gh.writes().length], [before[0], before[1]! + 1]);
  });
}

test("F10 web-app assignee_ids UUID arrays add and clear mapped assignees; their echoes write nothing", async (t) => {
  const h = await setup(t);
  const user = "d2c59a29-f223-4c2d-bf16-0c5e43c16bbb";
  await h.db.query("INSERT INTO user_map (workspace_slug, plane_user_id, gh_login, gh_id) VALUES ('ws', $1, 'alice', 10)", [user]);
  h.gh.respond(/GET \/repos\/\{owner\}\/\{repo\}\/issues\/\{issue_number\}$/, () => ({ assignees: [] }));
  strictEqual(await h.feed(planeUpdate("assignee_ids", [user], { assignees: [{ id: user }] }, "u-human", [])), "handled");
  deepStrictEqual(h.gh.writes().map((c) => c.params.assignees), [["alice"]]);
  strictEqual(await h.feed(ghIssue("assigned", { assignees: [{ login: "alice" }] }, { assignee: { login: "alice" }, sender: BOT })), "echo");
  strictEqual(h.plane.writes().length, 0);
  h.gh.respond(/GET \/repos\/\{owner\}\/\{repo\}\/issues\/\{issue_number\}$/, () => ({ assignees: [{ login: "alice" }] }));
  strictEqual(await h.feed(planeUpdate("assignee_ids", [], { assignees: [] }, "u-human", [user])), "handled");
  deepStrictEqual(h.gh.writes().map((c) => c.params.assignees), [["alice"], ["alice"]]);
  strictEqual(await h.feed(ghIssue("unassigned", { assignees: [] }, { assignee: { login: "alice" }, sender: BOT })), "echo");
  strictEqual(h.plane.writes().length, 0);
  strictEqual(h.gh.writes().length, 2);
});

test("F10 web-app state_id edit closes GitHub and its closed echo produces zero writes", async (t) => {
  const h = await setup(t);
  strictEqual(await h.feed(planeUpdate("state_id", "s-done", { state: { id: "s-done", group: "completed" } }, "u-human", "s-prog")), "handled");
  deepStrictEqual(h.gh.writes().map((c) => c.params.state), ["closed"]);
  strictEqual(await h.feed(ghIssue("closed", { state: "closed" }, { sender: BOT })), "echo");
  strictEqual(h.gh.writes().length, 1);
  strictEqual(h.plane.writes().length, 0);
});

test("F10 API assignees UUID-array echo causes zero additional writes", async (t) => {
  const h = await setup(t);
  const user = "d2c59a29-f223-4c2d-bf16-0c5e43c16bbb";
  await h.db.query("INSERT INTO user_map (workspace_slug, plane_user_id, gh_login, gh_id) VALUES ('ws', $1, 'alice', 10)", [user]);
  await h.feed(ghIssue("assigned", { assignees: [{ login: "alice", id: 10 }] }, { assignee: { login: "alice", id: 10 } })); // assignees resolve by GitHub id
  const patch = h.plane.writes().find((c) => c.method === "PATCH");
  deepStrictEqual(patch?.body, { assignees: [user] });
  const before = [h.plane.writes().length, h.gh.writes().length];
  strictEqual(await h.feed(planeUpdate("assignees", patch!.body.assignees, { assignees: [{ id: user }] }, "u-human", [])), "echo");
  deepStrictEqual([h.plane.writes().length, h.gh.writes().length], before);
});
