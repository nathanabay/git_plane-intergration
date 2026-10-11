// F7 wiring (round 2): pull_request.ready_for_merge fires from the live paths, exactly once per head commit.
import test from "node:test";
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { handleCommitStatus } from "../../src/app/checks.ts";
import { ghJob, makeHarness, prPayload, REPO, sha } from "../a8/harness.ts";

const RULE = "- when: pull_request.ready_for_merge\n  then: [{ comment: \"ready\" }]\n";
const comments = (h: Awaited<ReturnType<typeof makeHarness>>) => h.plane.writes().filter((c) => /\/comments\/$/.test(c.path));
const HEAD = sha("a");

async function setup(state: { suites: any[]; reviews: any[] }) {
  const h = await makeHarness();
  await h.mapping({ rules: RULE, smartCommits: false });
  await h.link("iss-1", 12, { kind: "pr" });
  const pr = { number: 12, title: "Fix QLL-1", draft: false, state: "open", merged: false, head: { ref: "octo/login", sha: HEAD }, base: { ref: "main" }, labels: [], user: { login: "octo" } };
  h.gh.respond(/commits\/\{commit_sha\}\/pulls$/, () => [pr]);
  h.gh.respond(/pulls\/\{pull_number\}\/reviews$/, () => state.reviews);
  h.gh.respond(/commits\/\{ref\}\/check-suites$/, () => ({ check_suites: state.suites }));
  h.gh.respond(/commits\/\{ref\}\/check-runs$/, () => ({ check_runs: [] }));
  return h;
}

test("F7: an approval plus all checks passing fires ready_for_merge exactly once, whichever event arrives", async () => {
  const state = { suites: [{ status: "in_progress", conclusion: null }] as any[], reviews: [] as any[] };
  const h = await setup(state);
  try {
    const review = () => ghJob("pull_request_review", { ...prPayload("submitted", {}, { head: { ref: "octo/login", sha: HEAD } }), review: { state: "approved", user: { login: "rev", id: 9 } } });
    const suite = () => ghJob("check_suite", { action: "completed", check_suite: { head_sha: HEAD, conclusion: "success", pull_requests: [{ number: 12 }] } });
    // approved but a check suite is still running: not ready
    state.reviews = [{ state: "APPROVED", user: { login: "rev", id: 9 } }];
    await h.feed(review());
    strictEqual(comments(h).length, 0);
    // the suite completes: ready
    state.suites = [{ status: "completed", conclusion: "success" }];
    await h.feed(suite());
    strictEqual(comments(h).length, 1);
    // a redelivered approval, another suite event and a commit status for the same head commit do not fire it again
    await h.feed(review());
    await h.feed(suite());
    await handleCommitStatus(h.ctx, ghJob("status", { sha: HEAD, state: "success" }));
    strictEqual(comments(h).length, 1);
    deepStrictEqual((await h.audit("ready_for_merge")).length, 1);
  } finally { await h.close(); }
});

test("F7: an approval arriving after the checks already passed fires it, and a status event alone can too", async () => {
  const state = { suites: [{ status: "completed", conclusion: "success" }] as any[], reviews: [{ state: "APPROVED", user: { login: "rev", id: 9 } }] as any[] };
  const h = await setup(state);
  try {
    await h.feed(ghJob("pull_request_review", { ...prPayload("submitted", {}, { head: { ref: "octo/login", sha: HEAD } }), review: { state: "approved", user: { login: "rev", id: 9 } } }));
    strictEqual(comments(h).length, 1);
  } finally { await h.close(); }
  const h2 = await setup(state);
  try {
    await handleCommitStatus(h2.ctx, ghJob("status", { sha: HEAD, state: "success", repository: REPO }));
    strictEqual(comments(h2).length, 1);
    await handleCommitStatus(h2.ctx, ghJob("status", { sha: HEAD, state: "failure" }));
    strictEqual(comments(h2).length, 1);
  } finally { await h2.close(); }
});
