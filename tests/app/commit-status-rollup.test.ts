// E2E-5/S37. Context7 /websites/github_en: status payload root sha/state/context/target_url,
// branches (bounded to ten; not PRs). /websites/github_en_rest: /commits/{ref}/status aggregates
// the latest state of all contexts; the statuses array itself may be only one page.
import test from "node:test";
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { handleCommitStatus } from "../../src/app/checks.ts";
import { commitStatusBuildStatus, parseDevLinks, upsertRollupLink } from "../../src/sync/dev-info.ts";
import { getDevInfoLink } from "../../src/db/ledgers.ts";
import { ghJob, makeHarness, REPO, sha } from "../a8/harness.ts";

const HEAD = "ee7aa78fdfb35df6755839bf62fb46389e3f5ca1";
const REPOSITORY = { ...REPO, html_url: "https://github.com/acme/web" };
const PR = { number: 19, title: "Fix QLL-1", state: "open", draft: false, merged: false,
  html_url: `${REPOSITORY.html_url}/pull/19`, head: { sha: HEAD, ref: "topic", repo: REPOSITORY },
  base: { ref: "main", repo: REPOSITORY }, labels: [], user: { login: "octo" } };
const recordedStatus = {
  // Same shape/sha/context as audit row 357. Identities/URLs are dummy fixture principals.
  id: 56239231087, sha: HEAD, state: "success", context: "e2e/2610131532-4ce7/S37",
  target_url: PR.html_url, branches: [{ name: "e2e-2610131532-4ce7-s37",
    commit: { sha: HEAD, url: `https://api.github.com/repos/acme/web/commits/${HEAD}` }, protected: false }],
  repository: REPOSITORY,
};
const links = (h: Awaited<ReturnType<typeof makeHarness>>) => h.plane.writes().filter(c => /\/links\//.test(c.path));

async function fixture(combined = { state: "success", total_count: 1, statuses: [] as any[] }) {
  const h = await makeHarness();
  await h.mapping({ smartCommits: false }); await h.link("iss-1", PR.number, { kind: "pr" });
  h.gh.respond(/commits\/\{commit_sha\}\/pulls$/, () => []); // SHA already introduced: use existing links
  h.gh.respond(/pulls\/\{pull_number\}$/, () => PR);
  h.gh.respond(/commits\/\{ref\}\/status$/, () => combined);
  h.gh.respond(/pulls\/\{pull_number\}\/reviews$/, () => []);
  h.gh.respond(/commits\/\{ref\}\/check-suites$/, () => ({ check_suites: [], total_count: 0 }));
  return { h, combined };
}

test("E2E-5: the real root status payload reaches a CI link without replacing its PR link", async () => {
  const { h } = await fixture();
  try {
    const target = { slug: "ws", projectId: "p-qll", issueId: "iss-1" };
    await upsertRollupLink({ db: h.db, writer: h.ctx.plane }, target, "pr:555:19", { title: "[PR] #19 · OPEN", url: PR.html_url });
    const prLink = await getDevInfoLink(h.db, "iss-1", "pr:555:19");
    strictEqual(await h.feed(ghJob("status", recordedStatus)), "handled");
    const writes = links(h); strictEqual(writes.length, 2);
    const ci = writes[1]!;
    strictEqual(ci.method, "POST");
    strictEqual(ci.path, "/workspaces/ws/projects/p-qll/work-items/iss-1/links/");
    strictEqual(ci.body.title, "[CI] Commit statuses · pass");
    strictEqual(ci.body.url, `${REPOSITORY.html_url}/commit/${HEAD}`);
    ok(ci.body.url !== PR.html_url, "the CI URL cannot collide with the recorded target_url/PR link");
    deepStrictEqual(parseDevLinks([ci.body]), [{ category: "CI", text: "Commit statuses · pass", url: ci.body.url }], "Development panel parses the new build");
    strictEqual(await getDevInfoLink(h.db, "iss-1", "pr:555:19"), prLink);
    ok(await getDevInfoLink(h.db, "iss-1", "commit-status:555:19"));
    strictEqual((await h.audit("inbound_delivery"))[0].outcome, "handled");
  } finally { await h.close(); }
});

test("E2E-5: context/target changes update one CI link in place across pending, failure and pass", async () => {
  const { h, combined } = await fixture();
  try {
    const states = ["pending", "failure", "success"];
    for (const [i, state] of states.entries()) {
      combined.state = state;
      await h.feed(ghJob("status", { ...recordedStatus, state: i === 1 ? "error" : state,
        context: `ci/provider-${i}`, target_url: i ? "javascript:alert(1)" : null, branches: [] }));
    }
    const writes = links(h);
    deepStrictEqual(writes.map(c => c.method), ["POST", "PATCH", "PATCH"]);
    deepStrictEqual(writes.map(c => c.body.title), ["[CI] Commit statuses · pending", "[CI] Commit statuses · fail", "[CI] Commit statuses · pass"]);
    ok(writes.every(c => c.body.url === `${REPOSITORY.html_url}/commit/${HEAD}`));
    const id = await getDevInfoLink(h.db, "iss-1", "commit-status:555:19");
    ok(writes.slice(1).every(c => c.path.endsWith(`/links/${id}/`)), "contexts share the same aggregate identity");
  } finally { await h.close(); }
});

test("E2E-5: a delayed success cannot hide another failing context outside the response page", async () => {
  const { h } = await fixture({ state: "failure", total_count: 101, statuses: [{ context: "ci/green", state: "success" }] });
  try {
    await h.feed(ghJob("status", { ...recordedStatus, state: "success", context: "ci/green" }));
    strictEqual(links(h)[0]?.body.title, "[CI] Commit statuses · fail");
    ok(h.gh.calls.some(c => c.route.endsWith("/commits/{ref}/status") && c.params.ref === HEAD));
    strictEqual(h.gh.calls.filter(c => c.route.endsWith("/statuses")).length, 0, "no reduction over a partial statuses page");
  } finally { await h.close(); }
});

test("E2E-5: current-head/base/workspace guards override misleading status branches and associations", async () => {
  const { h, combined } = await fixture(); combined.state = "pending";
  try {
    await h.link("iss-2", 20, { kind: "pr" }); await h.link("iss-9", 21, { kind: "pr" });
    // A PR may reference multiple items/workspaces; the harness defaults to label_sync, whose
    // one-mirror constraint is deliberately stricter than ordinary historical references.
    await h.db.query("UPDATE sync_links SET created_by = 'magic_word' WHERE gh_number = 19 AND gh_kind = 'pr'");
    await h.link("foreign-target", 19, { kind: "pr", slug: "foreign", project: "foreign-project" });
    h.gh.respond(/commits\/\{commit_sha\}\/pulls$/, () => [{ number: 19 }, { number: 20 }, { number: 21 }]);
    h.gh.respond(/pulls\/\{pull_number\}$/, p => p.pull_number === 19 ? PR : p.pull_number === 20
      ? { ...PR, number: 20, head: { ...PR.head, sha: sha("b") } }
      : { ...PR, number: 21, base: { ref: "main", repo: { ...REPOSITORY, id: 999 } } });
    await h.feed(ghJob("status", { ...recordedStatus, state: "pending", branches: [{ name: "topic", commit: { sha: HEAD } }] }));
    strictEqual(links(h).length, 1);
    ok(links(h).every(c => c.path.includes("/workspaces/ws/") && c.path.includes("/work-items/iss-1/")));
  } finally { await h.close(); }
});

test("E2E-5: stale head alone produces neither rollup nor combined-status read", async () => {
  const { h } = await fixture();
  try {
    h.gh.respond(/pulls\/\{pull_number\}$/, () => ({ ...PR, head: { ...PR.head, sha: sha("b") } }));
    await h.feed(ghJob("status", recordedStatus));
    strictEqual(links(h).length, 0);
    strictEqual(h.gh.calls.filter(c => c.route.endsWith("/commits/{ref}/status")).length, 0);
  } finally { await h.close(); }
});

test("E2E-5: malformed aggregate fails instead of storing a falsely passing link", async () => {
  const { h } = await fixture();
  try {
    h.gh.respond(/commits\/\{ref\}\/status$/, () => ({ state: "success" }));
    await rejects(handleCommitStatus(h.ctx, ghJob("status", recordedStatus)), /Invalid combined GitHub status count/);
    strictEqual(links(h).length, 0);
  } finally { await h.close(); }
});

test("E2E-5: rollup registration failure propagates for retry before readiness effects", async () => {
  const { h } = await fixture();
  try {
    const failure = new Error("rollup outbox unavailable");
    h.ctx.plane.upsertRollup = async () => { throw failure; };
    await rejects(handleCommitStatus(h.ctx, ghJob("status", recordedStatus)), error => error === failure);
    strictEqual((await h.audit("rollup_link"))[0].outcome, "failed");
    strictEqual(h.gh.calls.filter(c => c.route.endsWith("/reviews")).length, 0);
  } finally { await h.close(); }
});

test("E2E-5: combined-state conversion is conservative for zero statuses and invalid snapshots", () => {
  strictEqual(commitStatusBuildStatus({ state: "success", total_count: 1 }), "pass");
  strictEqual(commitStatusBuildStatus({ state: "failure", total_count: 1 }), "fail");
  strictEqual(commitStatusBuildStatus({ state: "pending", total_count: 1 }), "pending");
  strictEqual(commitStatusBuildStatus({ state: "success", total_count: 0 }), "pending");
  for (const combined of [{ state: "other", total_count: 1 }, { state: "success", total_count: -1 }, { state: "success" }]) {
    let error: unknown; try { commitStatusBuildStatus(combined); } catch (e) { error = e; }
    ok(error instanceof Error, "invalid provider data cannot mean pass");
  }
});
