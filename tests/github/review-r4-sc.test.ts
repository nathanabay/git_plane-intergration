// Round 4 SC: F6 (commit-status read failures), F7 (-NEW items keep following the PR), F8 (installation lookup 403s),
// prev F18 (a rule whose executor skipped every target is audited ignored).
import test from "node:test";
import { ok, rejects, strictEqual, deepStrictEqual } from "node:assert/strict";
import { checkPrReadiness } from "../../src/github/pr-automation.ts";
import { fireReadyForMerge, handlePullRequest } from "../../src/app/pr.ts";
import { handlePlaneIssue } from "../../src/app/issues.ts";
import { runRules } from "../../src/app/rules.ts";
import { ghJob, LABELS, makeHarness, planeJob, prPayload, sha } from "../a8/harness.ts";

const HEAD = sha("a");
const err = (status: number, headers: Record<string, string> = {}) => Object.assign(new Error(`HTTP ${status}`), { status, response: { headers } });

function fakeOctokit(statusReply: () => unknown) {
  return {
    request: async (route: string) => {
      if (/pulls\/\{pull_number\}\/reviews$/.test(route)) return { data: [{ state: "APPROVED", user: { id: 9, login: "rev" } }] };
      if (/check-suites$/.test(route)) return { data: { total_count: 1, check_suites: [{ status: "completed", conclusion: "success" }] } };
      return { data: statusReply() };
    },
  } as any;
}
// Round 4 F5 (SA): a mapping syncs only for an allow-listed installation.
const allow = (h: Awaited<ReturnType<typeof makeHarness>>) => h.db.query("INSERT INTO workspace_installations (workspace_slug, installation_id) VALUES ('ws', 1) ON CONFLICT DO NOTHING");
const repo = { owner: "acme", repo: "web" };

test("F6: a 403/404 from the commit-status endpoint is not ready and is reported; a 5xx propagates", async () => {
  for (const status of [403, 404]) {
    const seen: unknown[] = [];
    const octokit = fakeOctokit(() => { throw err(status); });
    strictEqual(await checkPrReadiness(octokit, repo, 12, HEAD, { onUnavailable: (i) => { seen.push(i); } }), false);
    deepStrictEqual(seen, [{ what: "commit_status", status }]);
  }
  await rejects(checkPrReadiness(fakeOctokit(() => { throw err(502); }), repo, 12, HEAD), /502/);
  strictEqual(await checkPrReadiness(fakeOctokit(() => ({ state: "success", total_count: 1 })), repo, 12, HEAD), true);
  strictEqual(await checkPrReadiness(fakeOctokit(() => ({ state: "pending", total_count: 0 })), repo, 12, HEAD), true);
});

test("F6: fireReadyForMerge writes nothing and audits readiness_unavailable when statuses are forbidden", async () => {
  const h = await makeHarness();
  try {
    await h.mapping({ rules: "- when: pull_request.ready_for_merge\n  then: [{ comment: \"ready\" }]\n", smartCommits: false });
    await allow(h);
    await h.link("iss-1", 12, { kind: "pr" });
    const { mappingsForRepo } = await import("../../src/app/mappings.ts");
    const octokit = { request: async (route: string) => {
      if (/reviews$/.test(route)) return { data: [{ state: "APPROVED", user: { id: 9 } }] };
      if (/check-suites$/.test(route)) return { data: { check_suites: [] } };
      throw err(403);
    } };
    const pr = { number: 12, draft: false, state: "open", merged: false, head: { sha: HEAD } };
    strictEqual(await fireReadyForMerge(h.ctx, (await mappingsForRepo(h.db, 555))[0]!, ghJob("pull_request_review", {}), octokit, pr), false);
    strictEqual(h.plane.writes().length, 0);
    strictEqual((await h.audit("readiness_unavailable")).length, 1);
  } finally { await h.close(); }
});

test("F7: an item created by -NEW (stored pr link) still moves when the PR later merges", async () => {
  const h = await makeHarness();
  try {
    await h.mapping({ rules: "- when: pull_request.merged\n  then: [{ set_state: Done }]\n", smartCommits: false });
    await allow(h);
    await h.link("new-1", 12, { kind: "pr", tier: "closing" });
    await handlePullRequest(h.ctx, ghJob("pull_request", prPayload("closed", {}, { merged: true, state: "closed", body: "no references here", title: "Plain" })));
    ok(h.plane.writes().some((c) => c.method === "PATCH" && /new-1/.test(c.path) && c.body?.state === "s-done"), "the stored link's item reached Done");
    ok(h.plane.writes().some((c) => /new-1.*links/.test(c.path)), "its rollup link was updated");
  } finally { await h.close(); }
});

const optInPayload = { action: "update", data: { id: "i9", project: "p-qll", name: "Ship it", labels: [LABELS[0]], description_html: "<p>d</p>" }, activity: { field: "label_ids", old_value: [], new_value: [LABELS[0]!.id], actor: { id: "u-human", email: "human@test.local" } } };

test("F8: a rate-limited 403 from the installation lookup fails the delivery so it retries", async () => {
  for (const headers of [{ "retry-after": "30" }, { "x-ratelimit-remaining": "0" }] as Record<string, string>[]) {
    const h = await makeHarness();
    try {
      await h.mapping({ smartCommits: false, installationId: null });
      (h.ctx.ghClient as any).installationIdFor = async () => { throw err(403, headers); };
      await rejects(handlePlaneIssue(h.ctx, planeJob("issue", optInPayload)), /403/);
      strictEqual(h.gh.writes().length, 0);
    } finally { await h.close(); }
  }
});

test("F8: a plain 403/404 means not installed: nothing is registered with installation 0, the skip is audited", async () => {
  for (const status of [403, 404]) {
    const h = await makeHarness();
    try {
      await h.mapping({ smartCommits: false, installationId: null, policies: { title: "last_write_wins" } });
      (h.ctx.ghClient as any).installationIdFor = async () => { throw err(status); };
      await handlePlaneIssue(h.ctx, planeJob("issue", optInPayload));
      strictEqual(h.gh.writes().length, 0);
      ok((await h.audit("github_not_installed")).length >= 1, "audited github_not_installed");
    } finally { await h.close(); }
  }
});

test("prev F18: a rule whose executor skips every target is audited ignored, not applied", async () => {
  const h = await makeHarness();
  try {
    const id = await h.mapping({ rules: "- when: pull_request.opened\n  then: [{ set_state: In Progress }]\n", smartCommits: false });
    await allow(h);
    const { mappingsForRepo } = await import("../../src/app/mappings.ts");
    const mapping = (await mappingsForRepo(h.db, 555)).find((m) => m.id === id)!;
    const event = { trigger: "pull_request.opened" } as any;
    await runRules(h.ctx, mapping, event, [{ slug: "ws", projectId: "p-qll", issueId: "iss-1", tier: "relation" }], { deliveryId: "d-rel", actor: async () => undefined });
    strictEqual(h.plane.writes().length, 0);
    strictEqual((await h.audit("rule_match"))[0].outcome, "ignored");
    await runRules(h.ctx, mapping, event, [{ slug: "ws", projectId: "p-qll", issueId: "iss-1", tier: "closing" }], { deliveryId: "d-cl", actor: async () => undefined });
    ok(h.plane.writes().length >= 1);
    strictEqual((await h.audit("rule_match"))[1].outcome, "applied");
  } finally { await h.close(); }
});
