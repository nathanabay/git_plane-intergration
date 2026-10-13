import test from "node:test";
import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { compileLifecycleRules, QLL_DEFAULTS } from "../../src/github/pr-automation.ts";
import { PlaneApiError } from "../../src/sync/plane.ts";
import type { PlaneWrite, PlaneWritePath } from "../../src/sync/plane.ts";
import { ghJob, makeHarness, sha, STATES } from "./harness.ts";

const cases = [
  { name: "backport cherry-pick cannot reopen Done", branch: "release/1.2", state: "s-done", message: "fixes QLL-1 login (cherry picked from commit abc)", targets: [] },
  { name: "GitHub revert branch cannot reopen Done", branch: "revert-12-octo/QLL-1-login", state: "s-done", message: 'Revert "fixes QLL-1 login"', targets: [] },
  { name: "own completed branch target stays Done", branch: "octo/QLL-1-login", state: "s-done", message: "ordinary commit", targets: [] },
  { name: "own cancelled branch target stays Won't Do", branch: "octo/QLL-1-login", state: "s-cancelled", message: "ordinary commit", targets: [] },
  { name: "active branch work starts without targeting historical commit references", branch: "octo/QLL-2-login", state: "s-done", message: "Fixes QLL-1", targets: ["iss-2"] },
  { name: "commit-only active reference cannot define the branch's work", branch: "release/1.2", state: "s-backlog", message: "Fixes QLL-1", targets: [] },
  { name: "revert branch does not start active items either", branch: "ReVeRt-12-octo/QLL-1-login", state: "s-backlog", message: "ordinary commit", targets: [] },
  { name: "ordinary branch starts its own active item", branch: "octo/QLL-1-login", state: "s-backlog", message: "ordinary commit", targets: ["iss-1"] },
  { name: "one terminal branch reference does not block another active branch reference", branch: "octo/QLL-1-and-QLL-2-login", state: "s-done", message: "ordinary commit", targets: ["iss-2"] },
];

for (const saved of [false, true]) {
  test(`F10 ${saved ? "saved" : "unsaved"} lifecycle target matrix`, async (t) => {
    const h = await makeHarness(); t.after(() => h.close());
    await h.mapping({ smartCommits: false, ...(saved ? { rules: compileLifecycleRules(QLL_DEFAULTS) } : {}) });
    for (const example of cases) await t.test(example.name, async () => {
      h.plane.issues.set("QLL-1", { id: "iss-1", project: "p-qll", state: example.state });
      const before = h.plane.writes().length;
      const job = ghJob("push", { created: true, before: sha("0"), after: sha("a"), ref: `refs/heads/${example.branch}`, commits: [{ id: sha("a"), message: example.message }] });
      await h.feed(job);
      deepStrictEqual(h.plane.writes().slice(before).filter((w) => w.method === "PATCH" && !/\/links\//.test(w.path)).map((w) => ({ path: w.path, body: w.body })),
        example.targets.map((id) => ({ path: `/workspaces/ws/projects/p-qll/work-items/${id}/`, body: { state: "s-prog" } })));
      deepStrictEqual((await h.audit("rule_match")).filter((r) => r.delivery_id === job.deliveryId).map((r) => r.detail.issues), example.targets.length ? [example.targets] : []);
    });
    strictEqual(h.gh.calls.filter((c) => /commits\/\{commit_sha\}\/pulls$/.test(c.route)).length, 0);
  });
}

test("F10 a branch start queued before completion cannot reopen the item at execution time", async (t) => {
  const h = await makeHarness(); t.after(() => h.close());
  await h.mapping({ smartCommits: false });
  const inline = h.ctx.plane;
  const queued: PlaneWrite[] = [];
  h.ctx.plane = { async apply(write) { queued.push(JSON.parse(JSON.stringify(write))); return { ok: true }; } };
  await h.feed(ghJob("push", { created: true, before: sha("0"), ref: "refs/heads/octo/QLL-1-login", commits: [] }));
  const starts = queued.filter((write) => write.kind === "update_issue");
  deepStrictEqual(starts, [{ kind: "update_issue", slug: "ws", projectId: "p-qll", issueId: "iss-1", fields: { state: "s-prog" }, skipTerminalState: true }]);
  // An earlier queued completion has applied since the reducer selected this active branch target.
  h.plane.issues.set("QLL-1", { id: "iss-1", project: "p-qll", state: "s-done" });
  await inline.apply(starts[0]!);
  deepStrictEqual(h.plane.writes(), []);
  strictEqual((await h.db.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE kind = $1 OR outcome = $1", ["skipped_terminal_state"])).rows[0]?.n, 1);
});

test("F10 execution-time state lookup failures keep guarded writes retryable", async (t) => {
  const h = await makeHarness(); t.after(() => h.close());
  h.ctx.planeClient.getIssue = async () => { throw new PlaneApiError(503, {}, "temporary state lookup failure"); };
  await rejects(h.ctx.plane.apply({ kind: "update_issue", slug: "ws", projectId: "p-qll", issueId: "iss-1", fields: { state: "s-prog" }, skipTerminalState: true }),
    (err) => err instanceof PlaneApiError && err.status === 503);
  deepStrictEqual(h.plane.writes(), []);
});

test("F10 execution cannot guess an unresolved current state", async (t) => {
  const h = await makeHarness(); t.after(() => h.close());
  h.plane.issues.set("QLL-1", { id: "iss-1", project: "p-qll", state: "unresolved-state" });
  await rejects(h.ctx.plane.apply({ kind: "update_issue", slug: "ws", projectId: "p-qll", issueId: "iss-1", fields: { state: "s-prog" }, skipTerminalState: true }));
  deepStrictEqual(h.plane.writes(), []);
});

test("F10 execution refreshes cached project states when an item finished in a newly added state", async (t) => {
  const h = await makeHarness(); t.after(() => h.close());
  const start: PlaneWrite = { kind: "update_issue", slug: "ws", projectId: "p-qll", issueId: "iss-1", fields: { state: "s-prog" }, skipTerminalState: true };
  await (h.ctx.plane as PlaneWritePath).preflight(start);
  h.ctx.planeClient.listStates = async () => [...STATES, { id: "new-done", name: "Finished later", group: "completed" }];
  h.plane.issues.set("QLL-1", { id: "iss-1", project: "p-qll", state: "new-done" });
  await h.ctx.plane.apply(start);
  deepStrictEqual(h.plane.writes(), []);
});

test("F10 branch state groups resolve by project ID, and unknown states do not start work", async (t) => {
  const h = await makeHarness(); t.after(() => h.close());
  await h.mapping({ smartCommits: false });
  for (const state of [undefined, "unknown-state", { id: "s-done", group: "started" }]) {
    h.plane.issues.set("QLL-1", { id: "iss-1", project: "p-qll", state });
    await h.feed(ghJob("push", { created: true, before: sha("0"), ref: "refs/heads/octo/QLL-1-login", commits: [] }));
  }
  deepStrictEqual(h.plane.writes().filter((write) => write.method === "PATCH" && !/\/links\//.test(write.path)), []);
});
