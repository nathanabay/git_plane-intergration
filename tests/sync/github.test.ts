import test from "node:test";
import { strictEqual, deepStrictEqual, ok, rejects } from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../../src/db/migrate.ts";
import { GithubWritePath, githubFieldChanges, pendingGithubCreateHash } from "../../src/sync/github.ts";
import { createPending } from "../../src/db/ledgers.ts";
import { opHash } from "../../src/sync/ophash.ts";
import { GithubRateLimitError } from "../../src/github/errors.ts";
import { DelayedError, UnrecoverableError } from "bullmq";
import { processQueueJob } from "../../src/queue/workers.ts";
import type { DeferredJob } from "../../src/queue/workers.ts";

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
test("write: removal 404 succeeds only after an accessible issue confirms label absence", async (t) => {
  const { db, calls, sleeps, w } = await setup([err(404), () => ({ data: { labels: [{ name: "other" }] } })]);
  t.after(() => db.close());
  deepStrictEqual(await w.apply({ kind: "remove_label", ...R, label: "gone" }), { ok: true });
  deepStrictEqual(calls, [
    ["DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}", { owner: "o", repo: "r", issue_number: 3, name: "gone" }],
    ["GET /repos/{owner}/{repo}/issues/{issue_number}", { owner: "o", repo: "r", issue_number: 3 }],
  ]);
  deepStrictEqual(sleeps, []);
  strictEqual(await has(db, opHash("github", "7#3", "label:gone", false)), 0);
});
test("write: removal 404 remains a failure for present labels or unconfirmed/inaccessible issues", async () => {
  for (const data of [{ labels: ["GONE"] }, { labels: [{ name: "gone" }] }, {}, { labels: null }, { labels: [{}] }]) {
    const failure = Object.assign(new Error("removal failed"), { status: 404 });
    const { db, calls, sleeps, w } = await setup([() => { throw failure; }, () => ({ data })]);
    try {
      await rejects(w.apply({ kind: "remove_label", ...R, label: "gone" }), (error: unknown) => error === failure);
      strictEqual(calls.length, 2);
      strictEqual(calls[1]![0], "GET /repos/{owner}/{repo}/issues/{issue_number}");
      deepStrictEqual(sleeps, []);
      strictEqual(await has(db, opHash("github", "7#3", "label:gone", false)), 0);
    } finally { await db.close(); }
  }
  for (const status of [403, 404]) {
    const confirmationFailure = Object.assign(new Error("issue inaccessible"), { status });
    const { db, calls, sleeps, w } = await setup([err(404), () => { throw confirmationFailure; }]);
    try {
      await rejects(w.apply({ kind: "remove_label", ...R, label: "gone" }), (error: unknown) => error === confirmationFailure);
      strictEqual(calls.length, 2);
      deepStrictEqual(sleeps, []);
      strictEqual(await has(db, opHash("github", "7#3", "label:gone", false)), 0);
    } finally { await db.close(); }
  }
});
test("write: rate-limited label-absence confirmation defers without declaring success", async (t) => {
  const { db, calls, sleeps, w } = await setup([err(404), err(429, { "retry-after": "900" })]);
  t.after(() => db.close());
  const started = Date.now();
  await rejects(w.apply({ kind: "remove_label", ...R, installationId: 100005, label: "gone" }), (error: unknown) => {
    ok(error instanceof GithubRateLimitError);
    ok(error.retryAt >= started + 900_000 && error.retryAt <= Date.now() + 900_000);
    strictEqual(error.requestMade, true);
    return true;
  });
  strictEqual(calls.length, 2);
  strictEqual(calls[1]![0], "GET /repos/{owner}/{repo}/issues/{issue_number}");
  deepStrictEqual(sleeps, []);
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
test("rate limit: 403 with retry-after and 429 defer one request; plain 403 preserves its failure", async (t) => {
  const cases = [
    { installationId: 100001, status: 403, headers: { "retry-after": "2" }, wait: 2000 },
    { installationId: 100002, status: 429, headers: {}, wait: 60_000 },
    { installationId: 100003, status: 429, headers: { "retry-after": "900" }, wait: 900_000 },
  ];
  for (const scenario of cases) {
    const failure = Object.assign(new Error("rate limited"), { status: scenario.status, response: { headers: scenario.headers } });
    const { db, calls, sleeps, w } = await setup([() => { throw failure; }]);
    t.after(() => db.close());
    const started = Date.now();
    await rejects(w.apply({ kind: "comment", ...R, installationId: scenario.installationId, body: "x" }), (error: unknown) => {
      ok(error instanceof GithubRateLimitError);
      strictEqual(error.cause, failure);
      strictEqual(error.requestMade, true);
      ok(error.retryAt >= started + scenario.wait && error.retryAt <= Date.now() + scenario.wait);
      return true;
    });
    strictEqual(calls.length, 1, "the write must return scheduling data rather than retry inline");
    deepStrictEqual(sleeps, []);
    strictEqual(await has(db, opHash("github", "7#3", "comment", "x")), 0);
  }
  const failure = Object.assign(new Error("permission denied"), { status: 403 });
  const b = await setup([() => { throw failure; }]);
  t.after(() => b.db.close());
  await rejects(b.w.apply({ kind: "comment", ...R, body: "x" }), (error: unknown) => error === failure);
  strictEqual(b.calls.length, 1);
  deepStrictEqual(b.sleeps, []);
  strictEqual(await has(b.db, opHash("github", "7#3", "comment", "x")), 0);
});
test("rate limit: exhausted quota preserves the full reset deadline and blocks premature requests", async (t) => {
  const retryAt = (Math.floor(Date.now() / 1000) + 2700) * 1000;
  const headers = { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(retryAt / 1000) };
  const a = await setup([err(403, headers)]);
  t.after(() => a.db.close());
  const write = { kind: "comment" as const, ...R, installationId: 100004, body: "x" };
  await rejects(a.w.apply(write), (error: unknown) => {
    ok(error instanceof GithubRateLimitError);
    strictEqual(error.retryAt, retryAt);
    strictEqual(error.requestMade, true);
    return true;
  });
  await rejects(a.w.apply(write), (error: unknown) => {
    ok(error instanceof GithubRateLimitError);
    strictEqual(error.retryAt, retryAt);
    strictEqual(error.requestMade, false, "an existing cooldown must reject before making another HTTP request");
    return true;
  });
  strictEqual(a.calls.length, 1);
  deepStrictEqual(a.sleeps, []);
  strictEqual(await has(a.db, opHash("github", "7#3", "comment", "x")), 0);
});
test("rate limit: the queue defers exponential retries and terminates at its configured attempt budget", async () => {
  const now = Date.UTC(2026, 9, 12);
  let clock = now, requests = 0;
  const deadlines: number[] = [];
  const job: DeferredJob = {
    data: {}, attemptsMade: 0, opts: { attempts: 6 }, token: "lock",
    updateData: async (data) => { job.data = data; },
    moveToDelayed: async (at, token) => { strictEqual(token, "lock"); deadlines.push(at); },
  };
  const work = async () => { requests++; return err(429)(); };
  for (let attempt = 0; attempt < 5; attempt++) {
    const expectedDeadline = clock + 60_000 * 2 ** attempt;
    await rejects(processQueueJob(job, work, { outbound: true, now: () => clock }), DelayedError);
    strictEqual(requests, attempt + 1);
    strictEqual(job.data._rateLimitAttempts, attempt + 1);
    strictEqual(deadlines[attempt], expectedDeadline);
    clock = expectedDeadline;
  }
  await rejects(processQueueJob(job, work, { outbound: true, now: () => clock }), UnrecoverableError);
  strictEqual(requests, 6, "bounded retries remain enforced by the scheduler");
  strictEqual(deadlines.length, 5, "exhausted jobs must not schedule another retry");
});
