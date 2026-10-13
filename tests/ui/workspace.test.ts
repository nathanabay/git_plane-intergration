import test, { after, before } from "node:test";
import { strictEqual, ok, deepStrictEqual, rejects } from "node:assert/strict";
import { ADM, KEY, MAPPING, MEM, setup } from "./harness.ts";
import type { Harness } from "./harness.ts";
import { TokenVault } from "../../src/auth/identity.ts";
import { PgTokenStore } from "../../src/db/token-store.ts";
import { appendAudit } from "../../src/db/ledgers.ts";
import { encryptSecret } from "../../src/auth/identity.ts";
import { putGithubOAuthToken } from "../../src/db/parity.ts";
import type { MappingVerifier } from "../../src/ui/mapping-check.ts";

// C3 now proves the viewer's own repository access before the existing App/project verifier.
async function mappingHarness(verifyMapping?: MappingVerifier | null): Promise<Harness> {
  const repos = [{ id: 555, full_name: "acme/web" }, { id: 9, full_name: "acme/api" }, { id: 7, full_name: "acme/other" }, { id: 8, full_name: "acme/x" }];
  const h = await setup([], undefined, verifyMapping, {
    githubOAuthConfig: { GITHUB_CLIENT_ID: "Iv1.fixture", GITHUB_CLIENT_SECRET: "fixture-secret" },
    appRequest: async () => ({ data: [] }),
    fetch: (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.hostname !== "api.github.com") return fetch(url, init);
      strictEqual(new Headers(init?.headers).get("authorization"), "Bearer ghu-fixture");
      strictEqual(u.pathname, "/user/installations/1/repositories");
      return new Response(JSON.stringify({ total_count: repos.length, repositories: repos.map((repo) => ({ ...repo, permissions: { triage: true } })) }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  await h.db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (1,'acme')");
  await putGithubOAuthToken(h.db, "u-adm", { accessCiphertext: encryptSecret("ghu-fixture", KEY), refreshCiphertext: null, accessExpiresAt: null, refreshExpiresAt: null });
  return h;
}

let h: Harness;
let id: number;
before(async () => {
  h = await mappingHarness();
  const r = await h.call("POST", "/workspaces/acme/mappings", { cookie: ADM, body: MAPPING });
  strictEqual(r.status, 201, await r.clone().text());
  id = ((await r.json()) as { id: number }).id;
});
after(async () => { await h.close(); });

const P = (suffix: string) => `/workspaces/acme/mappings/${id}${suffix}`;

test("mappings: create stores the workspace and applies defaults (autolinks off, smart commits from instance default)", async () => {
  const row = (await h.db.query<any>(`SELECT * FROM repo_mappings WHERE id = $1`, [id])).rows[0];
  strictEqual(row.workspace_slug, "acme");
  strictEqual(row.autolinks_enabled, false);
  strictEqual(row.linkback_enabled, true);
  strictEqual((await h.call("PUT", "/instance/settings", { cookie: "admin-session-id=inst", body: { smartCommitsDefault: false } })).status, 200);
  const r = await h.call("POST", "/workspaces/acme/mappings", { cookie: ADM, body: { ghRepoId: 9, ghRepoFullName: "acme/api", planeProjectId: "p2" } });
  strictEqual(r.status, 201);
  const created = ((await r.json()) as { id: number }).id;
  const got = (await h.db.query<any>(`SELECT smart_commits_enabled, sync_direction FROM repo_mappings WHERE id = $1`, [created])).rows[0];
  strictEqual(got.smart_commits_enabled, false);
  strictEqual(got.sync_direction, "bidirectional");
});

test("mappings: list returns camelCase DTOs with numeric ids", async () => {
  const list = await (await h.call("GET", "/workspaces/acme/mappings", { cookie: ADM })).json() as any[];
  const m = list.find((x) => x.id === id);
  deepStrictEqual(m, { id, workspaceSlug: "acme", ghRepoId: 555, ghRepoFullName: "acme/web", planeProjectId: "p1",
    syncDirection: "bidirectional", smartCommitsEnabled: true, linkbackComments: true, autolinks: false, openStateId: null, closedStateId: null });
});

test("mappings: duplicates are 409", async () => {
  strictEqual((await h.call("POST", "/workspaces/acme/mappings", { cookie: ADM, body: MAPPING })).status, 409);
});

test("mappings: every invalid field is 422", async () => {
  const bad: unknown[] = [
    { ...MAPPING, syncDirection: "plane_to_github" },
    { ...MAPPING, ghRepoId: "555" },
    { ...MAPPING, ghRepoId: -1 },
    { ...MAPPING, ghRepoFullName: "no-slash" },
    { ...MAPPING, planeProjectId: "has space" },
    { ...MAPPING, smartCommitsEnabled: "yes" },
    { ...MAPPING, surprise: 1 },
    { planeProjectId: "p1" },
  ];
  for (const body of bad) strictEqual((await h.call("POST", "/workspaces/acme/mappings", { cookie: ADM, body })).status, 422, JSON.stringify(body));
});

test("mappings: PATCH updates only the given fields; an empty patch is 422", async () => {
  const r = await h.call("PATCH", P(""), { cookie: ADM, body: { autolinks: true, syncDirection: "github_to_plane" } });
  strictEqual(r.status, 200);
  const m = await r.json() as any;
  strictEqual(m.autolinks, true); strictEqual(m.syncDirection, "github_to_plane"); strictEqual(m.ghRepoFullName, "acme/web");
  strictEqual((await h.call("PATCH", P(""), { cookie: ADM, body: {} })).status, 422);
});

test("mappings: ids from another workspace and non-numeric ids are 404", async () => {
  h.plane.roles["u-adm"]!.third = 20;
  strictEqual((await h.call("PATCH", `/workspaces/third/mappings/${id}`, { cookie: ADM, body: { autolinks: true } })).status, 404);
  strictEqual((await h.call("DELETE", `/workspaces/third/mappings/${id}`, { cookie: ADM })).status, 404);
  strictEqual((await h.call("GET", `/workspaces/third/mappings/${id}/rules`, { cookie: ADM })).status, 404);
  strictEqual((await h.call("GET", `/workspaces/acme/mappings/abc/rules`, { cookie: ADM })).status, 404);
  strictEqual((await h.call("GET", `/workspaces/acme/mappings/99999/rules`, { cookie: ADM })).status, 404);
});

test("rules: invalid YAML is 422 carrying the engine's reason and stores nothing", async () => {
  const before = await h.count("rule_sets");
  const r = await h.call("PUT", P("/rules"), { cookie: ADM, body: { yaml: "- when: push\n  iff: {}\n" } });
  strictEqual(r.status, 422);
  ok(/index 0/.test(((await r.json()) as { error: string }).error));
  strictEqual((await h.call("PUT", P("/rules"), { cookie: ADM, body: { yaml: 5 } })).status, 422);
  strictEqual(await h.count("rule_sets"), before);
});

test("rules: every accepted save is a new version and GET returns the latest", async () => {
  strictEqual((await h.call("GET", P("/rules"), { cookie: ADM }).then((r) => r.json()) as any).version, 0);
  const a = "- when: pull_request.merged\n  then:\n    - set_state: Done\n";
  const b = "- when: pull_request.opened\n  then:\n    - set_state: Started\n";
  const v1 = await (await h.call("PUT", P("/rules"), { cookie: ADM, body: { yaml: a } })).json() as any;
  const v2 = await (await h.call("PUT", P("/rules"), { cookie: ADM, body: { yaml: b } })).json() as any;
  strictEqual(v2.version, v1.version + 1);
  const got = await (await h.call("GET", P("/rules"), { cookie: ADM })).json() as any;
  strictEqual(got.yaml, b); strictEqual(got.version, v2.version); strictEqual(got.updatedBy, "u-adm");
  strictEqual((await h.db.query(`SELECT 1 FROM rule_sets WHERE mapping_id = $1`, [id])).rows.length, 2);
});

test("rules: concurrent saves all succeed with distinct versions", async () => {
  const yaml = "- when: pull_request.closed_unmerged\n  then:\n    - set_state: Cancelled\n";
  const rs = await Promise.all([1, 2, 3, 4].map(() => h.call("PUT", P("/rules"), { cookie: ADM, body: { yaml } })));
  for (const r of rs) strictEqual(r.status, 200);
  const versions = (await h.db.query<{ version: number }>(`SELECT version FROM rule_sets WHERE mapping_id = $1`, [id])).rows.map((r) => Number(r.version));
  strictEqual(new Set(versions).size, versions.length);
});

test("policies: §7.3 defaults, partial update, unknown field or policy is 422", async () => {
  const def = await (await h.call("GET", P("/conflict-policies"), { cookie: ADM })).json() as any;
  deepStrictEqual(def, { title: "source_of_truth:github", description: "source_of_truth:github", state: "last_write_wins",
    assignees: "last_write_wins", labels: "last_write_wins", comments: "last_write_wins" });
  strictEqual((await h.call("PUT", P("/conflict-policies"), { cookie: ADM, body: { title: "whoever_shouts" } })).status, 422);
  strictEqual((await h.call("PUT", P("/conflict-policies"), { cookie: ADM, body: { colour: "last_write_wins" } })).status, 422);
  strictEqual((await h.call("PUT", P("/conflict-policies"), { cookie: ADM, body: {} })).status, 422);
  const r = await h.call("PUT", P("/conflict-policies"), { cookie: ADM, body: { title: "source_of_truth:plane", labels: "source_of_truth:github" } });
  strictEqual(r.status, 200);
  const got = await r.json() as any;
  strictEqual(got.title, "source_of_truth:plane"); strictEqual(got.labels, "source_of_truth:github"); strictEqual(got.state, "last_write_wins");
  strictEqual((await h.call("PUT", P("/conflict-policies"), { cookie: ADM, body: { title: "last_write_wins" } })).status, 200);
  strictEqual(((await h.call("GET", P("/conflict-policies"), { cookie: ADM }).then((x) => x.json())) as any).title, "last_write_wins");
});

test("user links: need both login and id; a duplicate GitHub id is 409; a member cannot link", async () => {
  strictEqual((await h.call("PUT", "/workspaces/acme/user-links/u-1", { cookie: ADM, body: { githubLogin: "octo" } })).status, 422);
  strictEqual((await h.call("PUT", "/workspaces/acme/user-links/u-1", { cookie: ADM, body: { githubLogin: "-bad-", githubId: 1 } })).status, 422);
  strictEqual((await h.call("PUT", "/workspaces/acme/user-links/u-1", { cookie: MEM, body: { githubLogin: "octo", githubId: 1 } })).status, 403);
  strictEqual((await h.call("PUT", "/workspaces/acme/user-links/u-1", { cookie: ADM, body: { githubLogin: "octo", githubId: 1 } })).status, 200);
  strictEqual((await h.call("PUT", "/workspaces/acme/user-links/u-2", { cookie: ADM, body: { githubLogin: "other", githubId: 1 } })).status, 409);
  strictEqual((await h.call("PUT", "/workspaces/acme/user-links/u-1", { cookie: ADM, body: { githubLogin: "octo2", githubId: 1 } })).status, 200);
  const list = await (await h.call("GET", "/workspaces/acme/user-links", { cookie: ADM })).json() as any[];
  deepStrictEqual(list, [{ planeUserId: "u-1", githubLogin: "octo2", githubId: 1, needsReauth: false }]);
});

test("user links: unlinking deletes the mapping and revokes that user's tokens, and only theirs", async () => {
  const vault = new TokenVault(new PgTokenStore(h.db), KEY);
  await vault.store("u-1", "plane_pat", "plane_api_SECRET");
  await vault.store("u-1", "github_oauth", "gho_SECRET");
  await vault.store("u-keep", "plane_pat", "plane_api_KEEP");
  strictEqual((await h.call("DELETE", "/workspaces/acme/user-links/u-1", { cookie: ADM })).status, 204);
  strictEqual(await vault.load("u-1", "plane_pat"), null);
  strictEqual(await vault.load("u-1", "github_oauth"), null);
  strictEqual((await vault.load("u-keep", "plane_pat"))?.reveal(), "plane_api_KEEP");
  strictEqual((await h.db.query(`SELECT 1 FROM user_map WHERE plane_user_id = 'u-1'`)).rows.length, 0);
});

test("user links: unlinking someone who is not linked here is 404 and revokes nothing", async () => {
  const vault = new TokenVault(new PgTokenStore(h.db), KEY);
  await vault.store("u-stranger", "plane_pat", "plane_api_X");
  strictEqual((await h.call("DELETE", "/workspaces/acme/user-links/u-stranger", { cookie: ADM })).status, 404);
  ok(await vault.load("u-stranger", "plane_pat"));
});

test("audit: newest first, paged by before, scoped to this workspace's entries", async () => {
  // C2/S6 can leave scoped grant-revocation diagnostics from an earlier unlink; those belong in this view too.
  const prior = (await h.db.query<{ id: number }>("SELECT id FROM audit_log WHERE workspace_slug = 'acme'")).rows.map((row) => Number(row.id));
  const expected = [...prior];
  for (let i = 0; i < 5; i++) expected.push(Number(await appendAudit(h.db, { kind: "rule.match", outcome: "ok", detail: { workspaceSlug: "acme", n: i } })));
  await appendAudit(h.db, { kind: "rule.match", outcome: "ok", detail: { workspaceSlug: "elsewhere" } });
  expected.push(Number(await appendAudit(h.db, { kind: "rule.match", outcome: "ok", detail: { mappingId: String(id) } })));
  await appendAudit(h.db, { kind: "webhook", outcome: "ok" });
  const page1 = await (await h.call("GET", "/workspaces/acme/audit?limit=3", { cookie: ADM })).json() as any;
  strictEqual(page1.entries.length, 3);
  ok(page1.entries[0].id > page1.entries[1].id);
  ok(page1.nextBefore !== null);
  const page2 = await (await h.call("GET", `/workspaces/acme/audit?limit=10&before=${page1.nextBefore}`, { cookie: ADM })).json() as any;
  ok(page2.entries.every((e: any) => e.id < page1.nextBefore));
  const all = [...page1.entries, ...page2.entries];
  deepStrictEqual(all.map((e: any) => e.id), expected.sort((a, b) => b - a));
  ok(all.every((e: any) => prior.includes(e.id) || e.detail?.workspaceSlug === "acme" || e.detail?.mappingId === String(id)));
  strictEqual(page2.nextBefore, null);
});

test("audit: bad limit or before is 422; a member is 403", async () => {
  strictEqual((await h.call("GET", "/workspaces/acme/audit?limit=0", { cookie: ADM })).status, 422);
  strictEqual((await h.call("GET", "/workspaces/acme/audit?limit=1000", { cookie: ADM })).status, 422);
  strictEqual((await h.call("GET", "/workspaces/acme/audit?before=x", { cookie: ADM })).status, 422);
  strictEqual((await h.call("GET", "/workspaces/acme/audit", { cookie: MEM })).status, 403);
});

test("mappings: DELETE removes the mapping and cascades its rules and policies", async () => {
  strictEqual((await h.call("DELETE", P(""), { cookie: ADM })).status, 204);
  strictEqual((await h.db.query(`SELECT 1 FROM rule_sets WHERE mapping_id = $1`, [id])).rows.length, 0);
  strictEqual((await h.db.query(`SELECT 1 FROM conflict_policies WHERE mapping_id = $1`, [id])).rows.length, 0);
  strictEqual((await h.call("DELETE", P(""), { cookie: ADM })).status, 404);
});

// ---- F2: a mapping must name a project of this workspace and a repository the App can reach -----------
test("F2: mappings are verified against Plane and GitHub; a refusal is 422 and stores nothing, an outage is 502", async () => {
  const seen: unknown[] = [];
  let outcome: string | null | Error = null;
  const v = await mappingHarness(async (check) => {
    const { onInstallationVerified, ...identity } = check;
    seen.push(identity);
    if (outcome instanceof Error) throw outcome;
    if (outcome === null) onInstallationVerified?.(1);
    return outcome;
  });
  try {
    const body = { ghRepoId: 7, ghRepoFullName: "acme/other", planeProjectId: "p-foreign" };
    outcome = "That Plane project does not exist in this workspace";
    let r = await v.call("POST", "/workspaces/acme/mappings", { cookie: ADM, body });
    strictEqual(r.status, 422);
    ok(((await r.json()) as { error: string }).error.includes("Plane project"));
    outcome = "The GitHub App is not installed on that repository";
    strictEqual((await v.call("POST", "/workspaces/acme/mappings", { cookie: ADM, body })).status, 422);
    strictEqual(await v.count("repo_mappings"), 0);
    deepStrictEqual(seen[0], { slug: "acme", planeProjectId: "p-foreign", repo: { id: 7, fullName: "acme/other" } });

    outcome = new Error("plane down");
    strictEqual((await v.call("POST", "/workspaces/acme/mappings", { cookie: ADM, body })).status, 502);
    strictEqual(await v.count("repo_mappings"), 0);

    outcome = null;
    r = await v.call("POST", "/workspaces/acme/mappings", { cookie: ADM, body });
    strictEqual(r.status, 201);
    const mid = ((await r.json()) as { id: number }).id;

    // PATCH verifies the effective repository even for settings-only changes.
    seen.length = 0;
    outcome = "The repository id does not match that repository on GitHub";
    strictEqual((await v.call("PATCH", `/workspaces/acme/mappings/${mid}`, { cookie: ADM, body: { autolinks: true } })).status, 422);
    strictEqual(seen.length, 1, "a settings-only patch verifies the effective repository");
    strictEqual((await v.call("PATCH", `/workspaces/acme/mappings/${mid}`, { cookie: ADM, body: { ghRepoId: 8, ghRepoFullName: "acme/x" } })).status, 422);
    strictEqual((await v.call("PATCH", `/workspaces/acme/mappings/${mid}`, { cookie: ADM, body: { planeProjectId: "p-other" } })).status, 422);
    const row = (await v.db.query<any>(`SELECT gh_repo_id, plane_project_id FROM repo_mappings WHERE id = $1`, [mid])).rows[0];
    deepStrictEqual([Number(row.gh_repo_id), row.plane_project_id], [7, "p-foreign"]);
  } finally { await v.close(); }
});

test("F2: createMappingVerifier checks the project through Plane and the repo id and name through the App", async () => {
  const { createMappingVerifier } = await import("../../src/ui/mapping-check.ts");
  const { PlaneApiError } = await import("../../src/sync/plane.ts");
  const paths: string[] = [];
  let planeStatus = 200;
  let repo: { id: number; full_name: string } | { status: number } = { id: 555, full_name: "Acme/Web" };
  let allowedFor: string | null = "acme";
  const v = createMappingVerifier({
    installationWorkspace: async () => allowedFor,
    plane: { async request(method, path) {
      paths.push(`${method} ${path}`);
      if (planeStatus !== 200) throw new PlaneApiError(planeStatus, "x", path);
      return {};
    } },
    github: {
      installationIdFor: async () => 1,
      installationOctokit: async () => ({ async request() {
        if ("status" in repo) throw Object.assign(new Error("nope"), { status: repo.status });
        return { data: repo };
      } }),
    },
  });
  const ask = (over: object = {}) => v({ slug: "acme", planeProjectId: "p1", repo: { id: 555, fullName: "acme/web" }, ...over });
  strictEqual(await ask(), null);
  deepStrictEqual(paths, ["GET /workspaces/acme/projects/p1/"]);
  planeStatus = 404;
  ok(/Plane project/.test((await ask()) ?? ""));
  planeStatus = 403;
  ok(/Plane project/.test((await ask()) ?? ""));
  planeStatus = 200;
  ok(/id does not match/.test((await ask({ repo: { id: 556, fullName: "acme/web" } })) ?? ""));
  ok(/name does not match/.test((await ask({ repo: { id: 555, fullName: "acme/other" } })) ?? ""));
  repo = { status: 404 };
  ok(/not installed/.test((await ask()) ?? ""));
  repo = { status: 500 };
  await rejects(ask());
  repo = { id: 555, full_name: "Acme/Web" };
  // F4: the repository's installation must be allow-listed for THIS workspace
  allowedFor = "other-workspace";
  ok(/not allowed for this workspace/.test((await ask()) ?? ""), "an installation owned by another workspace is refused");
  allowedFor = null;
  ok(/not allowed for this workspace/.test((await ask()) ?? ""), "an installation nobody allow-listed is refused");
  const closed = createMappingVerifier({ plane: { request: async () => ({}) }, github: { installationIdFor: async () => 1, installationOctokit: async () => ({ request: async () => ({ data: repo }) }) } });
  ok(/not allowed for this workspace/.test((await closed({ slug: "acme", repo: { id: 555, fullName: "acme/web" } })) ?? ""), "no allow-list source means every repository is refused");
});

test("r3 F4: installationWorkspaceFromDb reads workspace_installations", async () => {
  const { installationWorkspaceFromDb } = await import("../../src/ui/mapping-check.ts");
  const w = await setup();
  try {
    await w.db.query(`INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (77, 'acme')`);
    const look = installationWorkspaceFromDb(w.db);
    strictEqual(await look(77), "acme");
    strictEqual(await look(78), null);
  } finally { await w.close(); }
});

// ---- r3 F5: user links fail closed without verification and check workspace membership -----------------
test("r3 F5: user links need the GitHub lookup and the membership check (503 without), and the Plane user must be a member", async () => {
  const bare = await setup([], undefined, undefined, { lookupGithubUser: undefined, isWorkspaceMember: undefined });
  try {
    strictEqual((await bare.call("PUT", "/workspaces/acme/user-links/u-1", { cookie: ADM, body: { githubLogin: "octo", githubId: 1 } })).status, 503);
    strictEqual(await bare.count("user_map"), 0);
  } finally { await bare.close(); }
  const asked: string[] = [];
  const v = await setup([], undefined, undefined, { isWorkspaceMember: async (slug, id) => { asked.push(`${slug}/${id}`); return id === "u-1"; } });
  try {
    strictEqual((await v.call("PUT", "/workspaces/acme/user-links/u-2", { cookie: ADM, body: { githubLogin: "octo", githubId: 1 } })).status, 422);
    strictEqual(await v.count("user_map"), 0);
    strictEqual((await v.call("PUT", "/workspaces/acme/user-links/u-1", { cookie: ADM, body: { githubLogin: "octo", githubId: 1 } })).status, 200);
    deepStrictEqual(asked, ["acme/u-2", "acme/u-1"]);
  } finally { await v.close(); }
});

test("r3 F5: createPlaneMemberCheck understands list and {member} shapes", async () => {
  const { createPlaneMemberCheck } = await import("../../src/ui/mapping-check.ts");
  const mk = (body: unknown) => createPlaneMemberCheck({ request: async () => body });
  strictEqual(await mk([{ member: { id: "u-1" } }, { member: "u-2" }, { id: "u-3" }])("acme", "u-2"), true);
  strictEqual(await mk({ results: [{ member: { id: "u-1" } }] })("acme", "u-1"), true);
  strictEqual(await mk([{ member: { id: "u-1" } }])("acme", "u-9"), false);
  strictEqual(await mk(null)("acme", "u-1"), false);
});

// ---- r2 F1: no verifier configured means no mapping writes ---------------------------------------------
test("r2 F1: without a mapping verifier, create and update fail closed (503) and store nothing", async () => {
  const v = await mappingHarness(null); // C3 succeeds, so 503 must come from the missing App/project verifier.
  try {
    const body = { ghRepoId: 7, ghRepoFullName: "acme/other", planeProjectId: "p1" };
    const refused = await v.call("POST", "/workspaces/acme/mappings", { cookie: ADM, body });
    strictEqual(refused.status, 503);
    ok((await refused.json() as { error: string }).error.includes("Mapping verification is not configured"));
    strictEqual(await v.count("repo_mappings"), 0);
    await v.db.query(`INSERT INTO repo_mappings (workspace_slug, gh_repo_id, gh_repo_full_name, plane_project_id, sync_direction) VALUES ('acme', 7, 'acme/other', 'p1', 'bidirectional')`);
    const id = (await v.db.query<{ id: number }>(`SELECT id FROM repo_mappings`)).rows[0]!.id;
    strictEqual((await v.call("PATCH", `/workspaces/acme/mappings/${id}`, { cookie: ADM, body: { planeProjectId: "p2" } })).status, 503);
    strictEqual((await v.db.query<any>(`SELECT plane_project_id FROM repo_mappings`)).rows[0].plane_project_id, "p1");
    strictEqual((await v.call("PATCH", `/workspaces/acme/mappings/${id}`, { cookie: ADM, body: { autolinks: true } })).status, 503, "settings-only edits require verification");
  } finally { await v.close(); }
});

// ---- r2 F12: manual user links are checked against GitHub ----------------------------------------------
test("r2 F12: a manual link must match the GitHub account's id; the stored login is GitHub's canonical one", async () => {
  let result: { login: string; id: number } | null | Error = { login: "Octo", id: 41 };
  const v = await setup([], undefined, undefined, { lookupGithubUser: async () => { if (result instanceof Error) throw result; return result; } });
  try {
    const put = (body: unknown) => v.call("PUT", "/workspaces/acme/user-links/u-1", { cookie: ADM, body });
    strictEqual((await put({ githubLogin: "octo", githubId: 99 })).status, 422);
    result = null;
    strictEqual((await put({ githubLogin: "ghost-nobody", githubId: 41 })).status, 422);
    result = new Error("github down");
    strictEqual((await put({ githubLogin: "octo", githubId: 41 })).status, 502);
    strictEqual(await v.count("user_map"), 0);
    result = { login: "Octo", id: 41 };
    const r = await put({ githubLogin: "octo", githubId: 41 });
    strictEqual(r.status, 200);
    deepStrictEqual(await r.json(), { planeUserId: "u-1", githubLogin: "Octo", githubId: 41 });
  } finally { await v.close(); }
});

test("r2 F12: createGithubUserLookup maps 404 to null and returns id and canonical login", async () => {
  const { createGithubUserLookup } = await import("../../src/ui/mapping-check.ts");
  const lookup = createGithubUserLookup(async (_r, p) => {
    if (p.username === "gone") throw Object.assign(new Error("nf"), { status: 404 });
    if (p.username === "boom") throw Object.assign(new Error("bad"), { status: 500 });
    return { data: { login: "Octo", id: 41 } };
  });
  deepStrictEqual(await lookup("octo"), { login: "Octo", id: 41 });
  strictEqual(await lookup("gone"), null);
  await rejects(() => lookup("boom"));
});
