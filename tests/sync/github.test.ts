import test from "node:test";
import { strictEqual, deepStrictEqual, ok, rejects } from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../../src/db/migrate.ts";
import { GithubWritePath, githubFieldChanges, pendingGithubCreateHash } from "../../src/sync/github.ts";
import { createPending } from "../../src/db/ledgers.ts";
import { opHash } from "../../src/sync/ophash.ts";

const R = { installationId: 1, owner: "o", repo: "r", repoId: 7, number: 3 };
async function setup(responses: (() => any)[] = []) {
  const db = new PGlite(); await db.waitReady; await migrate(db);
  const calls: [string, any][] = []; const sleeps: number[] = [];
  const octo = { request: async (route: string, params: any) => { calls.push([route, params]); const next = responses.shift(); return next ? next() : { data: { id: 11, number: 4 }, status: 200, headers: {} }; } };
  const w = new GithubWritePath({ app: { installationOctokit: async () => octo }, db, sleep: async (ms) => { sleeps.push(ms); } });
  return { db, calls, sleeps, w };
}
const has = async (db: PGlite, h: string) => (await db.query("SELECT 1 FROM applied_ops WHERE op_hash = $1", [h])).rows.length;
const err = (status: number, headers: Record<string, string> = {}) => () => { throw Object.assign(new Error("http"), { status, response: { headers } }); };

const repository = { id: 7 };
test("fieldChanges: edited yields only the changed keys with current values", () => {
  deepStrictEqual(githubFieldChanges("pull_request", { action: "edited", pull_request: { number: 3, title: "T", body: "B" }, repository, changes: { body: { from: "x" } } }), [{ targetId: "7#3", field: "body", value: "B" }]);
});
test("fieldChanges: reopened is open, labeled/unlabeled/assigned map to booleans", () => {
  const issue = { number: 3 };
  strictEqual(githubFieldChanges("issues", { action: "reopened", issue, repository })[0]!.value, "open");
  strictEqual(githubFieldChanges("issues", { action: "unlabeled", issue, repository, label: { name: "a" } })[0]!.value, false);
  deepStrictEqual(githubFieldChanges("issues", { action: "assigned", issue, repository, assignee: { login: "z" } }), [{ targetId: "7#3", field: "assignee:z", value: true }]);
});
test("fieldChanges: opened is `created`; unknown events and actions are never echoes", () => {
  const issue = { number: 3 };
  deepStrictEqual(githubFieldChanges("issues", { action: "opened", issue, repository }), [{ targetId: "7#3", field: "created", value: null }]);
  deepStrictEqual(githubFieldChanges("issues", { action: "milestoned", issue, repository }), []);
  deepStrictEqual(githubFieldChanges("issue_comment", { action: "deleted", issue, repository, comment: { body: "x" } }), []);
  deepStrictEqual(githubFieldChanges("push", {}), []);
  deepStrictEqual(githubFieldChanges("issues", { action: "closed" }), []);
});
test("write: update_issue records title/state hashes and PATCHes only given fields", async () => {
  const { db, calls, w } = await setup();
  await w.apply({ kind: "update_issue", ...R, fields: { title: "T" } });
  strictEqual(calls[0]![0], "PATCH /repos/{owner}/{repo}/issues/{issue_number}");
  deepStrictEqual(calls[0]![1], { owner: "o", repo: "r", issue_number: 3, title: "T" });
  strictEqual(await has(db, opHash("github", "7#3", "title", "T")), 1);
});
test("write: labels, assignees and comments use the REST routes and the shared vocabulary", async () => {
  const { db, calls, w } = await setup();
  await w.apply({ kind: "add_labels", ...R, labels: ["a", "b"] });
  await w.apply({ kind: "remove_label", ...R, label: "a" });
  await w.apply({ kind: "add_assignees", ...R, assignees: ["u"] });
  await w.apply({ kind: "comment", ...R, body: "hi" });
  deepStrictEqual(calls.map((c) => c[0].split(" /repos/{owner}/{repo}/issues/{issue_number}")[1]), ["/labels", "/labels/{name}", "/assignees", "/comments"]);
  for (const [f, v] of [["label:a", true], ["label:b", true], ["label:a", false], ["assignee:u", true], ["comment", "hi"]] as const) strictEqual(await has(db, opHash("github", "7#3", f, v)), 1, f);
});
test("write: a failed call forgets its ops", async () => {
  const { db, w } = await setup([err(422)]);
  await rejects(w.apply({ kind: "comment", ...R, body: "x" }));
  strictEqual(await has(db, opHash("github", "7#3", "comment", "x")), 0);
});
test("write: removing a label that is absent (404) is success and leaves no op", async () => {
  const { db, w } = await setup([err(404)]);
  deepStrictEqual(await w.apply({ kind: "remove_label", ...R, label: "gone" }), { ok: true });
  strictEqual(await has(db, opHash("github", "7#3", "label:gone", false)), 0);
});
test("write: create_issue records `created` and initial label ops, and marks pending in-flight (F13)", async () => {
  let pendingDuringRequest = false;
  const db = new PGlite(); await db.waitReady; await migrate(db);
  const octo = {
    request: async (route: string, params: any) => {
      if (route === "POST /repos/{owner}/{repo}/issues") {
        pendingDuringRequest = await createPending(db, pendingGithubCreateHash(7));
        return { data: { id: 11, number: 4 }, status: 201, headers: {} };
      }
      return { data: {}, status: 200, headers: {} };
    }
  };
  const w = new GithubWritePath({ app: { installationOctokit: async () => octo }, db });
  const r = await w.apply({ kind: "create_issue", installationId: 1, owner: "o", repo: "r", repoId: 7, title: "t", body: "b", labels: ["x", "bug"] });
  deepStrictEqual(r, { ok: true, id: 11, number: 4 });
  strictEqual(pendingDuringRequest, true, "marker must be present while GitHub create_issue is in-flight");
  strictEqual(await createPending(db, pendingGithubCreateHash(7)), false, "marker must be cleared after GitHub create_issue");
  strictEqual(await has(db, opHash("github", "7#4", "created", null)), 1);
  strictEqual(await has(db, opHash("github", "7#4", "label:x", true)), 1);
  strictEqual(await has(db, opHash("github", "7#4", "label:bug", true)), 1);
  await db.close();
});
test("rate limit: 403 with retry-after and 429 retry; a plain 403 does not", async () => {
  const a = await setup([err(403, { "retry-after": "2" }), err(429)]);
  await a.w.apply({ kind: "comment", ...R, body: "x" });
  deepStrictEqual(a.sleeps, [2000, 2000]);
  const b = await setup([err(403)]);
  await rejects(b.w.apply({ kind: "comment", ...R, body: "x" }));
  strictEqual(b.sleeps.length, 0);
});
test("rate limit: remaining 0 waits until x-ratelimit-reset; gives up after the retry cap", async () => {
  const headers: Record<string, string> = { "x-ratelimit-remaining": "0" };
  const a = await setup([() => { headers["x-ratelimit-reset"] = String(Math.floor(Date.now() / 1000) + 4); throw Object.assign(new Error("http"), { status: 403, response: { headers } }); }]);
  await a.w.apply({ kind: "comment", ...R, body: "x" });
  ok(a.sleeps[0]! >= 2000 && a.sleeps[0]! <= 5000, String(a.sleeps[0]));
  const b = await setup(Array.from({ length: 10 }, () => err(429)));
  await rejects(b.w.apply({ kind: "comment", ...R, body: "x" }));
  strictEqual(b.calls.length, 6);
});
