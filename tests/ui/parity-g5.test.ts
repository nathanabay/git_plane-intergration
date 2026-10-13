import test from "node:test";
import { deepStrictEqual, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
import { parseRules } from "../../src/rules/engine.ts";
import { mappingFormBody } from "../../src/ui/client/mapping-form.ts";
import { setRuleState } from "../../src/ui/client/rule-editor.ts";
import { previewRules } from "../../src/ui/dry-run.ts";
import { listInstanceWorkspaces } from "../../src/ui/plane-auth.ts";
import { DRY_RUN_TRIGGERS, parseDryRun, parseMappingInput, ValidationError } from "../../src/ui/validate.ts";
import { PlaneClient } from "../../src/sync/plane.ts";
import { SecretString, encryptSecret } from "../../src/auth/identity.ts";
import { putGithubOAuthToken } from "../../src/db/parity.ts";
import { composeRoutes } from "../../src/app/main.ts";
import { startServer } from "../../src/index.ts";
import { makeHarness } from "../a8/harness.ts";
import type { IncomingMessage } from "node:http";
import type { AuditEntry, Mapping, PlaneState } from "../../src/ui/client/types.ts";
import { ADM, INST, KEY, MEM, MAPPING, ORIGIN, setup, startFakePlane } from "./harness.ts";

const form = { ghRepoId: 555, ghRepoFullName: "acme/web", planeProjectId: "p1", syncDirection: "bidirectional" as const, linkbackComments: true };
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
const states: PlaneState[] = [{ id: "s-start", name: "In progress", group: "started" }, { id: "s-done", name: "Done", group: "completed" }];

test("E2E-1: mapping form body submits both report toggle values while preserving untouched Smart Commits", () => {
  for (const reportProblems of [true, false]) {
    deepStrictEqual(mappingFormBody({ ...form, reportProblems }, undefined), { ...form, reportProblems });
  }
  deepStrictEqual(mappingFormBody({ ...form, reportProblems: true }, false), { ...form, reportProblems: true, smartCommitsEnabled: false });
});

// C3: retain workspace-admin mapping creation, using the viewer's own token and approved installation.
async function mappingHarness() {
  const h = await setup([], undefined, undefined, {
    githubOAuthConfig: { GITHUB_CLIENT_ID: "Iv1.fixture", GITHUB_CLIENT_SECRET: "fixture-secret" },
    appRequest: async () => ({ data: [] }),
    fetch: (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.hostname !== "api.github.com") return fetch(url, init);
      strictEqual(new Headers(init?.headers).get("authorization"), "Bearer ghu-fixture");
      strictEqual(u.pathname, "/user/installations/1/repositories");
      return json({ total_count: 1, repositories: [{ id: 555, full_name: "acme/web", permissions: { triage: true } }] });
    }) as typeof fetch,
  });
  await h.db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (1,'acme')");
  await putGithubOAuthToken(h.db, "u-adm", { accessCiphertext: encryptSecret("ghu-fixture", KEY), refreshCiphertext: null, accessExpiresAt: null, refreshExpiresAt: null });
  return h;
}

test("N6: untouched UI settings use the current instance default and retain stored autolinks", async () => {
  const h = await mappingHarness();
  try {
    strictEqual((await h.call("PUT", "/instance/settings", { cookie: INST, body: { smartCommitsDefault: false } })).status, 200);
    const defaults = await h.call("GET", "/workspaces/acme/defaults", { cookie: ADM });
    deepStrictEqual(await defaults.json(), { smartCommitsDefault: false });
    strictEqual((await h.call("GET", "/workspaces/acme/defaults", { cookie: INST })).status, 401);
    const body = mappingFormBody(form, undefined);
    ok(!Object.hasOwn(body, "smartCommitsEnabled"));
    ok(!Object.hasOwn(body, "autolinks"));
    const created = await h.call("POST", "/workspaces/acme/mappings", { cookie: ADM, body });
    strictEqual(created.status, 201);
    const { id } = await created.json() as { id: number };
    strictEqual((await h.db.query<any>("SELECT smart_commits_enabled FROM repo_mappings WHERE id = $1", [id])).rows[0].smart_commits_enabled, false);
    await h.db.query("UPDATE repo_mappings SET autolinks_enabled = true WHERE id = $1", [id]);
    strictEqual((await h.call("PATCH", `/workspaces/acme/mappings/${id}`, { cookie: ADM, body: mappingFormBody({ ...form, linkbackComments: false }, undefined) })).status, 200);
    const stored = (await h.db.query<any>("SELECT smart_commits_enabled, autolinks_enabled FROM repo_mappings WHERE id = $1", [id])).rows[0];
    deepStrictEqual(stored, { smart_commits_enabled: false, autolinks_enabled: true });
    strictEqual((await h.call("PATCH", `/workspaces/acme/mappings/${id}`, { cookie: ADM, body: mappingFormBody(form, true) })).status, 200);
    strictEqual((await h.db.query<any>("SELECT smart_commits_enabled FROM repo_mappings WHERE id = $1", [id])).rows[0].smart_commits_enabled, true);
    await h.call("PUT", "/instance/settings", { cookie: INST, body: { smartCommitsDefault: true } });
    const fresh = await h.call("POST", "/workspaces/acme/mappings", { cookie: ADM, body: { ...body, planeProjectId: "p2" } });
    strictEqual(fresh.status, 201, "an untouched form does not freeze the earlier false default");
    const freshId = (await fresh.json() as { id: number }).id;
    strictEqual((await h.db.query<any>("SELECT smart_commits_enabled FROM repo_mappings WHERE id = $1", [freshId])).rows[0].smart_commits_enabled, true);
    deepStrictEqual(parseMappingInput(body, false), body);
  } finally { await h.close(); }
});

test("N6: rule Restore creates a new authored version and is workspace-scoped and CSRF protected", async () => {
  const h = await mappingHarness();
  const first = '- name: First\n  when: issue.created\n  then: [{comment: first}]\n';
  const second = '- name: Second\n  when: issue.created\n  then: [{comment: second}]\n';
  try {
    const created = await h.call("POST", "/workspaces/acme/mappings", { cookie: ADM, body: MAPPING });
    strictEqual(created.status, 201, await created.clone().text());
    const id = (await created.json() as { id: number }).id;
    const path = `/workspaces/acme/mappings/${id}/rules`;
    await h.call("PUT", path, { cookie: ADM, body: { yaml: first } });
    await h.call("PUT", path, { cookie: ADM, body: { yaml: second } });
    const history = await (await h.call("GET", `${path}/versions`, { cookie: ADM })).json() as { version: number; updatedBy: string; updatedAt: string }[];
    deepStrictEqual(history.map((version) => version.version), [2, 1]);
    ok(history.every((version) => version.updatedBy === "u-adm" && !!version.updatedAt));
    strictEqual((await h.call("POST", `${path}/versions/1/restore`, { cookie: ADM, origin: "https://foreign.test" })).status, 403);
    strictEqual((await h.call("POST", `${path}/versions/1/restore`, { cookie: MEM })).status, 403);
    h.plane.roles["u-adm"]!.other = 20;
    strictEqual((await h.call("GET", `/workspaces/other/mappings/${id}/rules/versions`, { cookie: ADM })).status, 404);
    strictEqual((await h.call("POST", `/workspaces/other/mappings/${id}/rules/versions/1/restore`, { cookie: ADM })).status, 404);
    strictEqual((await h.call("POST", `${path}/versions/999/restore`, { cookie: ADM })).status, 404);
    const restored = await h.call("POST", `${path}/versions/1/restore`, { cookie: ADM });
    strictEqual(restored.status, 200);
    deepStrictEqual(await restored.json(), { version: 3, yaml: first });
    const latest = await (await h.call("GET", path, { cookie: ADM })).json() as { version: number; yaml: string; updatedBy: string };
    strictEqual(latest.version, 3); strictEqual(latest.yaml, first); strictEqual(latest.updatedBy, "u-adm");
    const saved = (await h.db.query<any>("SELECT version, yaml_source FROM rule_sets WHERE mapping_id = $1 ORDER BY version", [id])).rows;
    deepStrictEqual(saved.map((version: any) => [version.version, version.yaml_source]), [[1, first], [2, second], [3, first]]);
  } finally { await h.close(); }
});

test("N6: specific dry-run triggers use the engine grammar, conditions and templates without writing", async () => {
  for (const trigger of [...DRY_RUN_TRIGGERS, "issue.custom_action", "comment.custom_action", "deployment_status.custom_action", "check_suite.custom_action"]) {
    const input = parseDryRun({ trigger, payload: {} });
    const result = previewRules(input, `- when: ${JSON.stringify(trigger)}\n  then: [{comment: preview}]\n`, {});
    strictEqual(result.trigger, trigger);
    deepStrictEqual(result.actions, [{ type: "comment", body: "preview" }]);
  }
  throws(() => parseDryRun({ trigger: "pull_request.unknown", payload: {} }), ValidationError);
  throws(() => parseDryRun({ trigger: "unknown.opened", payload: {} }), ValidationError);
  const h = await setup();
  try {
    const result = await h.call("POST", "/workspaces/acme/dry-run", { cookie: ADM, body: {
      trigger: "deployment_status.custom_action", payload: { repo: "acme/web", context: { deployment: { environment: "Preview" } } },
      yaml: '- when: deployment_status.*\n  if: {repo: acme/web}\n  then: [{comment: "Deploy {{deployment.environment}}"}]\n',
    } });
    strictEqual(result.status, 200);
    deepStrictEqual((await result.json() as { actions: unknown[] }).actions, [{ type: "comment", body: "Deploy Preview" }]);
    strictEqual(await h.count("outbound_writes"), 0);
    strictEqual(await h.count("audit_log"), 0);
    strictEqual((await h.call("POST", "/workspaces/acme/dry-run", { cookie: ADM, body: { trigger: "issue.opened", payload: { labels: [7] }, yaml: '- when: issue.*\n  then: [{comment: preview}]\n' } })).status, 422);
  } finally { await h.close(); }
});

test("N6: webhook previews translate checks, deployments, GitHub/Plane issues and comments, plus every push event", () => {
  const examples = [
    { event: "check_suite", payload: { action: "completed", check_suite: { conclusion: "failure" } }, trigger: "check_suite.failure" },
    { event: "deployment_status", payload: { deployment_status: { state: "success" } }, trigger: "deployment_status.success" },
    { event: "issues", payload: { action: "closed", issue: { number: 1 } }, trigger: "issue.closed" },
    { event: "issue_comment", payload: { action: "edited", comment: { body: "x" } }, trigger: "comment.edited" },
    { event: "issue", source: "plane", payload: { action: "update", data: { id: "i1", project: "p1" } }, trigger: "issue.updated" },
    { event: "issue_comment", source: "plane", payload: { action: "create", data: { id: "c1", issue: "i1" } }, trigger: "comment.created" },
  ];
  for (const example of examples) {
    const { trigger, ...delivery } = example;
    const input = parseDryRun(delivery);
    const result = previewRules(input, `- when: ${example.trigger}\n  then: [{comment: preview}]\n`, example.payload);
    strictEqual(result.trigger, example.trigger); strictEqual(result.actions.length, 1);
  }
  const payload = { ref: "refs/heads/main", repository: { full_name: "acme/web", default_branch: "main" }, commits: [] };
  const result = previewRules(parseDryRun({ event: "push", payload }), '- when: push\n  then: [{comment: pushed}]\n- when: commit.pushed_to_default\n  then: [{comment: default}]\n', payload);
  deepStrictEqual(result.events?.map((event) => event.trigger), ["push", "commit.pushed_to_default"]);
  strictEqual(result.actions.length, 2);
});

test("N4: project/member/state name routes authenticate before reading Plane and follow every v1 page", async () => {
  const calls: string[] = [];
  const plane = new PlaneClient({ baseUrl: "http://plane", token: new SecretString("service"), sleep: async () => {},
    fetch: (async (url: string) => {
      const parsed = new URL(url); calls.push(parsed.pathname + parsed.search);
      const second = parsed.searchParams.has("cursor");
      const rows = parsed.pathname.endsWith("projects/") ? [{ id: second ? "p2" : "p1", name: second ? "Website" : "Application", identifier: second ? "WEB" : "APP" }]
        : parsed.pathname.endsWith("members-lite/") ? [{ id: second ? "u2" : "u1", display_name: second ? "Bob" : "Alice", email: "member@example.test", is_active: true, is_bot: false }]
        : [{ id: second ? "s-done" : "s-start", name: second ? "Done" : "In progress", group: second ? "completed" : "started" }];
      return json({ results: rows, next_cursor: second ? null : "10:1:0", next_page_results: !second });
    }) as typeof fetch });
  const h = await setup([], undefined, undefined, { planeDirectory: plane });
  try {
    strictEqual((await h.call("GET", "/workspaces/acme/projects")).status, 401);
    strictEqual((await h.call("GET", "/workspaces/acme/members", { cookie: MEM })).status, 403);
    strictEqual(calls.length, 0);
    const projects = await (await h.call("GET", "/workspaces/acme/projects", { cookie: ADM })).json() as { label: string }[];
    deepStrictEqual(projects.map((project) => project.label), ["APP · Application", "WEB · Website"]);
    const members = await (await h.call("GET", "/workspaces/acme/members", { cookie: ADM })).json() as { name: string }[];
    deepStrictEqual(members.map((member) => member.name), ["Alice", "Bob"]);
    const loadedStates = await (await h.call("GET", "/workspaces/acme/projects/p1/states", { cookie: ADM })).json();
    deepStrictEqual(loadedStates, states);
    strictEqual(calls.length, 6, "each collection includes its second page");
    ok(calls.filter((path) => path.includes("cursor=10%3A1%3A0")).length === 3);
  } finally { await h.close(); }
});

test("N4: instance workspace listing uses only the admin cookie and refuses partial/repeated cursors", async () => {
  const calls: { path: string; cookie: string }[] = [];
  let repeat = false;
  const deps = { planeInternalUrl: "http://plane", fetch: (async (url: string, options: RequestInit) => {
    const path = new URL(url).pathname + new URL(url).search;
    calls.push({ path, cookie: (options.headers as Record<string, string>).cookie! });
    const second = path.includes("cursor=");
    return json({ results: [{ id: second ? "w2" : "w1", slug: second ? "other" : "acme", name: second ? "Other team" : "Acme team" }],
      next_cursor: "10:1:0", next_page_results: repeat || !second });
  }) as typeof fetch };
  const req = { headers: { cookie: "admin-session-id=inst; session-id=different; tracking=x" } } as IncomingMessage;
  deepStrictEqual((await listInstanceWorkspaces(deps, req)).map((workspace) => workspace.name), ["Acme team", "Other team"]);
  deepStrictEqual(calls, [
    { path: "/api/instances/workspaces/", cookie: "admin-session-id=inst" },
    { path: "/api/instances/workspaces/?cursor=10%3A1%3A0", cookie: "admin-session-id=inst" },
  ]);
  repeat = true;
  await rejects(listInstanceWorkspaces(deps, req), /pagination did not complete/);
  await rejects(listInstanceWorkspaces(deps, { headers: { cookie: "session-id=adm" } } as IncomingMessage), /Sign in/);
});

test("N4: composeRoutes supplies the live Plane directory to authenticated name lookups", async () => {
  const h = await makeHarness();
  const sessions = await startFakePlane();
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  const paths: string[] = [];
  try {
    h.ctx.config.PLANE_BASE_URL = sessions.url;
    h.ctx.config.PUBLIC_ORIGIN = ORIGIN;
    const plane = new PlaneClient({ baseUrl: "http://plane-data", token: new SecretString("service"), sleep: async () => {}, fetch: (async (url: string) => {
      paths.push(new URL(url).pathname);
      return json([{ id: "p1", name: "Application", identifier: "APP" }]);
    }) as typeof fetch });
    server = await startServer({ port: 0, host: "127.0.0.1", routes: composeRoutes({ config: h.ctx.config, db: h.db, ctx: h.ctx,
      tokenKey: KEY, planeClient: plane, ghClient: h.ctx.ghClient, enqueue: async () => {},
      credentials: { load: async () => { throw new Error("unused"); }, webhookSecret: async () => "secret", describe: async () => ({ source: "database", decryptOk: true }) },
    }) });
    const response = await fetch(`http://127.0.0.1:${server.port}/git-sync/api/workspaces/acme/projects`, { headers: { cookie: ADM } });
    strictEqual(response.status, 200);
    deepStrictEqual(await response.json(), [{ id: "p1", name: "Application", identifier: "APP", label: "APP · Application" }]);
    deepStrictEqual(paths, ["/api/v1/workspaces/acme/projects/"]);
  } finally { await server?.close(); await sessions.close(); await h.close(); }
});

test("N4: YAML state editing preserves custom conditions and unrelated actions, changing the final state", () => {
  const source = '- name: Custom\n  when: issue.*\n  if: {labels_any: [urgent]}\n  then: [{set_state: backlog}, {comment: keep}, {set_state: started}]\n';
  const before = parseRules(source)[0]!;
  const after = parseRules(setRuleState(source, 0, "completed:Done"))[0]!;
  deepStrictEqual(after.if, before.if); deepStrictEqual(after.when, before.when);
  deepStrictEqual(after.then, [{ type: "set_state", state: "backlog" }, { type: "comment", body: "keep" }, { type: "set_state", state: "completed:Done" }]);
  throws(() => setRuleState(source, 99, "completed:Done"));
});

test("N4/N6: actual components render named pickers, shared state controls, versions and collapsed raw audit details", async () => {
  const dir = await mkdtemp(join(tmpdir(), "parity-g5-ui-"));
  try {
    await symlink(resolve(import.meta.dirname, "../../node_modules"), join(dir, "node_modules"), "dir");
    const outfile = join(dir, "ui.mjs");
    await build({ stdin: { contents: 'export * from "./src/ui/client/pickers.tsx"; export * from "./src/ui/client/Workspace.tsx"; export * from "./src/ui/client/audit.tsx";',
      resolveDir: resolve(import.meta.dirname, "../.."), loader: "tsx" }, outfile, bundle: true, packages: "external", platform: "node", format: "esm", jsx: "automatic", logLevel: "silent" });
    const ui = await import(pathToFileURL(outfile).href) as typeof import("../../src/ui/client/pickers.tsx") & typeof import("../../src/ui/client/Workspace.tsx") & typeof import("../../src/ui/client/audit.tsx");
    const render = (component: any, props: any) => renderToStaticMarkup(createElement(component, props));
    const member = render(ui.MemberPicker, { members: [{ id: "private-user-uuid", name: "Alice", email: "alice@example.test" }], value: "private-user-uuid", onChange() {} });
    ok(member.includes('value="private-user-uuid" selected=""')); ok(member.includes("Alice")); ok(!member.includes(">private-user-uuid<"));
    const workspace = render(ui.WorkspacePicker, { workspaces: [{ id: "w1", slug: "acme", name: "Acme team" }], value: "acme", onChange() {} });
    ok(workspace.includes(">Acme team</option>")); ok(!workspace.includes('<input'));
    const picker = render(ui.StatePicker, { states: [...states, { id: "triage", name: "Triage", group: "triage" }], value: "completed:Done", label: "State", onChange() {} });
    ok(picker.includes('value="completed:Done" selected=""')); ok(!picker.includes(">Triage"));
    const missing = render(ui.StatePicker, { states, value: "started:Retired", label: "State", onChange() {} });
    ok(missing.includes('value="started:Retired" selected=""')); ok(missing.includes("Previously selected"));
    const rules = render(ui.RulesFields, { slug: "acme", id: 1, states, initial: { version: 0, yaml: "", updatedBy: null, updatedAt: null } });
    strictEqual((rules.match(/target state/g) ?? []).length, 10, "all lifecycle states use the shared picker");
    ok(!rules.includes("§")); ok(rules.includes("completed:Done"));
    const custom = render(ui.RulesFields, { slug: "acme", id: 1, states,
      initial: { version: 1, yaml: '- when: issue.*\n  then: [{comment: keep}]\n', updatedBy: "u1", updatedAt: null } });
    ok(custom.includes('aria-label="Custom rule target state"'), "custom rules use the same state picker");
    const history = render(ui.RuleVersions, { versions: [{ version: 2, updatedBy: "u1", updatedAt: "2026-10-12T12:00:00Z" }, { version: 1, updatedBy: "u1", updatedAt: "2026-10-12T11:00:00Z" }],
      members: [{ id: "u1", name: "Alice", email: null }], currentVersion: 2, busy: false, onRestore() {} });
    ok(history.includes("Alice")); ok(history.includes("Restore")); ok(history.includes("(current)"));
    const entry: AuditEntry = { id: 1, kind: "inbound_delivery", source: "github", deliveryId: "d1", outcome: "handled", error: null,
      replayOf: null, createdAt: "2026-10-12T12:00:00Z", detail: { payload: { message: "raw delivery" } } };
    const audit = render(ui.AuditDetail, { entry });
    ok(audit.includes("<details><summary>Show raw</summary>")); ok(!audit.includes("<details open")); ok(audit.includes("raw delivery"));
    strictEqual(ui.auditKindLabel(entry.kind), "Webhook received");
    const existing: Mapping = { id: 1, workspaceSlug: "acme", ...MAPPING, syncDirection: "bidirectional", autolinks: true, reportProblems: true };
    const mapping = render(ui.MappingForm, { slug: "acme", existing, onSaved() {} });
    ok(mapping.includes('disabled="" checked=""')); ok(!mapping.includes('placeholder="project id"'));
    const reportInput = (html: string) => html.match(/(<input[^>]*\/>)(?=<span>Report problems as comments on GitHub and Plane<\/span>)/)?.[1];
    ok(reportInput(mapping)?.includes('checked=""')); ok(!reportInput(mapping)?.includes('disabled=""'));
    const fresh = render(ui.MappingForm, { slug: "acme", onSaved() {} });
    ok(reportInput(fresh)); ok(!reportInput(fresh)!.includes('checked=""')); ok(!reportInput(fresh)!.includes('disabled=""'));
    const off = render(ui.MappingForm, { slug: "acme", existing: { ...existing, reportProblems: false }, onSaved() {} });
    ok(reportInput(off)); ok(!reportInput(off)!.includes('checked=""'));
    const links = render(ui.LinkForm, { slug: "acme", onSaved() {} });
    ok(links.includes('aria-label="Plane member"')); ok(!links.includes("Plane user id"));
    const dry = render(ui.DryRunPanel, { slug: "acme", id: 1 });
    for (const event of ["Check suite", "Deployment status", "Issues", "Issue comment"]) ok(dry.includes(event));
    ok(dry.includes("Specific rule trigger"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
