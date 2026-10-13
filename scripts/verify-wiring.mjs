#!/usr/bin/env node
// Wave 5 end-to-end oracle: boots the real service process (src/index.ts) against throwaway
// Postgres 15.7 and Valkey, a fake Plane API and a fake GitHub API, then drives signed webhooks
// through ingress → queues → reducers → A4 write path, and checks the resulting API calls.
// The fake Plane answers item paths as `work-items/` (A10, what the client sends) and the deprecated `issues/`;
// the fake GitHub's /repos/.../issues/ routes are GitHub's own API and are not affected.
import { resolve, join } from "node:path";
import { createServer } from "node:http";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { strictEqual, ok } from "node:assert/strict";
import { startValkey } from "./lib/valkey.mjs";
import { startPostgres } from "./lib/postgres.mjs";

const root = resolve(import.meta.dirname, "..");
const results = [];
async function check(name, fn, ms = 90000) {
  let timer;
  const limit = new Promise((_, no) => { timer = setTimeout(() => no(new Error(`timed out after ${ms}ms`)), ms); });
  try { await Promise.race([fn(), limit]); results.push([name, null]); console.log(`ok   ${name}`); }
  catch (e) { results.push([name, e]); console.error(`FAIL: ${name}: ${String(e?.message ?? e).split("\n")[0]}`); }
  finally { clearTimeout(timer); }
}
const until = async (pred, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await pred()) return true; await new Promise((r) => setTimeout(r, 200)); } return false; };

// ---- fakes ----------------------------------------------------------------------------------------
const STATES = [
  { id: "s-backlog", name: "Backlog", group: "backlog" }, { id: "s-prog", name: "In Progress", group: "started" },
  { id: "s-review", name: "In Review", group: "started" }, { id: "s-done", name: "Done", group: "completed" },
  { id: "s-triage", name: "Triage", group: "triage" },
];
const plane = { calls: [] };
const planeApi = createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
    plane.calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null, key: req.headers["x-api-key"] });
    const send = (s, o) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.method === "GET" && /\/api\/v1\/workspaces\/qelal\/(?:issues|work-items)\/QLL-1\/$/.test(req.url)) return send(200, { id: "iss-1", project: "p-qll", project_id: "p-qll", sequence_id: 1, name: "Login bug" });
    if (req.method === "GET" && /\/(?:issues|work-items)\/QLL-\d+\/$/.test(req.url)) return send(404, { error: "Not found" });
    if (req.method === "GET" && /\/states\/(\?|$)/.test(req.url)) return send(200, { results: STATES, next_cursor: null, next_page_results: false });
    if (req.method === "GET" && /\/(?:issues|work-items)\/iss-1\/$/.test(req.url)) return send(200, { id: "iss-1", project: "p-qll" });
    if (req.method === "PATCH") return send(200, { id: "x" });
    if (req.method === "POST" && /\/links\/$/.test(req.url)) return send(201, { id: `link-${plane.calls.length}` });
    if (req.method === "POST") return send(201, { id: `new-${plane.calls.length}` });
    send(200, {});
  });
});
const gh = { calls: [] };
const ghApi = createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
    gh.calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
    const send = (s, o) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.method === "POST" && /\/app\/installations\/\d+\/access_tokens$/.test(req.url)) return send(201, { token: "ghs_e2e", expires_at: new Date(Date.now() + 3600e3).toISOString() });
    if (/\/commits\//.test(req.url)) return send(200, { commit: { verification: { verified: true } } });
    send(req.method === "POST" ? 201 : 200, { id: 1, number: 1 });
  });
});
await new Promise((r) => planeApi.listen(0, "127.0.0.1", r));
await new Promise((r) => ghApi.listen(0, "127.0.0.1", r));

const vk = await startValkey();
const pgs = await startPostgres();
const dir = mkdtempSync(join(tmpdir(), "gitsync-e2e-"));
writeFileSync(join(dir, "key.pem"), generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey);
const PLANE_SECRET = "e2e-plane", GH_SECRET = "e2e-gh";
const port = 31000 + Math.floor(Math.random() * 15000);
const ui = spawnSync(process.execPath, [join(root, "src/ui/build.mjs"), "--outdir", join(root, "dist/ui")], { cwd: root, encoding: "utf8" });
const env = { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATABASE_URL: pgs.url, REDIS_URL: vk.url, QUEUE_PREFIX: "gitsync",
  PLANE_BASE_URL: `http://127.0.0.1:${planeApi.address().port}`, PLANE_SERVICE_PAT: "plane_api_SERVICE", PLANE_SERVICE_USER_ID: "u-service",
  PLANE_WEBHOOK_SECRET: PLANE_SECRET, GITHUB_APP_ID: "4242", GITHUB_PRIVATE_KEY_PATH: join(dir, "key.pem"), GITHUB_WEBHOOK_SECRET: GH_SECRET,
  GITHUB_API_BASE_URL: `http://127.0.0.1:${ghApi.address().port}`, GITSYNC_TOKEN_KEY: Buffer.alloc(32, 4).toString("base64"), PUBLIC_ORIGIN: "https://tasks.qelal.et" };
const child = spawn(process.execPath, [join(root, "src/index.ts")], { env, stdio: ["ignore", "pipe", "pipe"] });
let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
const base = `http://127.0.0.1:${port}`;
const pg = (await import("pg")).default;
const sql = new pg.Client(pgs.url); sql.on("error", () => {});

const ghHook = (event, payload, id) => { const body = JSON.stringify(payload); return fetch(base + "/git-sync/webhooks/github", { method: "POST", body, headers: { "content-type": "application/json", "x-github-event": event, "x-github-delivery": id, "x-hub-signature-256": "sha256=" + createHmac("sha256", GH_SECRET).update(body).digest("hex") } }); };
const planeHook = (payload, id) => { const body = JSON.stringify(payload); return fetch(base + "/git-sync/webhooks/plane", { method: "POST", body, headers: { "content-type": "application/json", "x-plane-event": payload.event, "x-plane-delivery": id, "x-plane-signature": createHmac("sha256", PLANE_SECRET).update(body).digest("hex") } }); };
const repo = { id: 555, name: "web", full_name: "acme/web", owner: { login: "acme" } };

try {
  await check("the service boots, migrates its database, serves health, the UI and the config API", async () => {
    ok(ui.status === 0, `UI build failed: ${ui.stderr}`);
    ok(await until(async () => { try { return (await fetch(base + "/git-sync/healthz")).ok; } catch { return false; } }, 60000), `service did not start: ${out.slice(0, 500)}`);
    await sql.connect();
    // Wait for the LAST migration, not the first table: later checks write to tables from later migrations.
    const lastMigration = readdirSync(join(root, "src/db/migrations")).filter((f) => f.endsWith(".sql")).sort().at(-1);
    ok(await until(async () => {
      if ((await sql.query(`SELECT to_regclass('public.schema_migrations') AS t`)).rows[0].t === null) return false;
      return (await sql.query(`SELECT 1 FROM schema_migrations WHERE version = $1`, [lastMigration])).rows.length > 0;
    }, 30000), `migrations never reached ${lastMigration}`);
    const page = await fetch(base + "/git-sync/ui/admin");
    strictEqual(page.status, 200); ok((await page.text()).includes('id="root"'));
    strictEqual((await fetch(base + "/git-sync/api/workspaces/qelal/mappings")).status, 401);
  });

  await check("a PR opened with 'Fixes QLL-1' links the item, moves it to In Progress through A4, and adds a PR rollup link", async () => {
    const { compileLifecycleRules, QLL_DEFAULTS } = await import(join(root, "src/github/pr-automation.ts"));
    // The mapping's installation must be on the workspace's allow-list, or every event for it is refused.
    await sql.query(`INSERT INTO workspace_installations (installation_id, workspace_slug, account_login) VALUES (1, 'qelal', 'acme') ON CONFLICT DO NOTHING`);
    const m = (await sql.query(`INSERT INTO repo_mappings (workspace_slug, gh_repo_id, gh_repo_full_name, plane_project_id, sync_direction, smart_commits_enabled, installation_id) VALUES ('qelal', 555, 'acme/web', 'p-qll', 'bidirectional', true, 1) RETURNING id`)).rows[0].id;
    await sql.query(`INSERT INTO rule_sets (mapping_id, yaml_source, version) VALUES ($1, $2, 1)`, [m, compileLifecycleRules(QLL_DEFAULTS)]);
    plane.calls.length = 0;
    const r = await ghHook("pull_request", { action: "opened", installation: { id: 1 }, repository: repo, sender: { login: "octo", id: 1, type: "User" },
      pull_request: { number: 12, title: "Fix login", body: "Fixes QLL-1", draft: false, merged: false, state: "open", html_url: "https://github.com/acme/web/pull/12", base: { ref: "main" }, head: { ref: "octo/login" }, labels: [], user: { login: "octo" } } }, "e2e-pr-1");
    strictEqual(r.status, 200);
    ok(await until(() => plane.calls.some((c) => c.method === "PATCH" && /\/(?:issues|work-items)\/iss-1\/$/.test(c.url) && c.body?.state === "s-prog")), `no state write; Plane saw ${JSON.stringify(plane.calls.map((c) => c.method + " " + c.url))}; service: ${out.slice(-600)}`);
    ok(await until(() => plane.calls.some((c) => c.method === "POST" && /\/(?:issues|work-items)\/iss-1\/links\/$/.test(c.url) && /pull\/12/.test(c.body?.url ?? ""))), "no PR link on the work item");
    ok(await until(async () => (await sql.query(`SELECT tier FROM sync_links WHERE plane_issue_id = 'iss-1' AND gh_number = 12`)).rows[0]?.tier === "closing"), "sync link with tier closing not recorded");
    ok(plane.calls.filter((c) => c.method !== "GET").every((c) => c.key === "plane_api_SERVICE"), "writes did not use the service PAT");
  });

  await check("Plane's echo of that write is dropped on ingress and causes no further writes", async () => {
    await new Promise((r) => setTimeout(r, 500));
    const before = gh.calls.filter((c) => c.method !== "GET" && !/access_tokens/.test(c.url)).length + plane.calls.filter((c) => c.method !== "GET").length;
    strictEqual((await planeHook({ event: "issue", action: "update", workspace_slug: "qelal", data: { id: "iss-1", project: "p-qll" }, activity: { field: "state", new_value: "s-prog", old_value: "s-backlog", actor: { id: "u-human", email: "h@x.y" } } }, "e2e-echo-1")).status, 200);
    ok(await until(async () => (await sql.query(`SELECT outcome FROM audit_log WHERE delivery_id = 'e2e-echo-1'`)).rows[0]?.outcome === "echo"), "echo was not recognised");
    await new Promise((r) => setTimeout(r, 1500));
    const after = gh.calls.filter((c) => c.method !== "GET" && !/access_tokens/.test(c.url)).length + plane.calls.filter((c) => c.method !== "GET").length;
    strictEqual(after, before, "the echo produced writes — a sync loop");
  });

  await check("a Smart Commit pushed by an unmapped sender comments as the service, ignoring the forged author (§7.2)", async () => {
    plane.calls.length = 0;
    await ghHook("push", { ref: "refs/heads/main", installation: { id: 1 }, repository: repo, sender: { login: "stranger", id: 99, type: "User" }, pusher: { name: "boss", email: "boss@corp" },
      commits: [{ id: "f".repeat(40), message: "QLL-1 #comment e2e hello", author: { name: "Boss", email: "boss@corp", username: "boss" } }], head_commit: { id: "f".repeat(40) } }, "e2e-push-1");
    ok(await until(() => plane.calls.some((c) => c.method === "POST" && /\/(?:issues|work-items)\/iss-1\/comments\/$/.test(c.url) && /e2e hello/.test(JSON.stringify(c.body)))), `no Smart Commit comment; Plane saw ${JSON.stringify(plane.calls.map((c) => c.method + " " + c.url))}`);
    ok(plane.calls.filter((c) => c.method === "POST").every((c) => c.key === "plane_api_SERVICE"));
    ok(await until(async () => (await sql.query(`SELECT count(*)::int AS n FROM audit_log WHERE kind ILIKE '%identity_fallback%'`)).rows[0].n >= 1), "fallback not audited");
  });

  await check("redelivering the same GitHub delivery id has no second effect", async () => {
    const n = () => plane.calls.filter((c) => c.method === "POST" && /comments/.test(c.url)).length;
    const before = n();
    await ghHook("push", { ref: "refs/heads/main", installation: { id: 1 }, repository: repo, sender: { login: "stranger", id: 99, type: "User" }, commits: [{ id: "f".repeat(40), message: "QLL-1 #comment e2e hello", author: { email: "boss@corp" } }] }, "e2e-push-1");
    await new Promise((r) => setTimeout(r, 2000));
    strictEqual(n(), before);
  });

  await check("SIGTERM shuts the whole service down cleanly", async () => {
    const exited = new Promise((r) => child.once("exit", (code) => r(code)));
    child.kill("SIGTERM");
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r("timeout"), 15000))]);
    strictEqual(code, 0, `exit ${code}`);
  });
} finally {
  if (child.exitCode === null) child.kill("SIGKILL");
  try { await sql.end(); } catch {}
  planeApi.close(); ghApi.close(); await vk.stop(); await pgs.stop(); rmSync(dir, { recursive: true, force: true });
}
let bad = 0;
for (const [, err] of results) if (err) bad++;
if (bad) process.exit(1);
console.log(`end-to-end wiring verification passed (${results.length} checks)`);
process.exit(0);
