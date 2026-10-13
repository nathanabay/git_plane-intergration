// S05–S13: ingress authentication, body limits, session/CSRF guards, S1 traversal, authorization, static paths (G3).
// Following the security-audit guidance: each check names the boundary, uses dummy payloads, stops at the minimum
// observable result (the status and "nothing stored"), and never sends a real secret.
import { randomBytes } from "node:crypto";
import http from "node:http";
import { app, assert, cfg, eq, name, planeOrm, planeOrmJson, scenario, sleep, sql, web, ensureMemberUser } from "../lib.mjs";

const API = "/git-sync/api";
const WS = `${API}/workspaces/${cfg.slug}`;
const hex = (n) => randomBytes(n).toString("hex");

/** POST a webhook through the public proxy exactly as the sender would; returns { status, data }. */
async function postHook(path, headers, body) {
  const [r] = await web([["POST", path, typeof body === "string" ? body : JSON.stringify(body),
    { raw: true, noOrigin: true, headers: { "content-type": "application/json", ...headers } }]], { as: "anonymous" });
  return r;
}

/** Nothing about this delivery reached the ledgers, the queue's audit trail or the links. */
async function assertNothingStored(deliveryId) {
  await sleep(4000);
  const audit = await sql("SELECT count(*)::int AS n FROM audit_log WHERE delivery_id = $1", [deliveryId]);
  const seen = await sql("SELECT count(*)::int AS n FROM webhook_deliveries WHERE delivery_id = $1", [deliveryId]);
  const spool = await sql("SELECT count(*)::int AS n FROM inbound_spool WHERE delivery_id = $1", [deliveryId]);
  eq([audit[0].n, seen[0].n, spool[0].n], [0, 0, 0], `rows for delivery ${deliveryId} (audit, deliveries, spool)`);
}

async function repoId() {
  return Number((await sql("SELECT gh_repo_id FROM repo_mappings WHERE id = $1", [cfg.mappingId]))[0].gh_repo_id);
}

const ghIssuePayload = async (number) => ({
  action: "opened",
  issue: { number, title: name("forged"), body: "forged", labels: [{ name: "plane" }], state: "open", html_url: `https://github.com/${cfg.repo}/issues/${number}` },
  repository: { id: await repoId(), full_name: cfg.repo },
  sender: { login: "attacker" },
});

scenario("S05", "Forged GitHub signature → 401, nothing stored", async ({ evidence }) => {
  const number = 900000 + Math.floor(Math.random() * 99999);
  const body = JSON.stringify(await ghIssuePayload(number));
  const variants = [
    ["random sha256", `sha256=${hex(32)}`],
    ["sha1 scheme", `sha1=${hex(20)}`],
    ["truncated", `sha256=${hex(16)}`],
    ["not hex", `sha256=${"z".repeat(64)}`],
  ];
  for (const [label, sig] of variants) {
    const delivery = `e2e-${cfg.runId}-s05-${label.replace(/\W/g, "")}`;
    const r = await postHook("/git-sync/webhooks/github", { "x-github-delivery": delivery, "x-github-event": "issues", "x-hub-signature-256": sig }, body);
    eq(r.status, 401, `${label} signature status`);
    evidence(`${label}`, `${r.status} ${JSON.stringify(r.data)}`);
    await assertNothingStored(delivery);
  }
  const links = await sql("SELECT count(*)::int AS n FROM sync_links WHERE gh_number = $1", [number]);
  eq(links[0].n, 0, "no sync link for the forged issue number");
}, { needs: ["plane", "db"] });

scenario("S06", "Missing GitHub signature → 401", async ({ evidence }) => {
  const body = JSON.stringify(await ghIssuePayload(900000 + Math.floor(Math.random() * 99999)));
  for (const [label, headers] of [["absent", {}], ["empty", { "x-hub-signature-256": "" }]]) {
    const delivery = `e2e-${cfg.runId}-s06-${label}`;
    const r = await postHook("/git-sync/webhooks/github", { "x-github-delivery": delivery, "x-github-event": "issues", ...headers }, body);
    eq(r.status, 401, `${label} signature status`);
    evidence(`signature ${label}`, `${r.status} ${JSON.stringify(r.data)}`);
    await assertNothingStored(delivery);
  }
}, { needs: ["plane", "db"] });

scenario("S07", "Forged Plane signature → 401", async ({ evidence }) => {
  const body = JSON.stringify({ event: "issue", action: "created", webhook_id: hex(8), workspace_id: hex(8),
    data: { id: "00000000-0000-4000-8000-000000000000", name: name("forged plane"), project: cfg.projectId, labels: [] }, activity: { field: null } });
  for (const [label, sig] of [["random", hex(32)], ["absent", undefined], ["sha256= prefixed", `sha256=${hex(32)}`]]) {
    const delivery = `e2e-${cfg.runId}-s07-${label.replace(/\W/g, "")}`;
    const r = await postHook("/git-sync/webhooks/plane", { "x-plane-delivery": delivery, "x-plane-event": "issue", ...(sig ? { "x-plane-signature": sig } : {}) }, body);
    eq(r.status, 401, `${label} Plane signature status`);
    evidence(`Plane signature ${label}`, `${r.status} ${JSON.stringify(r.data)}`);
    await assertNothingStored(delivery);
  }
}, { needs: ["plane", "db"] });

scenario("S08", "Oversized webhook body → 413 (proxy limit and the service's own 25 MiB limit)", async ({ evidence }) => {
  // 1) Through the public proxy: Plane's Caddy caps request bodies at FILE_SIZE_LIMIT (5 MiB on the test install).
  const big = "x".repeat(6 * 1024 * 1024);
  const viaProxy = await postHook("/git-sync/webhooks/github", { "x-github-delivery": `e2e-${cfg.runId}-s08`, "x-github-event": "issues",
    "x-hub-signature-256": `sha256=${hex(32)}` }, big).catch((e) => ({ status: `error ${e.message}` }));
  eq(viaProxy.status, 413, "6 MiB through the proxy");
  evidence("6 MiB via proxy", viaProxy.status);
  // 2) Straight to the service inside its container (no proxy): bodies above 25 MiB are refused before any signature work,
  //    both when Content-Length declares it and when an unannounced (chunked) stream grows past it.
  const direct = await app(`
    const http = await import("node:http");
    const send = (path, { declared, chunked }) => new Promise((resolve) => {
      const size = 25 * 1024 * 1024 + 4096;
      const headers = { "content-type": "application/json", "x-github-delivery": "e2e-s08", "x-github-event": "issues", "x-hub-signature-256": "sha256=" + "0".repeat(64),
        "x-plane-delivery": "e2e-s08", "x-plane-event": "issue", "x-plane-signature": "0".repeat(64) };
      if (declared) headers["content-length"] = String(size);
      const req = http.request(service + path, { method: "POST", headers }, (res) => {
        let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve({ status: res.statusCode, body: b.slice(0, 200) }));
      });
      req.on("error", (e) => resolve({ status: "socket " + e.code }));
      const chunk = Buffer.alloc(1024 * 1024, 120);
      let sent = 0;
      const pump = () => { while (sent < size) { sent += chunk.length; if (!req.write(chunk)) { req.once("drain", pump); return; } } req.end(); };
      pump();
    });
    return {
      githubDeclared: await send("/git-sync/webhooks/github", { declared: true }),
      githubChunked: await send("/git-sync/webhooks/github", { chunked: true }),
      planeDeclared: await send("/git-sync/webhooks/plane", { declared: true }),
    };`);
  for (const [k, v] of Object.entries(direct)) {
    evidence(`direct ${k}`, `${v.status} ${v.body ?? ""}`);
    // A 413 answer, or the connection cut after it (the service closes the socket so the client cannot keep streaming).
    assert(v.status === 413 || String(v.status).startsWith("socket"), `${k}: expected 413, got ${v.status}`);
  }
  assert(Object.values(direct).some((v) => v.status === 413), "at least one direct call must read the 413 answer");
  // 3) A body under both limits with a bad signature is a 401, so the 413s above are about size alone.
  const small = await postHook("/git-sync/webhooks/github", { "x-github-delivery": `e2e-${cfg.runId}-s08-small`, "x-github-event": "issues",
    "x-hub-signature-256": `sha256=${hex(32)}` }, JSON.stringify({ pad: "y".repeat(512 * 1024) }));
  eq(small.status, 401, "512 KiB forged body");
  evidence("512 KiB forged", small.status);
}, { needs: ["plane", "app"] });

scenario("S09", "Config API without a session → 401", async ({ evidence }) => {
  const routes = [`${WS}/mappings`, `${WS}/health`, `${WS}/mappings/${cfg.mappingId}/rules`, `${WS}/audit`, `${WS}/github/account`,
    `${API}/instance/health`, `${API}/instance/setup-check`, `${API}/instance/github-app`, `${API}/instance/disabled-mappings`];
  const anon = await web(routes.map((p) => ["GET", p]), { as: "anonymous" });
  routes.forEach((p, i) => eq(anon[i].status, 401, `anonymous GET ${p}`));
  evidence("anonymous", routes.map((p, i) => `${p.replace(API, "")}=${anon[i].status}`).join(", "));
  // Forged or malformed cookies are verified against Plane, not trusted.
  const forged = await web([
    ["GET", `${WS}/mappings`, undefined, { headers: { cookie: `session-id=${hex(16)}` } }],
    ["GET", `${API}/instance/health`, undefined, { headers: { cookie: `admin-session-id=${hex(16)}` } }],
    ["GET", `${WS}/mappings`, undefined, { headers: { cookie: `session-id=a"b; session-id=${hex(4)}` } }],
  ], { as: "anonymous" });
  forged.forEach((r, i) => eq(r.status, 401, `forged cookie call ${i}`));
  evidence("forged cookies", forged.map((r) => r.status).join(","));
  // The 401 body names no internals.
  assert(!/stack|at \w+ \(|plane-test|api:8000/i.test(JSON.stringify(anon[0].data)), `401 body leaks: ${JSON.stringify(anon[0].data)}`);
}, { needs: ["plane"] });

async function latestRuleVersion() {
  return Number((await sql("SELECT coalesce(max(version), 0)::int AS v FROM rule_sets WHERE mapping_id = $1", [cfg.mappingId]))[0].v);
}

scenario("S10", "Cross-origin and non-JSON writes → 403 / 415, nothing written", async ({ evidence }) => {
  const [cur] = await web([["GET", `${WS}/mappings/${cfg.mappingId}/rules`]]);
  eq(cur.status, 200, "read current rules");
  const before = await latestRuleVersion();
  const body = JSON.stringify({ yaml: cur.data.yaml });
  const path = `${WS}/mappings/${cfg.mappingId}/rules`;
  const calls = [
    ["evil origin", { headers: { origin: "https://evil.example", "content-type": "application/json" } }, 403],
    ["origin null", { headers: { origin: "null", "content-type": "application/json" } }, 403],
    ["lookalike origin", { headers: { origin: `${cfg.planeUrl}.evil.example`, "content-type": "application/json" } }, 403],
    ["no origin", { noOrigin: true, headers: { "content-type": "application/json" } }, 403],
    ["text/plain", { headers: { "content-type": "text/plain" } }, 415],
    ["form", { headers: { "content-type": "application/x-www-form-urlencoded" } }, 415],
    ["multipart", { headers: { "content-type": "multipart/form-data; boundary=x" } }, 415],
  ];
  const results = await web(calls.map(([, opts]) => ["PUT", path, body, { raw: true, ...opts }]));
  calls.forEach(([label, , want], i) => { eq(results[i].status, want, label); evidence(label, results[i].status); });
  // The guard runs before authentication: a cross-site request is refused even without a session.
  const [anon] = await web([["DELETE", `${WS}/mappings/${cfg.mappingId}`, undefined, { headers: { origin: "https://evil.example" } }]], { as: "anonymous" });
  eq(anon.status, 403, "anonymous cross-site DELETE mapping");
  evidence("anonymous cross-site DELETE", anon.status);
  eq(await latestRuleVersion(), before, "rule version unchanged");
  eq((await sql("SELECT count(*)::int AS n FROM repo_mappings WHERE id = $1", [cfg.mappingId]))[0].n, 1, "mapping still exists");
}, { needs: ["web", "db"] });

scenario("S11", "S1 traversal in a rule's create_issue project → 422, nothing stored", async ({ evidence }) => {
  const before = await latestRuleVersion();
  const rule = (project) => `- name: e2e-${cfg.runId}-traversal\n  when: [pull_request.merged]\n  then:\n    - create_issue: { project: ${JSON.stringify(project)}, title: "e2e" }\n`;
  const payloads = [`../../victim-ws/projects/${cfg.projectId}`, `%2e%2e/%2e%2e/victim-ws/projects/${cfg.projectId}`, "%2E%2E%2F%2E%2E%2Fvictim-ws",
    `${cfg.projectId}/..`, "..", `${cfg.projectKey}/../x`];
  const path = `${WS}/mappings/${cfg.mappingId}/rules`;
  const results = await web(payloads.map((p) => ["PUT", path, { yaml: rule(p) }]));
  payloads.forEach((p, i) => {
    eq(results[i].status, 422, `PUT rules with project ${p}`);
    assert(/project/i.test(results[i].data?.error ?? ""), `error names the project: ${JSON.stringify(results[i].data)}`);
  });
  evidence("422 for", payloads.join(" | "));
  evidence("message", results[0].data?.error);
  // Dry-run takes the same rules source: it must refuse too, not evaluate it.
  const [dry] = await web([["POST", `${WS}/dry-run`, { yaml: rule(payloads[0]), mappingId: cfg.mappingId, trigger: "pull_request.merged", payload: {} }]]);
  eq(dry.status, 422, `dry-run with traversal (${JSON.stringify(dry.data).slice(0, 200)})`);
  assert(/project/i.test(dry.data?.error ?? ""), `dry-run error names the project: ${JSON.stringify(dry.data)}`);
  evidence("dry-run", dry.status);
  eq(await latestRuleVersion(), before, "no rule version stored");
  eq((await sql("SELECT count(*)::int AS n FROM rule_sets WHERE yaml_source LIKE '%victim-ws%' OR yaml_source LIKE $1", [`%e2e-${cfg.runId}%`]))[0].n, 0, "no stored traversal rule");
  // Control: the same rule with the project's identifier is accepted by validation (dry-run only, nothing saved).
  const [ok] = await web([["POST", `${WS}/dry-run`, { yaml: rule(cfg.projectKey), mappingId: cfg.mappingId, trigger: "pull_request.merged", payload: {} }]]);
  assert(!/project must be/i.test(ok.data?.error ?? ""), `valid identifier refused: ${JSON.stringify(ok.data)}`);
  evidence("dry-run with a valid identifier", `${ok.status} ${JSON.stringify(ok.data).slice(0, 160)}`);
}, { needs: ["web", "db"] });

scenario("S12", "A non-admin cannot reach admin routes; an admin cannot reach another workspace", async ({ evidence, cleanup, log }) => {
  await ensureMemberUser();
  const otherSlug = `e2e-${cfg.runId}`.toLowerCase();
  // A second workspace owned by the member fixture; the test admin is not in it.
  const created = await planeOrmJson(`
from plane.db.models import User, Workspace, WorkspaceMember
owner = User.objects.get(email="e2e-member@test.local")
ws = Workspace.objects.create(name=${JSON.stringify(name("other workspace"))}, slug=${JSON.stringify(otherSlug)}, owner=owner)
WorkspaceMember.objects.create(workspace=ws, member=owner, role=20)
print(json.dumps({"id": str(ws.id)}))`);
  cleanup(async () => {
    // Hard delete (Plane soft-deletes by default), member rows first.
    const out = await planeOrm(`
from plane.db.models import Workspace, WorkspaceMember
for w in Workspace.all_objects.filter(slug=${JSON.stringify(otherSlug)}):
    for m in WorkspaceMember.all_objects.filter(workspace=w):
        m.delete(soft=False)
    w.delete(soft=False)
print("left", Workspace.all_objects.filter(slug=${JSON.stringify(otherSlug)}).count())`);
    if (!/left 0/.test(out)) throw new Error(`workspace ${otherSlug} not deleted: ${out.slice(-200)}`);
    await sql("DELETE FROM workspace_identity WHERE workspace_slug = $1", [otherSlug]);
  });
  log(`other workspace ${otherSlug} (${created.id})`);
  const before = await latestRuleVersion();

  // Member (role 15) of the test workspace.
  const m = await web([
    ["GET", `${WS}/mappings`], ["GET", `${WS}/health`], ["GET", `${WS}/audit`], ["GET", `${WS}/user-links`],
    ["PUT", `${WS}/mappings/${cfg.mappingId}/rules`, { yaml: "" }],
    ["PATCH", `${WS}/mappings/${cfg.mappingId}`, { smartCommitsEnabled: false }],
    ["GET", `${API}/instance/health`], ["GET", `${API}/instance/settings`],
    ["GET", `${WS}/github/account`],
  ], { as: "member" });
  const want = [403, 403, 403, 403, 403, 403, 401, 401, 200];
  want.forEach((s, i) => eq(m[i].status, s, `member call ${i}`));
  evidence("member", m.map((r) => r.status).join(","));
  evidence("member own-account route (allowed)", m[8].status);

  // Workspace admin of the test workspace, on the other workspace and on instance routes.
  const other = `${API}/workspaces/${otherSlug}`;
  const a = await web([
    ["GET", `${other}/mappings`], ["GET", `${other}/health`], ["GET", `${other}/github/account`],
    ["PUT", `${other}/mappings/${cfg.mappingId}/rules`, { yaml: "" }],
    ["GET", `${API}/instance/health`],
    ["GET", `${API}/workspaces/..%2F${cfg.slug}/mappings`], ["GET", `${API}/workspaces/${otherSlug}%2F..%2F${cfg.slug}/mappings`],
  ]);
  const aw = [403, 403, 403, 403, 401, 404, 404];
  aw.forEach((s, i) => eq(a[i].status, s, `admin call ${i}`));
  evidence("admin on other workspace / instance / encoded slugs", a.map((r) => r.status).join(","));
  // Nothing was bound or written for the other workspace, and the member wrote nothing.
  eq((await sql("SELECT count(*)::int AS n FROM workspace_identity WHERE workspace_slug = $1", [otherSlug]))[0].n, 0, "no identity row for the other slug");
  eq(await latestRuleVersion(), before, "rule version unchanged");
  eq((await sql("SELECT smart_commits_enabled FROM repo_mappings WHERE id = $1", [cfg.mappingId]))[0].smart_commits_enabled, true, "mapping not patched");
}, { needs: ["web", "member", "orm"] });

/** GET with the path sent byte-for-byte (fetch would normalise `..`). */
function rawGet(base, path) {
  return new Promise((resolve) => {
    const u = new URL(base);
    const req = http.request({ host: u.hostname, port: u.port, method: "GET", path, headers: { host: u.host } }, (res) => {
      let b = ""; res.setEncoding("utf8"); res.on("data", (d) => (b += d.length + b.length < 200000 ? d : "")); res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"] ?? "", body: b }));
    });
    req.on("error", (e) => resolve({ status: `error ${e.code}`, type: "", body: "" }));
    req.end();
  });
}

const TRAVERSALS = [
  "/git-sync/ui/../../package.json", "/git-sync/ui/..%2F..%2Fpackage.json", "/git-sync/ui/%2e%2e/%2e%2e/package.json",
  "/git-sync/ui/assets/..%2f..%2f..%2fsrc%2findex.ts", "/git-sync/ui/..%5c..%5cpackage.json", "/git-sync/ui/%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd",
  "/git-sync/ui/....//....//package.json", "/git-sync/ui/assets/%252e%252e%252fpackage.json", "/git-sync/ui/%00.js",
];
const leaked = (body) => /"dependencies"\s*:|export const BASE_PATH|root:x:0:0|import \{ createWebhookRoutes/.test(body);

scenario("S13", "Static file path traversal is refused", async ({ evidence }) => {
  const results = [];
  for (const p of TRAVERSALS) {
    const r = await rawGet(cfg.planeUrl, p);
    results.push(`${p} → ${r.status}`);
    assert(!leaked(r.body), `proxy ${p} leaked a file`);
    assert([200, 400, 404, 308, 301, 302].includes(r.status), `proxy ${p}: unexpected ${r.status}`);
    if (r.status === 200) assert(/text\/html/.test(r.type), `proxy ${p}: 200 must be the app shell, got ${r.type}`);
  }
  evidence("via proxy", results.join("; "));
  // Straight to the service, bypassing Caddy's path normalisation.
  const direct = await app(`
    const http = await import("node:http");
    const leaked = ${leaked.toString()};
    const get = (path) => new Promise((resolve) => {
      const req = http.request(service + "/", { method: "GET", path }, (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"] || "", leaked: leaked(b) })); });
      req.on("error", (e) => resolve({ status: "error " + e.code })); req.end();
    });
    const out = {};
    for (const p of ${JSON.stringify(TRAVERSALS)}) out[p] = await get(p);
    out.control = await get("/git-sync/ui/");
    return out;`);
  const { control, ...rest } = direct;
  eq(control.status, 200, "control: the app shell is served");
  for (const [p, r] of Object.entries(rest)) {
    eq(r.leaked, false, `direct ${p} leaked a file`);
    assert([200, 400, 404].includes(r.status), `direct ${p}: unexpected ${r.status}`);
    if (r.status === 200) assert(/text\/html/.test(r.type), `direct ${p}: 200 must be the app shell, got ${r.type}`);
  }
  eq(direct["/git-sync/ui/%00.js"].status === 400 || direct["/git-sync/ui/%00.js"].status === 404, true, "NUL byte path refused");
  evidence("direct to service", Object.entries(rest).map(([p, r]) => `${p} → ${r.status}`).join("; "));
}, { needs: ["plane", "app"] });
