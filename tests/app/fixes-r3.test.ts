// Round-3 fixes F5, F7, F8, F18 (implementer SA): wiring through composeRoutes and the live handlers.
import test from "node:test";
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { SecretString } from "../../src/auth/identity.ts";
import { composeRoutes } from "../../src/app/main.ts";
import { startServer } from "../../src/index.ts";
import { migrate } from "../../src/db/migrate.ts";
import { PlaneClient } from "../../src/sync/plane.ts";
import { createMappingVerifier, installationWorkspaceFromDb } from "../../src/ui/mapping-check.ts";
import { mappingsForProject, rememberInstallation } from "../../src/app/mappings.ts";
import { handlePendingMirroredIssue, notInstalledWriter, planeInstallation } from "../../src/app/issues.ts";
import { ghJob, makeHarness, planeJob, prPayload, sha } from "../a8/harness.ts";
import { ADM, KEY, ORIGIN, startFakePlane } from "../ui/harness.ts";

const comments = (h: Awaited<ReturnType<typeof makeHarness>>) => h.plane.writes().filter((c) => /\/comments\/$/.test(c.path));

test("F5: the service's own routes verify a manual user link against GitHub's account (id mismatch is 422)", async () => {
  const db = new PGlite(); await db.waitReady; await migrate(db);
  const plane = await startFakePlane();
  const planeClient = new PlaneClient({ baseUrl: plane.url, token: new SecretString("svc"), fetch: (async (url: string) => (/\/members\/$/.test(String(url)) ? new Response(JSON.stringify([{ member: "11111111-1111-4111-8111-111111111111" }]), { status: 200 }) : new Response("{}", { status: 404 }))) as unknown as typeof fetch, sleep: async () => {}, maxRetries: 0 });
  const ghClient = {
    installationOctokit: async () => ({ request: async () => ({ data: {} }) }),
    installationIdFor: async () => 1,
    // G1 uses an unauthenticated public-profile client; JWT is reserved for App endpoints.
    publicRequest: async () => ({ data: { id: 7, login: "Octo" } }),
    appRequest: async () => { throw new Error("Public user profiles must not use App JWT"); },
  };
  const credentials = { load: async () => { throw new Error("unused"); }, webhookSecret: async () => "s", describe: async () => ({ source: "environment" as const, decryptOk: true }) };
  const config: any = { PLANE_WEBHOOK_SECRET: "p", PLANE_BASE_URL: plane.url, PUBLIC_ORIGIN: ORIGIN };
  const routes = composeRoutes({ config, db, tokenKey: KEY, ctx: { db } as any, planeClient, ghClient, credentials, enqueue: async () => {} });
  const srv = await startServer({ port: 0, host: "127.0.0.1", routes });
  try {
    const put = (githubId: number) => fetch(`http://127.0.0.1:${srv.port}/git-sync/api/workspaces/acme/user-links/11111111-1111-4111-8111-111111111111`, {
      method: "PUT", headers: { cookie: ADM, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ githubLogin: "octo", githubId }),
    });
    strictEqual((await put(999)).status, 422);
    strictEqual((await db.query("SELECT 1 FROM user_map")).rows.length, 0);
  } finally { await srv.close(); await plane.close(); await db.close(); }
});

test("F5: Smart Commits attribute by the sender's GitHub id, not by a login someone else now holds", async () => {
  const h = await makeHarness();
  try {
    await h.mapping();
    await h.db.query("INSERT INTO user_map (workspace_slug, plane_user_id, gh_login, gh_id) VALUES ('ws','pu-a','old-name',5)");
    await h.ctx.vault.store("pu-a", "plane_pat", "pat-a");
    const push = (sender: any, id: string) => ghJob("push", { ref: "refs/heads/main", sender, commits: [{ id, message: "QLL-1 #comment hello", distinct: true }], after: id, before: sha("0") });
    await h.feed(push({ login: "old-name", id: 99, type: "User" }, sha("1"))); // the freed login, registered by someone else
    await h.feed(push({ login: "renamed", id: 5, type: "User" }, sha("2")));    // the real user after a rename
    const keys = comments(h).map((c) => c.key);
    ok(!keys.slice(0, 1).includes("pat-a"), "a stranger holding the old login is not attributed");
    strictEqual(keys[keys.length - 1], "pat-a");
  } finally { await h.close(); }
});

test("F7: a transient installation-lookup failure fails the delivery (it retries); 'not installed' does not", async () => {
  const h = await makeHarness();
  try {
    const mappingId = await h.mapping({ installationId: null });
    await h.db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (1, 'ws')");
    h.gh.respond(/^GET \/repos\//, () => ({ id: 555, full_name: "acme/web" }));
    let verifiedId: number | undefined;
    const verify = createMappingVerifier({ plane: h.ctx.planeClient, github: h.ctx.ghClient, installationWorkspace: installationWorkspaceFromDb(h.db) });
    strictEqual(await verify({ slug: "ws", repo: { id: 555, fullName: "acme/web" }, onInstallationVerified: (id) => { verifiedId = id; } }), null);
    strictEqual(verifiedId, 1);
    await rememberInstallation(h.db, mappingId, verifiedId!);
    const mapping = (await mappingsForProject(h.db, "p-qll", "ws"))[0]!;
    strictEqual(mapping.installationId, 1, "full reducer admission keeps its verified installation");
    await h.link("i1", 7);
    const upd = () => planeJob("issue", { workspace_slug: "ws", action: "update", data: { id: "i1", project: "p-qll", name: "x" }, activity: { field: "name", actor: { id: "u-h" } } });
    let lookups = 0;
    const unavailable = Object.assign(new Error("bad gateway"), { status: 502 });
    h.ctx.ghClient.installationIdFor = async () => { lookups++; throw unavailable; };
    // Uncached lookup classification is a helper-boundary case. Clearing reducer snapshots now
    // invalidates their frozen authority, so do not bypass real mapping admission to force a lookup.
    await rejects(() => planeInstallation(h.ctx, { ...mapping, installationId: null }), (error) => error === unavailable);
    // G14 also revalidates a fully admitted mapping: transient failures must retry the actual delivery.
    await rejects(() => h.feed(upd()), (error) => error === unavailable);
    strictEqual((await mappingsForProject(h.db, "p-qll", "ws"))[0]!.installationId, 1);
    h.ctx.ghClient.installationIdFor = async () => { lookups++; throw Object.assign(new Error("not found"), { status: 404 }); };
    const missingId = await planeInstallation(h.ctx, { ...mapping, installationId: null });
    strictEqual(missingId, 0, "a permanent lookup miss selects the suppression writer");
    const suppressed = notInstalledWriter(h.ctx, mapping, upd());
    strictEqual(suppressed.plan, undefined, "missing installations cannot register create plans");
    await rejects(() => suppressed.apply({ kind: "comment", installationId: missingId, owner: mapping.owner,
      repo: mapping.repo, repoId: mapping.ghRepoId, number: 7, body: "must be suppressed" }), /not installed/);
    strictEqual(lookups, 3, "the helper classifications and transient reducer delivery all reach the lookup");
    strictEqual(h.gh.writes().length, 0, "no write is made with an unavailable installation");
    strictEqual((await h.db.query("SELECT 1 FROM outbound_writes")).rows.length, 0);
    ok((await h.audit("github_not_installed")).length >= 1, "the permanent miss is audited");
    // A confirmed missing installation disables the admitted mapping without freezing null authority.
    strictEqual(await h.feed(upd()), "handled");
    strictEqual(lookups, 4, "a saved installation never bypasses G14's current-access lookup");
    strictEqual((await h.db.query<any>("SELECT installation_id FROM repo_mappings WHERE id = $1", [mappingId])).rows[0].installation_id, null);
    deepStrictEqual(await mappingsForProject(h.db, "p-qll", "ws"), []);
    strictEqual(h.gh.writes().length, 0);
    strictEqual((await h.db.query("SELECT 1 FROM outbound_writes")).rows.length, 0);
    ok((await h.audit("github_not_installed")).length >= 2, "both helper suppression and actual delivery are audited");
    strictEqual(await h.feed(upd()), "handled");
    strictEqual(lookups, 4, "disabled mappings cannot admit later delivery work");
    // Once access is restored and explicitly verified, full reducer admission revalidates it again.
    h.ctx.ghClient.installationIdFor = async () => { lookups++; return 1; };
    strictEqual(await verify({ slug: "ws", repo: { id: 555, fullName: "acme/web" }, onInstallationVerified: (id) => { verifiedId = id; } }), null);
    await rememberInstallation(h.db, mappingId, verifiedId!);
    strictEqual(await h.feed(upd()), "handled");
    strictEqual(lookups, 6, "restored access is checked at verification and at reducer admission");
    strictEqual((await mappingsForProject(h.db, "p-qll", "ws"))[0]!.installationId, 1);
    // A pending Plane event can lose access during its resume even after outbox admission.
    const beforeResume = { githubWrites: h.gh.writes().length, planeWrites: h.plane.writes().length };
    h.ctx.ghClient.installationIdFor = async () => { lookups++; throw Object.assign(new Error("not found during resume"), { status: 404 }); };
    await handlePendingMirroredIssue(h.ctx, {
      kind: "mirror_pending", job: upd(), mappingId, projectId: "p-qll", issueId: "i1", identifier: "pending event",
      authority: { mappingId: String(mappingId), workspaceSlug: "ws", repoId: 555, installationId: 1 },
    });
    strictEqual(lookups, 7);
    deepStrictEqual(await mappingsForProject(h.db, "p-qll", "ws"), []);
    strictEqual(h.gh.writes().length, beforeResume.githubWrites);
    strictEqual(h.plane.writes().length, beforeResume.planeWrites);
    strictEqual((await h.db.query("SELECT 1 FROM outbound_writes")).rows.length, 0);
    ok((await h.audit("github_not_installed")).length >= 3, "resume suppresses and audits lost access too");
  } finally { await h.close(); }
});

const HEAD = sha("a");
async function readySetup(rules: string) {
  const h = await makeHarness();
  await h.mapping({ rules, smartCommits: false });
  await h.link("iss-1", 12, { kind: "pr" });
  const pr = { number: 12, title: "Fix QLL-1", draft: false, state: "open", merged: false, head: { ref: "octo/login", sha: HEAD }, base: { ref: "main" }, labels: [], user: { login: "octo" } };
  h.gh.respond(/pulls\/\{pull_number\}$/, () => pr);
  h.gh.respond(/commits\/\{ref\}\/status$/, () => ({ state: "success", total_count: 1 }));
  h.gh.respond(/commits\/\{commit_sha\}\/pulls$/, (p) => p.page === 1 ? [pr] : []);
  h.gh.respond(/pulls\/\{pull_number\}\/reviews$/, () => [{ state: "APPROVED", user: { login: "rev", id: 9 } }]);
  h.gh.respond(/commits\/\{ref\}\/check-suites$/, () => ({ total_count: 1, check_suites: [{ status: "completed", conclusion: "success" }] }));
  h.gh.respond(/commits\/\{ref\}\/check-runs$/, () => ({ check_runs: [], total_count: 0 }));
  return h;
}

test("F8: with both 'approved' and 'ready for merge' mapped, the ready rule runs last", async () => {
  const h = await readySetup("- when: pull_request.approved\n  then: [{ comment: approved }]\n- when: pull_request.ready_for_merge\n  then: [{ comment: ready }]\n");
  try {
    await h.feed(ghJob("pull_request_review", { ...prPayload("submitted", {}, { title: "Fix QLL-1", head: { ref: "octo/login", sha: HEAD } }), review: { state: "approved", user: { login: "rev", id: 9 } } }));
    deepStrictEqual(comments(h).map((c) => c.body.comment_html), ["<p>approved</p>", "<p>ready</p>"]);
  } finally { await h.close(); }
});

test("F18: readiness costs no GitHub reads for a PR with no linked item, and a check_run does not evaluate it", async () => {
  const h = await readySetup("- when: pull_request.ready_for_merge\n  then: [{ comment: ready }]\n");
  try {
    await h.db.query("UPDATE sync_links SET status = 'orphaned'"); // no active link
    // Suites are now also build input; review reads distinguish readiness evaluation in the fixture.
    const readReads = () => h.gh.calls.filter((c) => /reviews$/.test(c.route)).length;
    await h.feed(ghJob("check_suite", { action: "completed", check_suite: { head_sha: HEAD, conclusion: "success", pull_requests: [{ number: 12 }] } }));
    strictEqual(readReads(), 0);
    await h.db.query("UPDATE sync_links SET status = 'active'");
    await h.feed(ghJob("check_run", { action: "completed", check_run: { head_sha: HEAD, conclusion: "success", pull_requests: [{ number: 12 }] } }));
    strictEqual(readReads(), 0);
    strictEqual(comments(h).length, 0);
    await h.feed(ghJob("check_suite", { action: "completed", check_suite: { head_sha: HEAD, conclusion: "success", pull_requests: [{ number: 12 }] } }));
    strictEqual(comments(h).length, 1);
  } finally { await h.close(); }
});

test("F1 wiring: the assignee-sync wrapper forwards the writer's optional plan method unchanged", async () => {
  const { assigneeSyncWriter } = await import("../../src/app/issues.ts");
  const plan = async () => ({ ok: true as const });
  const wrapped = assigneeSyncWriter({ github: { apply: async () => ({ ok: true as const }), plan } } as any, "ws");
  strictEqual(typeof wrapped.plan, "function");
  deepStrictEqual(await wrapped.plan!("k", []), { ok: true });
  strictEqual(assigneeSyncWriter({ github: { apply: async () => ({ ok: true as const }) } } as any, "ws").plan, undefined);
});
