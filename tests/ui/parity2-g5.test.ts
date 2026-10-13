import test from "node:test";
import { deepStrictEqual, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
import { appendAudit } from "../../src/db/ledgers.ts";
import { consumeOAuthState, createOAuthState, getGithubOAuthToken, putGithubOAuthToken, readGithubAppClient, readRequireVerifiedCommits } from "../../src/db/parity.ts";
import { encryptSecret } from "../../src/auth/identity.ts";
import { parseGithubApp, parseInstanceSettings, parseMappingInput, parseOwnerHandoff } from "../../src/ui/validate.ts";
import { parseHandoff } from "../../src/ui/install-flow.ts";
import { ApiError, api } from "../../src/ui/client/http.ts";
import { parseLocation } from "../../src/ui/client/router.ts";
import { createConfigRoutes } from "../../src/ui/api.ts";
import type { ConfigApiDeps } from "../../src/ui/api.ts";
import type { MappingHealth, WorkspaceHealth, AuditPage, BackfillResult } from "../../src/ui/client/types.ts";
import { ADM, INST, KEY, MEM, MAPPING, ORIGIN, setup } from "./harness.ts";

async function mapping(h: Awaited<ReturnType<typeof setup>>, slug = "acme", repo = 555, project = "p1", installation: number | null = 1) {
  return Number((await h.db.query<{ id: number }>(`INSERT INTO repo_mappings
    (workspace_slug, gh_repo_id, gh_repo_full_name, plane_project_id, sync_direction, installation_id)
    VALUES ($1,$2,'acme/web',$3,'bidirectional',$4) RETURNING id`, [slug, repo, project, installation])).rows[0]!.id);
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const githubConfig = { GITHUB_CLIENT_ID: "Iv1.client", GITHUB_CLIENT_SECRET: "client-secret", GITHUB_APP_SLUG: "sync-app" };
function githubFixture() {
  const state = { allowRepo: true, calls: [] as string[], revokeStatus: 204, ownerRole: "admin", accountType: "Organization" };
  const installation = () => ({ id: 1, account: { id: 100, login: "acme", type: state.accountType } });
  return { state, deps: { githubOAuthConfig: githubConfig,
    appRequest: async (route: string) => ({ data: route === "GET /app/installations/{installation_id}" ? installation()
      : route === "GET /app/installation-requests" ? [{ id: 9, account: { id: 100, login: "acme" }, requester: { id: 77, login: "octo" } }] : [] }),
    fetch: (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.hostname !== "api.github.com" && u.hostname !== "github.com") return fetch(url, init);
      state.calls.push(u.pathname);
      if (u.pathname === "/user") return json({ id: 77, login: "octo" });
      if (u.pathname === "/user/installations") return json({ total_count: 1, installations: [installation()] });
      if (u.pathname === "/user/memberships/orgs/acme") return json({ state: "active", role: state.ownerRole, organization: { id: 100 } });
      if (u.pathname === "/user/installations/1/repositories") return json({ total_count: state.allowRepo ? 1 : 0, repositories: state.allowRepo ? [{ id: 555, full_name: "acme/web", private: true, permissions: { pull: true, triage: true } }] : [] });
      if (init?.method === "DELETE") return new Response(null, { status: state.revokeStatus });
      return json({}, 404);
    }) as typeof fetch } satisfies Partial<ConfigApiDeps> };
}
async function link(h: Awaited<ReturnType<typeof setup>>, user = "u-adm") {
  await h.db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (1,'acme') ON CONFLICT DO NOTHING");
  await h.db.query("INSERT INTO user_map (workspace_slug, plane_user_id, gh_login, gh_id) VALUES ('acme',$1,'octo',77)", [user]);
  await putGithubOAuthToken(h.db, user, { accessCiphertext: encryptSecret("ghu-user", KEY), refreshCiphertext: null, accessExpiresAt: null, refreshExpiresAt: null });
}

test("N1: health isolates mapping activity, excludes reducer continuation from successful writes and reports disabled/cooldown", async () => {
  const h = await setup([], undefined, undefined, { credentialStatus: async () => ({ source: "database", decryptOk: false }) });
  try {
    const id = await mapping(h);
    const disabled = await mapping(h, "acme", 556, "p2", null);
    const foreign = await mapping(h, "other", 777, "p3", 2);
    await h.db.query("INSERT INTO workspace_installations (installation_id,workspace_slug) VALUES (1,'acme')");
    const github = await appendAudit(h.db, { kind: "inbound_delivery", source: "github", workspaceSlug: "acme", detail: { payload: { repository: { id: 555 } } }, outcome: "handled" });
    const plane = await appendAudit(h.db, { kind: "inbound_delivery", source: "plane", detail: { payload: { data: { project: "p1" } } }, outcome: "handled" });
    const failure = await appendAudit(h.db, { kind: "outbound_write_failed", workspaceSlug: "acme", detail: { mappingId: id }, outcome: "failed", error: "failed" });
    await appendAudit(h.db, { kind: "outbound_write_failed", workspaceSlug: "other", detail: { mappingId: foreign }, outcome: "failed", error: "private failure" });
    const old = await appendAudit(h.db, { kind: "outbound_write_failed", workspaceSlug: "acme", detail: { mappingId: id }, outcome: "failed", error: "old" });
    await h.db.query("UPDATE audit_log SET created_at = now() - interval '25 hours' WHERE id = $1", [old]);
    await h.db.query(`INSERT INTO outbound_writes (id,side,target_key,workspace_slug,write,status,updated_at) VALUES
      ('real','plane','issue','acme',$1::jsonb,'applied',now() - interval '1 hour'),
      ('continuation','plane','issue','acme',$2::jsonb,'applied',now())`, [JSON.stringify({ kind: "patch_issue", _authority: { mappingId: id } }), JSON.stringify({ kind: "resume_reducer", _authority: { mappingId: id } })]);
    const deadline = new Date(Date.now() + 120000).toISOString();
    await h.db.query("INSERT INTO webhook_deliveries (source,delivery_id,received_at) VALUES ('github','github-rate-limit:installation:1',$1)", [deadline]);
    await appendAudit(h.db, { kind: "plane_webhook_silent", source: "plane", workspaceSlug: "other", outcome: "alert" });
    const response = await h.call("GET", "/workspaces/acme/health", { cookie: ADM });
    strictEqual(response.status, 200);
    const health = await response.json() as WorkspaceHealth;
    ok(!health.healthError, health.healthError);
    strictEqual(health.database, true); strictEqual(health.githubAppCredentials.decryptOk, false);
    strictEqual(health.planeWebhookSilent, false);
    const active = health.mappings.find((row) => row.mappingId === id)!;
    ok(active.lastGithubDeliveryAt); ok(active.lastPlaneDeliveryAt); ok(active.lastSuccessfulWriteAt);
    ok(new Date(active.lastSuccessfulWriteAt!).getTime() < Date.now() - 3_000_000);
    strictEqual(active.failuresLast24h, 1); strictEqual(active.rateLimitedUntil, deadline); strictEqual(active.disabledReason, null);
    ok(health.mappings.find((row) => row.mappingId === disabled)?.disabledReason);
    ok(!health.mappings.some((row) => row.mappingId === foreign));
    const page = await (await h.call("GET", `/workspaces/acme/audit?mappingId=${id}&errors=1&hours=24`, { cookie: ADM })).json() as AuditPage;
    deepStrictEqual(page.entries.map((entry) => entry.id), [Number(failure)]);
    strictEqual((await h.call("GET", `/workspaces/acme/audit?mappingId=${foreign}`, { cookie: ADM })).status, 404);
    strictEqual((await h.call("GET", "/workspaces/acme/health", { cookie: MEM })).status, 403);
    await appendAudit(h.db, { kind: "plane_webhook_silent", source: "plane", workspaceSlug: "acme", outcome: "alert" });
    strictEqual((await (await h.call("GET", "/workspaces/acme/health", { cookie: ADM })).json() as WorkspaceHealth).planeWebhookSilent, true);
    await appendAudit(h.db, { kind: "plane_webhook_recovered", source: "plane", workspaceSlug: "acme", outcome: "recovered" });
    strictEqual((await (await h.call("GET", "/workspaces/acme/health", { cookie: ADM })).json() as WorkspaceHealth).planeWebhookSilent, false);
    ok(Number(github) > 0 && Number(plane) > 0);
  } finally { await h.close(); }
});

test("N1: database health actually queries the database and reports failure without invented zero metrics", async () => {
  let probes = 0;
  const h = await setup([], undefined, undefined, { db: { query: async () => { probes++; throw new Error("offline"); }, exec: async () => {} } });
  try {
    for (const path of ["/instance/health", "/workspaces/acme/health"]) {
      const response = await h.call("GET", path, { cookie: path.includes("instance") ? INST : ADM });
      strictEqual(response.status, 200); const result = await response.json() as any;
      strictEqual(result.database, false); ok(result.healthError);
      if (path.includes("instance")) strictEqual(result.failuresLast24h, null);
    }
    // One probe per health call, plus the workspace route's slug-identity binding attempt (audit S2), which
    // health tolerates failing so it can still report the outage.
    strictEqual(probes, 3);
  } finally { await h.close(); }
});

test("N1: instance audit defaults to unscoped rows; 24-hour failures include all scopes only for instance admins", async () => {
  const h = await setup();
  try {
    const global = Number(await appendAudit(h.db, { kind: "credentials", outcome: "failed", error: "global" }));
    const scoped = Number(await appendAudit(h.db, { kind: "issue", workspaceSlug: "acme", outcome: "failed", error: "scoped" }));
    const old = await appendAudit(h.db, { kind: "credentials", outcome: "failed", error: "old" });
    await h.db.query("UPDATE audit_log SET created_at = now() - interval '25 hours' WHERE id = $1", [old]);
    const page = await (await h.call("GET", "/instance/audit?errors=1&hours=24", { cookie: INST })).json() as AuditPage;
    deepStrictEqual(page.entries.map((row) => row.id), [global]);
    const all = await (await h.call("GET", "/instance/audit?errors=1&hours=24&scope=all&limit=1", { cookie: INST })).json() as AuditPage;
    deepStrictEqual(all.entries.map((row) => row.id), [scoped]); strictEqual(all.nextBefore, scoped);
    const more = await (await h.call("GET", `/instance/audit?errors=1&hours=24&scope=all&limit=1&before=${all.nextBefore}`, { cookie: INST })).json() as AuditPage;
    deepStrictEqual(more.entries.map((row) => row.id), [global]);
    const health = await (await h.call("GET", "/instance/health", { cookie: INST })).json() as any;
    strictEqual(health.failuresLast24h, 2);
    strictEqual((await h.call("GET", "/instance/audit", { cookie: ADM })).status, 401);
    const own = await (await h.call("GET", "/workspaces/acme/audit?scope=all", { cookie: ADM })).json() as AuditPage;
    deepStrictEqual(own.entries.map((row) => row.id), [scoped]);
  } finally { await h.close(); }
});

test("N6: signed-commit default uses migration 010 helpers, preserves omissions and refuses member/CSRF writes", async () => {
  const h = await setup([], undefined, undefined, { requireVerifiedCommitsDefault: true });
  try {
    strictEqual((await (await h.call("GET", "/instance/settings", { cookie: INST })).json() as any).requireVerifiedCommits, true);
    strictEqual((await h.call("PUT", "/instance/settings", { cookie: INST, body: { requireVerifiedCommits: false } })).status, 200);
    strictEqual(await readRequireVerifiedCommits(h.db, true), false);
    await h.call("PUT", "/instance/settings", { cookie: INST, body: { smartCommitsDefault: false } });
    strictEqual(await readRequireVerifiedCommits(h.db, true), false);
    strictEqual((await h.call("PUT", "/instance/settings", { cookie: MEM, body: { requireVerifiedCommits: true } })).status, 401);
    strictEqual((await h.call("PUT", "/instance/settings", { cookie: INST, origin: "https://other.test", body: { requireVerifiedCommits: true } })).status, 403);
    throws(() => parseInstanceSettings({ requireVerifiedCommits: "true" }));
  } finally { await h.close(); }
});

test("N5: setup checklist uses live event check and resolved active-member counts; setup detail is instance-admin only", async () => {
  const h = await setup([], undefined, undefined, { planeDirectory: { listAll: async () => [{ id: "u-adm", display_name: "Admin", is_active: true }, { id: "u-mem", display_name: "Member", is_active: true }] as any, listStates: async () => [] },
    setupCheck: async () => ({ checkedAt: new Date().toISOString(), ok: true, checks: [{ id: "github_events", title: "Events", status: "pass", detail: "Verified", runbookAnchor: "events", data: {} }] }) });
  try {
    await link(h);
    const health = await (await h.call("GET", "/workspaces/acme/health", { cookie: ADM })).json() as WorkspaceHealth;
    strictEqual(health.setup.membersLinked, 1); strictEqual(health.setup.membersTotal, 2); strictEqual(health.setup.appEventsVerified, true);
    strictEqual(health.setup.rules, "defaults"); strictEqual(health.setup.policies, "defaults");
    strictEqual((await h.call("GET", "/instance/setup-check", { cookie: INST })).status, 200);
    strictEqual((await h.call("GET", "/instance/setup-check", { cookie: ADM })).status, 401);
  } finally { await h.close(); }
});

test("N5: API forwards a resumable backfill cursor, skipping completed PR listing", async () => {
  const calls: { route: string; page: unknown }[] = [];
  const h = await setup([], { enqueue: async () => {}, resolveIssue: async () => null, githubFor: async () => ({ request: async (route, params) => {
    calls.push({ route, page: params?.page }); return { data: [], headers: {} };
  } }) });
  try {
    const id = await mapping(h);
    // Audit S5: backfill reads GitHub only through the mapping's installation while it is allow-listed for this workspace.
    strictEqual((await h.call("POST", `/workspaces/acme/mappings/${id}/backfill`, { cookie: ADM })).status, 403);
    deepStrictEqual(calls, []);
    await h.db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (1, 'acme')");
    const response = await h.call("POST", `/workspaces/acme/mappings/${id}/backfill`, { cookie: ADM, body: { cursor: { pullRequestsPage: null, issuesPage: 51 } } });
    strictEqual(response.status, 200); const result = await response.json() as BackfillResult;
    deepStrictEqual(calls, [{ route: "GET /repos/{owner}/{repo}/issues", page: 51 }]);
    strictEqual(result.pullRequests, 0); strictEqual(result.issues, 0); ok(result.complete !== false);
  } finally { await h.close(); }
});

test("C1/C2: registered routes grant members only their own OAuth flow and protect admin connects with CSRF", async () => {
  const f = githubFixture(); const h = await setup([], undefined, undefined, f.deps);
  try {
    strictEqual((await h.call("GET", "/workspaces/acme/github/account", { cookie: MEM })).status, 200);
    strictEqual((await h.call("GET", "/workspaces/acme/github/connection", { cookie: MEM })).status, 403);
    strictEqual((await h.call("POST", "/workspaces/acme/github/connect", { cookie: MEM })).status, 403);
    strictEqual((await h.call("POST", "/workspaces/acme/github/account/connect", { cookie: MEM, origin: "https://foreign.test" })).status, 403);
    const auth = await h.call("POST", "/workspaces/acme/github/account/connect", { cookie: MEM });
    strictEqual(auth.status, 200); const url = new URL((await auth.json() as any).authorizeUrl);
    strictEqual(url.searchParams.get("code_challenge_method"), "S256");
    const row = (await h.db.query<any>("SELECT plane_user_id, purpose FROM oauth_states")).rows[0];
    strictEqual(row.plane_user_id, "u-mem"); strictEqual(row.purpose, "oauth");
    const install = await h.call("POST", "/workspaces/acme/github/connect", { cookie: ADM });
    strictEqual(install.status, 200); ok((await install.json() as any).installUrl.includes("/apps/sync-app/installations/new"));
    // Audit S3: a hand-off must name its organization; a login is resolved to its GitHub id.
    strictEqual((await h.call("POST", "/workspaces/acme/github/connect/handoff", { cookie: ADM })).status, 422);
    const handoff = await h.call("POST", "/workspaces/acme/github/connect/handoff", { cookie: ADM, body: { accountLogin: "acme" } });
    strictEqual(handoff.status, 200); ok(new Date((await handoff.json() as any).expiresAt).getTime() > Date.now() + 6 * 86400000);
    await link(h, "u-mem");
    strictEqual((await h.call("DELETE", "/workspaces/acme/github/account", { cookie: MEM })).status, 204);
    strictEqual(await getGithubOAuthToken(h.db, "u-mem"), null);
  } finally { await h.close(); }
});

test("C1 owner policy: pending-request handoff binds the organization and rejects malformed, member and cross-site writes", async () => {
  const f = githubFixture(); const h = await setup([], undefined, undefined, f.deps);
  try {
    await link(h);
    const view = await (await h.call("GET", "/workspaces/acme/github/connection", { cookie: ADM })).json() as any;
    strictEqual(view.pendingRequests[0].accountId, 100);
    const response = await h.call("POST", "/workspaces/acme/github/connect/handoff", { cookie: ADM, body: { accountId: view.pendingRequests[0].accountId } });
    strictEqual(response.status, 200);
    const url = new URL((await response.json() as any).link);
    const state = await consumeOAuthState(h.db, url.searchParams.get("state")!, "install");
    ok(state); strictEqual(state.workspaceSlug, "acme");
    deepStrictEqual(parseHandoff(state.planeUserId), { adminPlaneUserId: "u-adm", accountId: 100 });
    strictEqual(await consumeOAuthState(h.db, url.searchParams.get("state")!, "install"), null);
    for (const body of [{ accountId: null }, { accountId: "100" }, { accountId: 0 }, { accountId: -1 }, { accountId: 1.1 }, { accountId: Number.MAX_SAFE_INTEGER + 1 }, { accountId: 100, workspaceSlug: "other" }, {}, { accountId: 100, accountLogin: "acme" }, { accountLogin: "not a login" }]) {
      strictEqual((await h.call("POST", "/workspaces/acme/github/connect/handoff", { cookie: ADM, body })).status, 422);
      throws(() => parseOwnerHandoff(body));
    }
    strictEqual((await h.call("POST", "/workspaces/acme/github/connect/handoff", { cookie: MEM, body: { accountId: 100 } })).status, 403);
    strictEqual((await h.call("POST", "/workspaces/acme/github/connect/handoff", { cookie: ADM, origin: "https://foreign.test", body: { accountId: 100 } })).status, 403);
    strictEqual(await h.count("oauth_states"), 1, "refused requests do not create extra handoff capabilities");
    // Audit S3 replaced "binding stays optional for the generic owner link": an unbound link let its holder claim any
    // installation whose owner had already authorized the App. The generic link now names the organization by login.
    strictEqual((await h.call("POST", "/workspaces/acme/github/connect/handoff", { cookie: ADM, body: {} })).status, 422);
    strictEqual(await h.count("oauth_states"), 1);
  } finally { await h.close(); }
});

test("C1 owner policy: claimable flags and claim refusal reasons reflect organization ownership, independent of repository triage", async () => {
  const f = githubFixture(); f.state.ownerRole = "member";
  const h = await setup([], undefined, undefined, f.deps);
  try {
    await link(h);
    const listing = await (await h.call("GET", "/workspaces/acme/github/claimable", { cookie: ADM })).json() as any;
    strictEqual(listing.installations[0].canClaim, false);
    const refused = await h.call("POST", "/workspaces/acme/github/installations/1/claim", { cookie: ADM });
    strictEqual(refused.status, 403); const denied = await refused.json() as any;
    strictEqual(denied.reason, "not_owner"); ok(denied.error.includes("organization owner"));
    strictEqual((await h.db.query<any>("SELECT account_login FROM workspace_installations WHERE installation_id = 1")).rows[0].account_login, null);
    const forged = await h.call("POST", "/workspaces/acme/github/installations/2/claim", { cookie: ADM });
    strictEqual(forged.status, 403); strictEqual((await forged.json() as any).reason, "not_yours");
    f.state.accountType = "Enterprise";
    const unsupported = await h.call("POST", "/workspaces/acme/github/installations/1/claim", { cookie: ADM });
    strictEqual(unsupported.status, 403); strictEqual((await unsupported.json() as any).reason, "unsupported_account");
    f.state.accountType = "Organization"; f.state.ownerRole = "admin";
    const owner = await (await h.call("GET", "/workspaces/acme/github/claimable", { cookie: ADM })).json() as any;
    strictEqual(owner.installations[0].canClaim, true);
    strictEqual((await h.call("POST", "/workspaces/acme/github/installations/1/claim", { cookie: ADM })).status, 200);
    strictEqual(await h.count("workspace_installations"), 1);
  } finally { await h.close(); }
});

test("C1 owner policy: the browser API preserves structured claim refusal reasons", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => json({ error: "Only an organization owner may connect", reason: "not_owner" }, 403)) as typeof fetch;
  try {
    await rejects(() => api("POST", "/workspaces/acme/github/installations/1/claim"), (error: unknown) => {
      ok(error instanceof ApiError); strictEqual(error.status, 403); strictEqual(error.reason, "not_owner");
      strictEqual(error.message, "Only an organization owner may connect"); return true;
    });
  } finally { globalThis.fetch = original; }
});

test("C1/C2: browser callbacks are registered outside /api and return a visible UI status with single-use state", async () => {
  const f = githubFixture(); const h = await setup([], undefined, undefined, f.deps);
  try {
    await createOAuthState(h.db, { nonce: "a".repeat(43), purpose: "oauth", workspaceSlug: "acme", planeUserId: "u-mem", ttlSeconds: 600, pkceVerifierCiphertext: encryptSecret("verifier", KEY) });
    const headers = { cookie: MEM };
    const response = await fetch(`${h.base}/git-sync/oauth/github/callback?state=${"a".repeat(43)}&error=access_denied`, { headers, redirect: "manual" });
    strictEqual(response.status, 302); strictEqual(response.headers.get("referrer-policy"), "no-referrer"); const location = new URL(response.headers.get("location")!);
    strictEqual(location.pathname, "/git-sync/ui/workspaces/acme/account"); strictEqual(location.searchParams.get("reason"), "denied");
    const replay = await fetch(`${h.base}/git-sync/oauth/github/callback?state=${"a".repeat(43)}`, { headers, redirect: "manual" });
    strictEqual(new URL(replay.headers.get("location")!).searchParams.get("reason"), "state");
    const routes = createConfigRoutes({ db: h.db, planeInternalUrl: h.plane.url, tokenKey: KEY, publicOrigin: ORIGIN, ...f.deps });
    ok(routes.some((route) => route.path === "/git-sync/install/github/callback"));
  } finally { await h.close(); }
});

test("C3: save rechecks user-scoped access, canonicalizes the name, and permits manual IDs only through instance admin", async () => {
  const f = githubFixture(); const h = await setup([], undefined, undefined, f.deps);
  try {
    strictEqual((await h.call("POST", "/workspaces/acme/mappings", { cookie: ADM, body: MAPPING })).status, 409);
    await link(h);
    const choices = await h.call("GET", "/workspaces/acme/github/repositories", { cookie: ADM });
    strictEqual(choices.status, 200); strictEqual((await choices.json() as any).repositories[0].id, 555);
    f.state.allowRepo = false;
    strictEqual((await h.call("POST", "/workspaces/acme/mappings", { cookie: ADM, body: MAPPING })).status, 403);
    strictEqual(await h.count("repo_mappings"), 0);
    f.state.allowRepo = true;
    const created = await h.call("POST", "/workspaces/acme/mappings", { cookie: ADM, body: { ...MAPPING, ghRepoFullName: "wrong/name" } });
    strictEqual(created.status, 201); const id = (await created.json() as any).id;
    strictEqual((await h.db.query<any>("SELECT gh_repo_full_name FROM repo_mappings WHERE id = $1", [id])).rows[0].gh_repo_full_name, "acme/web");
    f.state.allowRepo = false;
    strictEqual((await h.call("PATCH", `/workspaces/acme/mappings/${id}`, { cookie: ADM, body: { smartCommitsEnabled: false } })).status, 200,
      "changing settings retains App authority without requiring personal GitHub access");
    strictEqual((await h.call("PATCH", `/workspaces/acme/mappings/${id}`, { cookie: ADM, body: { ghRepoId: 555, linkbackComments: false } })).status, 200,
      "resending the unchanged repository ID does not require personal access");
    strictEqual((await h.call("PATCH", `/workspaces/acme/mappings/${id}`, { cookie: ADM, body: { ghRepoId: 556, ghRepoFullName: "acme/other" } })).status, 403,
      "switching repository still rechecks user access");
    strictEqual((await h.call("POST", "/instance/workspaces/acme/mappings", { cookie: ADM, body: { ...MAPPING, planeProjectId: "p2" } })).status, 401);
    strictEqual((await h.call("POST", "/instance/workspaces/acme/mappings", { cookie: INST, body: { ...MAPPING, planeProjectId: "p2" } })).status, 201);
    ok(f.state.calls.filter((path) => path.endsWith("/repositories")).length >= 4);
  } finally { await h.close(); }
});

test("C2 review: admin unlink revokes the grant, audits remote failure and always removes local credentials", async () => {
  for (const remoteStatus of [204, 500]) {
    const f = githubFixture(); f.state.revokeStatus = remoteStatus;
    const h = await setup([], undefined, undefined, f.deps);
    try {
      await link(h, "u-mem");
      await h.db.query("INSERT INTO user_tokens (plane_user_id, kind, ciphertext) VALUES ('u-mem','plane_pat',$1)", [encryptSecret("plane-token", KEY)]);
      h.plane.roles["u-adm"]!.other = 20;
      strictEqual((await h.call("DELETE", "/workspaces/other/user-links/u-mem", { cookie: ADM })).status, 404);
      strictEqual(f.state.calls.length, 0, "an admin cannot revoke a token via a workspace that has no link");
      ok(await getGithubOAuthToken(h.db, "u-mem"));
      strictEqual((await h.call("DELETE", "/workspaces/acme/user-links/u-mem", { cookie: ADM, origin: "https://foreign.test" })).status, 403);
      strictEqual(f.state.calls.length, 0);
      strictEqual((await h.call("DELETE", "/workspaces/acme/user-links/u-mem", { cookie: ADM })).status, 204);
      ok(f.state.calls.includes("/applications/Iv1.client/grant"));
      strictEqual(await getGithubOAuthToken(h.db, "u-mem"), null);
      strictEqual((await h.db.query("SELECT 1 FROM user_tokens WHERE plane_user_id = 'u-mem'")).rows.length, 0);
      strictEqual((await h.db.query("SELECT 1 FROM user_map WHERE workspace_slug = 'acme' AND plane_user_id = 'u-mem'")).rows.length, 0);
      const failures = (await h.db.query<any>("SELECT workspace_slug, detail FROM audit_log WHERE kind = 'github_grant_revoke_failed'")).rows;
      strictEqual(failures.length, remoteStatus === 500 ? 1 : 0);
      if (failures.length) { strictEqual(failures[0].workspace_slug, "acme"); strictEqual(failures[0].detail.planeUserId, "u-mem"); }
      strictEqual((await h.call("DELETE", "/workspaces/acme/user-links/u-mem", { cookie: ADM })).status, 404);
    } finally { await h.close(); }
  }
});

// Audit S6: Plane's members list includes removed members, so one workspace's admin could link, then unlink, anyone who
// ever belonged there and so revoke the GitHub grant every other workspace relies on.
test("S6: an admin unlink keeps a grant that another workspace still links, unless the admin unlinks themself", async () => {
  const f = githubFixture();
  const h = await setup([], undefined, undefined, f.deps);
  try {
    await link(h, "u-mem");
    await h.db.query("INSERT INTO user_map (workspace_slug, plane_user_id, gh_login, gh_id) VALUES ('other','u-mem','octo',77)");
    strictEqual((await h.call("DELETE", "/workspaces/acme/user-links/u-mem", { cookie: ADM })).status, 204);
    ok(!f.state.calls.includes("/applications/Iv1.client/grant"), "no GitHub revocation for a user another workspace links");
    ok(await getGithubOAuthToken(h.db, "u-mem"), "the shared token survives");
    strictEqual((await h.db.query("SELECT 1 FROM user_map WHERE workspace_slug = 'acme' AND plane_user_id = 'u-mem'")).rows.length, 0);
    strictEqual((await h.db.query("SELECT 1 FROM user_map WHERE workspace_slug = 'other' AND plane_user_id = 'u-mem'")).rows.length, 1);

    // Positive control: an admin unlinking themself still revokes, even while another workspace links them.
    await link(h, "u-adm");
    await h.db.query("INSERT INTO user_map (workspace_slug, plane_user_id, gh_login, gh_id) VALUES ('other','u-adm','octo-adm',78)");
    strictEqual((await h.call("DELETE", "/workspaces/acme/user-links/u-adm", { cookie: ADM })).status, 204);
    ok(f.state.calls.includes("/applications/Iv1.client/grant"));
    strictEqual(await getGithubOAuthToken(h.db, "u-adm"), null);
  } finally { await h.close(); }
});

test("C2 review: callback internal failures log only the failure message and redirect with no-referrer", async () => {
  const f = githubFixture();
  const h = await setup([], undefined, undefined, { ...f.deps, db: { query: async () => { throw new Error("database offline"); }, exec: async () => {} } });
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args) => { logged.push(args); };
  try {
    for (const [path, flag] of [["oauth", "github"], ["install", "connect"]]) {
      const response = await fetch(`${h.base}/git-sync/${path}/github/callback?code=private-code&state=private-state`, { headers: { cookie: MEM }, redirect: "manual" });
      strictEqual(response.status, 302);
      strictEqual(response.headers.get("referrer-policy"), "no-referrer");
      strictEqual(response.headers.get("cache-control"), "no-store");
      const redirected = new URL(response.headers.get("location")!);
      strictEqual(redirected.origin, ORIGIN); strictEqual(redirected.searchParams.get(flag!), "error");
      strictEqual(redirected.searchParams.get("reason"), "internal");
      ok(!redirected.searchParams.has("code") && !redirected.searchParams.has("state"));
      strictEqual(await response.text(), "");
    }
    const output = JSON.stringify(logged);
    ok(output.includes("database offline")); ok(!output.includes("private-code")); ok(!output.includes("private-state")); ok(!output.includes("callback?"));
  } finally { console.error = original; await h.close(); }
});

test("C2 review: a callback failure after authentication returns to the member page", async () => {
  const f = githubFixture();
  let delegate: Awaited<ReturnType<typeof setup>>["db"] | undefined;
  const h = await setup([], undefined, undefined, { ...f.deps, db: {
    query: async (text, params) => {
      if (text.includes("SELECT client_id")) throw new Error("App configuration unavailable");
      return delegate!.query(text, params);
    }, exec: async (text) => delegate!.exec(text),
  } });
  delegate = h.db;
  const original = console.error;
  const messages: unknown[][] = [];
  console.error = (...args) => { messages.push(args); };
  try {
    const nonce = "b".repeat(43);
    await createOAuthState(h.db, { nonce, purpose: "oauth", workspaceSlug: "acme", planeUserId: "u-mem", ttlSeconds: 600, pkceVerifierCiphertext: encryptSecret("verifier", KEY) });
    const response = await fetch(`${h.base}/git-sync/oauth/github/callback?code=private-code&state=${nonce}`, { headers: { cookie: MEM }, redirect: "manual" });
    strictEqual(response.status, 302);
    const location = new URL(response.headers.get("location")!);
    strictEqual(location.pathname, "/git-sync/ui/workspaces/acme/account");
    strictEqual(location.searchParams.get("github"), "error"); strictEqual(location.searchParams.get("reason"), "internal");
    ok(JSON.stringify(messages).includes("App configuration unavailable")); ok(!JSON.stringify(messages).includes(nonce));
  } finally { console.error = original; await h.close(); }
});

test("C3 review: an unlinked admin may toggle an existing mapping but cannot switch its repository", async () => {
  let verifications = 0;
  const h = await setup([], undefined, async (check) => { verifications++; check.onInstallationVerified?.(1); return null; });
  try {
    const id = await mapping(h);
    strictEqual((await h.call("PATCH", `/workspaces/acme/mappings/${id}`, { cookie: ADM, body: { ghRepoId: 555, smartCommitsEnabled: false, linkbackComments: false } })).status, 200);
    strictEqual(verifications, 1, "the existing installation/project authority is still checked");
    const row = (await h.db.query<any>("SELECT smart_commits_enabled, linkback_enabled FROM repo_mappings WHERE id = $1", [id])).rows[0];
    deepStrictEqual(row, { smart_commits_enabled: false, linkback_enabled: false });
    strictEqual((await h.call("PATCH", `/workspaces/acme/mappings/${id}`, { cookie: ADM, body: { ghRepoId: 556 } })).status, 503,
      "a changed repository fails closed when user-access verification is unavailable");
  } finally { await h.close(); }
});

test("C0/C2: App OAuth secret is encrypted and omitted secrets preserved; changing client ID without a secret is refused", async () => {
  const h = await setup();
  const body = { appId: 10, privateKey: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----", webhookSecret: "hook", clientId: "Iv1.client", clientSecret: "oauth-secret", appSlug: "sync-app", edition: "github" };
  try {
    strictEqual((await h.call("PUT", "/instance/github-app", { cookie: INST, body })).status, 200);
    const first = (await readGithubAppClient(h.db))!; ok(first.clientSecretCiphertext && !first.clientSecretCiphertext.includes("oauth-secret"));
    strictEqual((await h.call("PUT", "/instance/github-app", { cookie: INST, body: { appId: 10, clientSecret: "" } })).status, 200);
    strictEqual((await readGithubAppClient(h.db))!.clientSecretCiphertext, first.clientSecretCiphertext);
    strictEqual((await h.call("PUT", "/instance/github-app", { cookie: INST, body: { appId: 10, clientId: "different" } })).status, 422);
    strictEqual((await readGithubAppClient(h.db))!.clientId, "Iv1.client");
    const info = await (await h.call("GET", "/instance/github-app", { cookie: INST })).json() as any;
    strictEqual(info.clientSecretConfigured, true); ok(!JSON.stringify(info).includes("oauth-secret")); ok(!Object.hasOwn(info, "clientSecretCiphertext"));
    const cloud = parseGithubApp({ appId: 10, edition: "ghe_cloud", gheSubdomain: "octocorp" });
    strictEqual(cloud.gheBaseUrl, "https://api.octocorp.ghe.com"); strictEqual(cloud.gheSubdomain, "octocorp");
    throws(() => parseGithubApp({ appId: 10, edition: "ghe_cloud" }));
  } finally { await h.close(); }
});

test("Guidance: mapping PATCH rejects a repository changed after the access-check snapshot", async () => {
  let concurrentChange: (() => Promise<void>) | undefined;
  const h = await setup([], undefined, async (check) => {
    check.onInstallationVerified?.(1);
    await concurrentChange?.();
    return null;
  });
  try {
    const id = await mapping(h);
    concurrentChange = async () => { await h.db.query("UPDATE repo_mappings SET gh_repo_id = 777, gh_repo_full_name = 'acme/other' WHERE id = $1", [id]); };
    const response = await h.call("PATCH", `/workspaces/acme/mappings/${id}`, { cookie: ADM, body: { ghRepoId: 555, smartCommitsEnabled: false } });
    strictEqual(response.status, 409);
    const row = (await h.db.query<any>("SELECT gh_repo_id, gh_repo_full_name, smart_commits_enabled FROM repo_mappings WHERE id = $1", [id])).rows[0];
    strictEqual(Number(row.gh_repo_id), 777); strictEqual(row.gh_repo_full_name, "acme/other"); strictEqual(row.smart_commits_enabled, true);
  } finally { await h.close(); }
});

test("Guidance: callback diagnostics redact artifacts even when an exception embeds them", async () => {
  const f = githubFixture();
  const h = await setup([], undefined, undefined, { ...f.deps, db: {
    query: async () => { throw new Error("Failure at https://tasks.example.test/git-sync/oauth/github/callback?code=private-code&state=private-state; code private-code state private-state"); },
    exec: async () => {},
  } });
  const original = console.error;
  const logs: unknown[][] = [];
  console.error = (...args) => { logs.push(args); };
  try {
    const response = await fetch(`${h.base}/git-sync/oauth/github/callback?code=private-code&state=private-state`, { headers: { cookie: MEM }, redirect: "manual" });
    strictEqual(response.status, 302);
    const message = JSON.stringify(logs);
    ok(message.includes("Failure at")); ok(message.includes("[redacted]"));
    ok(!message.includes("private-code")); ok(!message.includes("private-state")); ok(!message.includes("https://"));
  } finally { console.error = original; await h.close(); }
});

test("C4 seam: mapping API validates, stores and clears project states without changing repository authority", async () => {
  const h = await setup([], undefined, undefined, { planeDirectory: {
    listAll: async () => [] as any,
    listStates: async (_slug, project) => project === "p1" ? [
      { id: "open", name: "Ready", group: "unstarted" }, { id: "closed", name: "Done", group: "completed" },
      { id: "triage", name: "Triage", group: "triage" },
    ] : [{ id: "other-open", name: "Ready", group: "unstarted" }],
  } });
  try {
    const created = await h.call("POST", "/instance/workspaces/acme/mappings", { cookie: INST, body: { ...MAPPING, openStateId: "open", closedStateId: "closed" } });
    strictEqual(created.status, 201); const id = (await created.json() as any).id;
    const mappings = await (await h.call("GET", "/workspaces/acme/mappings", { cookie: ADM })).json() as any[];
    strictEqual(mappings[0].openStateId, "open"); strictEqual(mappings[0].closedStateId, "closed");
    const path = `/workspaces/acme/mappings/${id}`;
    for (const bad of [{ openStateId: "triage" }, { closedStateId: "other-open" }, { openStateId: "closed" }]) {
      strictEqual((await h.call("PATCH", path, { cookie: ADM, body: bad })).status, 422);
    }
    strictEqual((await h.call("PATCH", path, { cookie: ADM, body: { linkbackComments: false } })).status, 200);
    const preserved = (await h.db.query<any>("SELECT open_state_id, closed_state_id FROM repo_mappings WHERE id = $1", [id])).rows[0];
    deepStrictEqual(preserved, { open_state_id: "open", closed_state_id: "closed" });
    const moved = await h.call("PATCH", path, { cookie: ADM, body: { planeProjectId: "p2" } });
    strictEqual(moved.status, 200); const result = await moved.json() as any;
    strictEqual(result.openStateId, null); strictEqual(result.closedStateId, null);
    strictEqual((await h.call("PATCH", path, { cookie: ADM, body: { openStateId: "open" } })).status, 422);
    strictEqual((await h.call("PATCH", path, { cookie: ADM, body: { openStateId: "other-open", closedStateId: null } })).status, 200);
    strictEqual((await h.call("PATCH", path, { cookie: ADM, body: { openStateId: "" } })).status, 200);
    strictEqual((await h.db.query<any>("SELECT open_state_id FROM repo_mappings WHERE id = $1", [id])).rows[0].open_state_id, null);
    throws(() => parseMappingInput({ openStateId: "x", closedStateId: "x" }, true));
    throws(() => parseMappingInput({ openStateId: "bad/characters" }, true));
  } finally { await h.close(); }
});

test("N1/C2/N3: UI router preserves error filters and reaches member/development pages", () => {
  deepStrictEqual(parseLocation("/git-sync/ui/workspaces/acme/audit?mappingId=7&errors=1&hours=24"), { name: "audit", slug: "acme", filters: { mappingId: 7, errorsOnly: true, hours: 24 } });
  deepStrictEqual(parseLocation("/git-sync/ui/admin/audit?errors=1&hours=24&scope=all"), { name: "admin", tab: "audit", filters: { errorsOnly: true, hours: 24, allWorkspaces: true } });
  deepStrictEqual(parseLocation("/git-sync/ui/workspaces/acme/account?github=linked"), { name: "account", slug: "acme" });
  deepStrictEqual(parseLocation("/git-sync/ui/workspaces/acme/projects/p1/work-items/i1/development"), { name: "development", slug: "acme", projectId: "p1", issueId: "i1" });
});

test("N1/N5/N6/C1-C3: actual UI renders health links, banners, first-run offer, signed setting and connection controls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "parity2-g5-ui-"));
  try {
    await symlink(resolve(import.meta.dirname, "../../node_modules"), join(dir, "node_modules"), "dir");
    const outfile = join(dir, "ui.mjs");
    await build({ stdin: { contents: 'export * from "./src/ui/client/health.tsx"; export * from "./src/ui/client/Connect.tsx"; export * from "./src/ui/client/Workspace.tsx"; export * from "./src/ui/client/Admin.tsx";', resolveDir: resolve(import.meta.dirname, "../.."), loader: "tsx" }, outfile, bundle: true, packages: "external", platform: "node", format: "esm", jsx: "automatic", logLevel: "silent" });
    const ui = await import(pathToFileURL(outfile).href) as typeof import("../../src/ui/client/health.tsx") & typeof import("../../src/ui/client/Connect.tsx") & typeof import("../../src/ui/client/Workspace.tsx") & typeof import("../../src/ui/client/Admin.tsx");
    const render = (component: any, props: any) => renderToStaticMarkup(createElement(component, props));
    const health: MappingHealth = { mappingId: 7, lastGithubDeliveryAt: null, lastPlaneDeliveryAt: null, lastSuccessfulWriteAt: null, failuresLast24h: 3, disabledReason: "Installation removed", rateLimitedUntil: "2026-10-12T12:00:00Z" };
    const card = render(ui.MappingHealthCard, { slug: "acme", health });
    for (const label of ["Last GitHub delivery", "Last Plane delivery", "Last successful write", "Disabled", "Installation removed", "Rate-limited until"]) ok(card.includes(label), label);
    ok(card.includes("mappingId=7&amp;errors=1&amp;hours=24"));
    const banners = render(ui.WorkspaceHealthBanners, { health: { database: true, planeWebhookSilent: true, githubAppCredentials: { decryptOk: false } } });
    ok(banners.includes("stopped arriving")); ok(banners.includes("could not be decrypted"));
    const checklist = render(ui.SetupChecklist, { slug: "acme", setup: { rules: "defaults", policies: "defaults", membersLinked: 1, membersTotal: 2, appEventsVerified: true } });
    ok(checklist.includes("1 linked of 2")); ok(checklist.includes("App events: verified"));
    ok(render(ui.BackfillPanel, { slug: "acme", id: 7, offer: true }).includes("Link existing open PRs and issues now"));
    const partial = render(ui.BackfillControls, { offer: true, busy: false, result: { pullRequests: 5000, issues: 0, linked: 0, unresolved: 0, complete: false, cursor: { pullRequestsPage: 51, issuesPage: null } }, onStart() {}, onContinue() {} });
    ok(partial.includes(">Continue</button>"));
    const completed = render(ui.BackfillControls, { offer: false, busy: false, result: { pullRequests: 0, issues: 0, linked: 0, unresolved: 0 }, onStart() {}, onContinue() {} });
    ok(!completed.includes(">Continue</button>"));
    const settings = render(ui.SettingsFields, { initial: { smartCommitsDefault: true, requireVerifiedCommits: true, reconciliationIntervalMinutes: 15, opTtlMinutes: 60 } });
    ok(settings.includes("Require signed commits for Smart Commits")); strictEqual((settings.match(/checked=""/g) ?? []).length, 2);
    const personal = render(ui.PersonalAccountCard, { slug: "acme", personal: { appConfigured: true, linked: true, tokenStored: true, needsReauth: true, githubLogin: "octo", githubId: 77 }, busy: false, onConnect() {}, onDisconnect() {} });
    ok(personal.includes("Needs re-authorization")); ok(personal.includes("Reconnect")); ok(personal.includes("Disconnect personal account"));
    const org = render(ui.OrganisationCard, { item: { installationId: 1, accountLogin: "Acme", accountType: "Organization", avatarUrl: "https://avatars.example/acme", htmlUrl: "https://github.com/settings/installations/1" }, busy: false, onDisconnect() {} });
    ok(org.includes("Acme")); ok(org.includes("Disconnect")); ok(org.includes("<img"));
    const handoff = render(ui.OwnerHandoffDialog, { link: "https://github.com/apps/sync/installations/new?state=s", expiresAt: "2026-10-19T12:00:00Z", onClose() {} });
    ok(handoff.includes('role="dialog"')); ok(handoff.includes("Copy link"));
    const picker = render(ui.RepositoryPicker, { repositories: [{ id: 555, fullName: "acme/web", private: true, installationId: 1, permissions: { pull: true } }], value: 555, onChange() {} });
    ok(picker.includes("acme/web (private)")); ok(picker.includes('value="555" selected=""')); ok(!picker.includes('<input'));
    const healthPanel = render(ui.HealthPanel, { state: { loading: false, data: { database: true, githubAppConfigured: true, mappings: 1, lastActivityAt: null, failuresLast24h: 3 }, error: null, reload() {} } });
    ok(healthPanel.includes("admin/audit?errors=1&amp;hours=24&amp;scope=all"));
    ok(ui.connectionNotice("github=error&reason=state")!.includes("expired"));
    ok(ui.connectionNotice("connect=handoff")!.includes("owner must complete"));
    const cannotClaim = render(ui.ClaimableList, { slug: "acme", list: [{ installationId: 2, accountLogin: "Org", avatarUrl: null, allowedForWorkspace: null, canClaim: false }], busy: false, onClaim() {}, onHandoff() {} });
    ok(cannotClaim.includes("Ask an organization owner to connect it")); ok(cannotClaim.includes("Send owner handoff link")); ok(!cannotClaim.includes("Finish connecting"));
    const canClaim = render(ui.ClaimableList, { slug: "acme", list: [{ installationId: 2, accountLogin: "Org", avatarUrl: null, allowedForWorkspace: null, canClaim: true }], busy: false, onClaim() {}, onHandoff() {} });
    ok(canClaim.includes("Finish connecting")); ok(!canClaim.includes("Send owner handoff link"));
    const pending = render(ui.PendingRequestsList, { requests: [{ id: 9, accountId: 100, accountLogin: "Org<script>", accountAvatarUrl: null, requesterLogin: "octo", createdAt: null }], busy: false, onHandoff() {} });
    ok(pending.includes("Org&lt;script&gt;")); ok(!pending.includes("<script>")); ok(pending.includes("Send owner handoff link"));
    const clicked: (number | undefined)[] = [];
    const pendingTree = ui.PendingRequestsList({ requests: [{ id: 9, accountId: 100, accountLogin: "Org", accountAvatarUrl: null, requesterLogin: "octo", createdAt: null }], busy: false, onHandoff: (id) => { clicked.push(id); } });
    const row = (pendingTree.props as any).children[0];
    const button = row.props.children.find((child: any) => child?.type === "button");
    button.props.onClick(); deepStrictEqual(clicked, [100]); deepStrictEqual(ui.ownerHandoffBody({ accountId: clicked[0] }), { accountId: 100 });
    // Audit S3: no body without an organization; a typed login is sent trimmed for the server to resolve.
    strictEqual(ui.ownerHandoffBody({ accountId: null }), null); strictEqual(ui.ownerHandoffBody({ accountLogin: "  " }), null);
    deepStrictEqual(ui.ownerHandoffBody({ accountLogin: " acme " }), { accountLogin: "acme" });
    const reasons = { not_yours: "cannot access", not_owner: "owner or admin", wrong_account: "different GitHub organization", unsupported_account: "not supported", taken: "another workspace", github: "try again", not_configured: "configure", installation: "valid installation", state: "expired", denied: "declined" };
    for (const [reason, phrase] of Object.entries(reasons)) {
      ok(ui.connectionNotice(`connect=error&reason=${reason}`)!.includes(phrase), reason);
      const notice = ui.connectionNotice(`connect=error&reason=${reason}&via=handoff`)!;
      ok(notice.includes("owner handoff")); ok(notice.includes(phrase), reason);
    }
    ok(ui.connectionNotice("connect=ok&via=handoff")!.includes("account owner"));
    strictEqual(ui.connectionNotice("connect=error&reason=__proto__"), ui.connectionNotice("connect=error&reason=unknown"));
    strictEqual(ui.connectionNotice(""), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
