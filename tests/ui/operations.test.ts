import test, { after, before } from "node:test";
import { strictEqual, deepStrictEqual, ok } from "node:assert/strict";
import { ADM, MAPPING, MEM, setup } from "./harness.ts";
import type { Harness } from "./harness.ts";
import { appendAudit } from "../../src/db/ledgers.ts";
import { mappingHref, parseLocation } from "../../src/ui/client/router.ts";
import { parseDryRun, ValidationError } from "../../src/ui/validate.ts";
import { throws } from "node:assert/strict";
import { encryptSecret } from "../../src/auth/identity.ts";
import { putGithubOAuthToken } from "../../src/db/parity.ts";
import { KEY } from "./harness.ts";
import type { ConfigApiDeps } from "../../src/ui/api.ts";

// C3 requires personal access; S5 backfills only through this workspace's approved installation.
const githubAccess: Partial<ConfigApiDeps> = {
  githubOAuthConfig: { GITHUB_CLIENT_ID: "Iv1.fixture", GITHUB_CLIENT_SECRET: "fixture-secret" },
  appRequest: async () => ({ data: [] }),
  fetch: (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.hostname !== "api.github.com") return fetch(url, init);
    strictEqual(new Headers(init?.headers).get("authorization"), "Bearer ghu-fixture");
    strictEqual(u.pathname, "/user/installations/1/repositories");
    return new Response(JSON.stringify({ total_count: 1, repositories: [{ id: 555, full_name: "acme/web", permissions: { triage: true } }] }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch,
};

const enqueued: any[] = [];
const requested: { route: string; params: any }[] = [];
const resolved: string[] = [];
let h: Harness;
let bare: Harness;
let id: number;

before(async () => {
  h = await setup([], {
    enqueue: async (j) => { enqueued.push(j); },
    githubFor: async (r) => ({ request: async (route, params) => {
      requested.push({ route, params: { ...params, ...r } });
      if (route.includes("pulls")) return { data: [{ number: 5, title: "Fixes QLL-1", head: { ref: "x" } }] };
      return { data: [] };
    } }),
    resolveIssue: async (slug, key) => { resolved.push(`${slug}:${key}`); return { projectId: "p1", issueId: `iss-${key}` }; },
  }, undefined, githubAccess);
  bare = await setup([], undefined, undefined, githubAccess);
  for (const x of [h, bare]) {
    await x.db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (1,'acme')");
    await putGithubOAuthToken(x.db, "u-adm", { accessCiphertext: encryptSecret("ghu-fixture", KEY), refreshCiphertext: null, accessExpiresAt: null, refreshExpiresAt: null });
    const r = await x.call("POST", "/workspaces/acme/mappings", { cookie: ADM, body: MAPPING });
    strictEqual(r.status, 201, await r.clone().text());
    id = ((await r.json()) as { id: number }).id;
  }
});
after(async () => { await h.close(); await bare.close(); });

const MERGED = { action: "closed", repository: { full_name: "acme/web" },
  pull_request: { number: 1, merged: true, base: { ref: "main" }, head: { ref: "x" }, labels: [], user: { login: "o" } } };

test("dry-run: with no rules it tests the §7.1 defaults and writes nothing", async () => {
  const r = await h.call("POST", "/workspaces/acme/dry-run", { cookie: ADM, body: { event: "pull_request", payload: MERGED } });
  strictEqual(r.status, 200);
  const out = await r.json() as any;
  deepStrictEqual([out.dryRun, out.trigger, out.actions], [true, "pull_request.merged", [{ type: "set_state", state: "completed:Done" }]]);
  strictEqual(await h.count("sync_links") + await h.count("applied_ops"), 0);
  ok(h.plane.calls.every((c) => c.method === "GET"));
});

test("dry-run: a mapping's saved rules are used, and explicit YAML overrides them", async () => {
  const yaml = "- when: pull_request.merged\n  then:\n    - set_state: Shipped\n";
  strictEqual((await h.call("PUT", `/workspaces/acme/mappings/${id}/rules`, { cookie: ADM, body: { yaml } })).status, 200);
  const saved = await (await h.call("POST", "/workspaces/acme/dry-run", { cookie: ADM, body: { event: "pull_request", payload: MERGED, mappingId: id } })).json() as any;
  deepStrictEqual(saved.actions, [{ type: "set_state", state: "Shipped" }]);
  const over = await (await h.call("POST", "/workspaces/acme/dry-run", { cookie: ADM, body: { event: "pull_request", payload: MERGED, mappingId: id, yaml: "- when: pull_request.merged\n  then:\n    - add_label: x\n" } })).json() as any;
  deepStrictEqual(over.actions, [{ type: "add_label", label: "x" }]);
});

test("dry-run: invalid rules and unresolvable templates are 422 with the reason", async () => {
  const bad = await h.call("POST", "/workspaces/acme/dry-run", { cookie: ADM, body: { event: "pull_request", payload: MERGED, yaml: "- when: nope\n  then: [ { comment: x } ]\n" } });
  strictEqual(bad.status, 422);
  ok(/index 0/.test(((await bad.json()) as any).error));
  const tpl = await h.call("POST", "/workspaces/acme/dry-run", { cookie: ADM, body: { event: "pull_request", payload: MERGED, yaml: "- when: pull_request.merged\n  then:\n    - comment: '{{pr.url}}'\n" } });
  strictEqual(tpl.status, 422);
});

test("dry-run: validation, auth and CSRF", async () => {
  const post = (body: unknown, o: object = {}) => h.call("POST", "/workspaces/acme/dry-run", { cookie: ADM, body, ...o });
  strictEqual((await post({ payload: MERGED })).status, 422);
  strictEqual((await post({ event: "unknown_event", payload: MERGED })).status, 422);
  const issue = await post({ event: "issues", payload: { action: "opened", issue: { number: 1 } } });
  strictEqual(issue.status, 200); strictEqual((await issue.json() as any).trigger, "issue.opened");
  strictEqual((await post({ event: "push" })).status, 422);
  strictEqual((await post({ event: "push", payload: [] })).status, 422);
  strictEqual((await post({ event: "push", payload: {}, extra: 1 })).status, 422);
  strictEqual((await post({ event: "push", payload: {}, mappingId: 9999 })).status, 404);
  strictEqual((await post({ event: "push", payload: {} }, { origin: "https://evil.example" })).status, 403);
  strictEqual((await post({ event: "push", payload: {} }, { cookie: MEM })).status, 403);
  strictEqual((await h.call("POST", "/workspaces/acme/dry-run", { body: { event: "push", payload: {} } })).status, 401);
});

test("dry-run: a recorded delivery from this workspace's audit log can be replayed through the rules", async () => {
  const aid = await appendAudit(h.db, { kind: "inbound_delivery", source: "github", workspaceSlug: "acme", deliveryId: "d1", detail: { event: "pull_request", payload: MERGED }, outcome: "handled" });
  const r = await h.call("POST", "/workspaces/acme/dry-run", { cookie: ADM, body: { event: "pull_request", auditId: Number(aid), yaml: "- when: pull_request.merged\n  then:\n    - add_label: seen\n" } });
  strictEqual(r.status, 200);
  deepStrictEqual(((await r.json()) as any).actions, [{ type: "add_label", label: "seen" }]);
  const other = await appendAudit(h.db, { kind: "inbound_delivery", source: "github", workspaceSlug: "elsewhere", detail: { event: "pull_request", payload: MERGED }, outcome: "handled" });
  strictEqual((await h.call("POST", "/workspaces/acme/dry-run", { cookie: ADM, body: { event: "pull_request", auditId: Number(other) } })).status, 404);
  const dup = await appendAudit(h.db, { kind: "inbound_delivery", source: "github", workspaceSlug: "acme", detail: { event: "pull_request" }, outcome: "duplicate" });
  strictEqual((await h.call("POST", "/workspaces/acme/dry-run", { cookie: ADM, body: { event: "pull_request", auditId: Number(dup) } })).status, 422);
});

test("replay: enqueues under a fresh delivery id and answers 202", async () => {
  const aid = await appendAudit(h.db, { kind: "inbound_delivery", source: "github", workspaceSlug: "acme", deliveryId: "gd-orig", detail: { event: "push", payload: { ref: "refs/heads/main" } }, outcome: "failed", error: "boom" });
  const r = await h.call("POST", `/workspaces/acme/audit/${aid}/replay`, { cookie: ADM });
  strictEqual(r.status, 202);
  const out = await r.json() as any;
  strictEqual(enqueued.length, 1);
  deepStrictEqual([enqueued[0].source, enqueued[0].event, enqueued[0].payload], ["github", "push", { ref: "refs/heads/main" }]);
  ok(enqueued[0].deliveryId !== "gd-orig" && enqueued[0].deliveryId === out.deliveryId);
  strictEqual(String((await h.db.query<any>(`SELECT replay_of FROM audit_log WHERE id = $1`, [out.auditId])).rows[0].replay_of), String(aid));
});

test("replay: other workspaces' entries are 404, non-deliveries 422, members 403, anonymous 401, cross-site 403", async () => {
  const before = enqueued.length;
  const foreign = await appendAudit(h.db, { kind: "inbound_delivery", source: "github", workspaceSlug: "elsewhere", detail: { event: "push", payload: {} }, outcome: "handled" });
  const notDelivery = await appendAudit(h.db, { kind: "smart_commit", workspaceSlug: "acme", outcome: "applied" });
  const ok1 = await appendAudit(h.db, { kind: "inbound_delivery", source: "github", workspaceSlug: "acme", detail: { event: "push", payload: {} }, outcome: "handled" });
  strictEqual((await h.call("POST", `/workspaces/acme/audit/${foreign}/replay`, { cookie: ADM })).status, 404);
  strictEqual((await h.call("POST", `/workspaces/acme/audit/abc/replay`, { cookie: ADM })).status, 404);
  strictEqual((await h.call("POST", `/workspaces/acme/audit/${notDelivery}/replay`, { cookie: ADM })).status, 422);
  strictEqual((await h.call("POST", `/workspaces/acme/audit/${ok1}/replay`, { cookie: MEM })).status, 403);
  strictEqual((await h.call("POST", `/workspaces/acme/audit/${ok1}/replay`)).status, 401);
  strictEqual((await h.call("POST", `/workspaces/acme/audit/${ok1}/replay`, { cookie: ADM, origin: "https://evil.example" })).status, 403);
  strictEqual(enqueued.length, before);
});

test("replay and backfill answer 503 when the deployment wires no operations", async () => {
  const aid = await appendAudit(bare.db, { kind: "inbound_delivery", source: "github", workspaceSlug: "acme", detail: { event: "push", payload: {} }, outcome: "handled" });
  strictEqual((await bare.call("POST", `/workspaces/acme/audit/${aid}/replay`, { cookie: ADM })).status, 503);
  strictEqual((await bare.call("POST", `/workspaces/acme/mappings/${id}/backfill`, { cookie: ADM })).status, 503);
});

test("backfill: lists the mapped repository, links references and reports counts", async () => {
  const r = await h.call("POST", `/workspaces/acme/mappings/${id}/backfill`, { cookie: ADM });
  strictEqual(r.status, 200);
  deepStrictEqual(await r.json(), { linked: 1, unresolved: 0, pullRequests: 1, issues: 0 });
  ok(requested.every((q) => q.params.owner === "acme" && q.params.repo === "web" && q.params.ghRepoId === 555 && q.params.installationId === 1));
  deepStrictEqual(resolved, ["acme:QLL-1"]);
  const link = (await h.db.query<any>(`SELECT plane_workspace_slug, plane_project_id, gh_kind FROM sync_links`)).rows[0];
  deepStrictEqual([link.plane_workspace_slug, link.plane_project_id, link.gh_kind], ["acme", "p1", "pr"]);
});

test("backfill: wrong workspace is 404, members 403, cross-site 403", async () => {
  h.plane.roles["u-adm"]!.third = 20;
  strictEqual((await h.call("POST", `/workspaces/third/mappings/${id}/backfill`, { cookie: ADM })).status, 404);
  strictEqual((await h.call("POST", `/workspaces/acme/mappings/${id}/backfill`, { cookie: MEM })).status, 403);
  strictEqual((await h.call("POST", `/workspaces/acme/mappings/${id}/backfill`, { cookie: ADM, origin: null })).status, 403);
});

test("audit view: entries tagged with the workspace column show up for that workspace only", async () => {
  await appendAudit(h.db, { kind: "smart_commit", workspaceSlug: "acme", outcome: "applied" });
  await appendAudit(h.db, { kind: "smart_commit", workspaceSlug: "elsewhere", outcome: "applied" });
  const page = await (await h.call("GET", "/workspaces/acme/audit?limit=200", { cookie: ADM })).json() as any;
  ok(page.entries.some((e: any) => e.kind === "smart_commit"));
  const elsewhere = (await h.db.query<any>(`SELECT id FROM audit_log WHERE workspace_slug = 'elsewhere'`)).rows.map((r) => Number(r.id));
  ok(page.entries.every((e: any) => !elsewhere.includes(e.id)));
});

test("router: the dry-run tab round-trips", () => {
  deepStrictEqual(parseLocation(mappingHref("acme", 3, "dry-run")), { name: "mapping", slug: "acme", id: 3, tab: "dry-run" });
});

test("validate: dry-run input shapes", () => {
  throws(() => parseDryRun({ event: "push" }), ValidationError);
  throws(() => parseDryRun({ event: "push", payload: {}, yaml: 5 }), ValidationError);
  deepStrictEqual(parseDryRun({ event: "push", auditId: 4 }), { event: "push", auditId: 4 });
});
