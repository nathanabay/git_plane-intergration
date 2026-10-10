#!/usr/bin/env node
// Oracle for task B3 (spec §8, §7.3, §7.6, §9). The config API authenticates every request
// against Plane's own session, re-checks the workspace role on every write with no caching,
// refuses cross-site writes, stores configuration locally only (no Plane writes), encrypts
// secrets, and serves the built React app for both entry routes.
import { resolve, join } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { strictEqual, deepStrictEqual, ok } from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";

const root = resolve(import.meta.dirname, "..");
const results = [];
async function check(name, fn) { try { await fn(); results.push([name, null]); } catch (e) { results.push([name, e]); } }

const { startServer } = await import(join(root, "src/index.ts"));
const { createConfigRoutes, createUiRoutes } = await import(join(root, "src/ui/api.ts"));
const { migrate } = await import(join(root, "src/db/migrate.ts"));
const { PgTokenStore } = await import(join(root, "src/db/token-store.ts"));
const { TokenVault } = await import(join(root, "src/auth/identity.ts"));

const db = new PGlite(); await db.waitReady; await migrate(db);
const KEY = Buffer.alloc(32, 9);

// ---- fake Plane: sessions, roles, and a record of every call -----------------------------------
const plane = { calls: [], roles: { "u-adm": { qelal: 20, other: 15 }, "u-mem": { qelal: 15 } } };
const sessions = { adm: { id: "u-adm", email: "adm@x.y" }, mem: { id: "u-mem", email: "mem@x.y" } };
const papi = createServer((req, res) => {
  const cookie = req.headers.cookie || "";
  plane.calls.push({ method: req.method, url: req.url, cookie });
  const send = (s, o) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  const sid = /(?:^|;\s*)session-id=([^;]+)/.exec(cookie)?.[1];
  const aid = /(?:^|;\s*)admin-session-id=([^;]+)/.exec(cookie)?.[1];
  if (req.url === "/api/instances/admins/me/") return aid === "inst" ? send(200, { id: "u-inst", email: "root@x.y" }) : send(401, { error: "Authentication credentials were not provided." });
  const user = sessions[sid];
  if (!user) return send(401, { error: "Authentication credentials were not provided." });
  if (req.url === "/api/users/me/") return send(200, { ...user, display_name: user.id });
  const m = /^\/api\/workspaces\/([^/]+)\/workspace-members\/me\/$/.exec(req.url);
  if (m) { const role = plane.roles[user.id]?.[m[1]]; return role ? send(200, { id: "wm", role, member: user.id }) : send(403, { error: "You don't have the required permissions." }); }
  send(404, { error: "Not found" });
});
await new Promise((r) => papi.listen(0, "127.0.0.1", r));
const ORIGIN = "https://tasks.qelal.et";
const srv = await startServer({ port: 0, host: "127.0.0.1", routes: createConfigRoutes({ db, planeInternalUrl: `http://127.0.0.1:${papi.address().port}`, publicOrigin: ORIGIN, tokenKey: KEY }) });
const base = `http://127.0.0.1:${srv.port}/git-sync/api`;
const call = (method, path, { cookie, body, origin = ORIGIN, type = "application/json" } = {}) =>
  fetch(base + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), ...(body !== undefined ? { "content-type": type } : {}) }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
const ADM = "session-id=adm; csrftoken=abc; ajs_anonymous_id=zzz", MEM = "session-id=mem";
const mapping = { ghRepoId: 555, ghRepoFullName: "acme/web", planeProjectId: "p1", syncDirection: "bidirectional", smartCommitsEnabled: true, linkbackComments: true };
const count = async (t) => (await db.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
let mappingId;

await check("no Plane session is 401; a member (role 15) is 403 for reads and writes; nothing is written", async () => {
  strictEqual((await call("GET", "/workspaces/qelal/mappings")).status, 401);
  strictEqual((await call("GET", "/workspaces/qelal/mappings", { cookie: "session-id=forged" })).status, 401);
  strictEqual((await call("GET", "/workspaces/qelal/mappings", { cookie: MEM })).status, 403);
  strictEqual((await call("POST", "/workspaces/qelal/mappings", { cookie: MEM, body: mapping })).status, 403);
  strictEqual(await count("repo_mappings"), 0);
});

await check("a workspace admin creates, lists, updates and deletes mappings in their workspace", async () => {
  const c = await call("POST", "/workspaces/qelal/mappings", { cookie: ADM, body: mapping });
  strictEqual(c.status, 201);
  mappingId = (await c.json()).id; ok(mappingId !== undefined);
  const list = await (await call("GET", "/workspaces/qelal/mappings", { cookie: ADM })).json();
  ok(Array.isArray(list) && list.length === 1 && list[0].ghRepoFullName === "acme/web", JSON.stringify(list));
  strictEqual((await call("PATCH", `/workspaces/qelal/mappings/${mappingId}`, { cookie: ADM, body: { smartCommitsEnabled: false } })).status, 200);
  const row = (await db.query(`SELECT * FROM repo_mappings`)).rows[0];
  strictEqual(row.workspace_slug, "qelal");
  strictEqual(row.smart_commits_enabled, false);
});

await check("invalid mapping bodies are 422 (direction outside §7.3, missing repo)", async () => {
  strictEqual((await call("POST", "/workspaces/qelal/mappings", { cookie: ADM, body: { ...mapping, syncDirection: "plane_to_github" } })).status, 422);
  strictEqual((await call("POST", "/workspaces/qelal/mappings", { cookie: ADM, body: { planeProjectId: "p1" } })).status, 422);
});

await check("cross-site writes are refused: missing or foreign Origin is 403, non-JSON is 415", async () => {
  strictEqual((await call("POST", "/workspaces/qelal/mappings", { cookie: ADM, body: mapping, origin: null })).status, 403);
  strictEqual((await call("POST", "/workspaces/qelal/mappings", { cookie: ADM, body: mapping, origin: "https://evil.example" })).status, 403);
  strictEqual((await call("POST", "/workspaces/qelal/mappings", { cookie: ADM, body: "a=b", type: "application/x-www-form-urlencoded" })).status, 415);
  strictEqual(await count("repo_mappings"), 1);
});

await check("an admin of one workspace is 403 in a workspace where they are only a member", async () => {
  strictEqual((await call("GET", "/workspaces/other/mappings", { cookie: ADM })).status, 403);
  strictEqual((await call("POST", "/workspaces/other/mappings", { cookie: ADM, body: mapping })).status, 403);
});

await check("a mapping id from another workspace is 404 through this workspace's path", async () => {
  plane.roles["u-adm"].third = 20;
  strictEqual((await call("PATCH", `/workspaces/third/mappings/${mappingId}`, { cookie: ADM, body: { smartCommitsEnabled: true } })).status, 404);
  strictEqual((await call("DELETE", `/workspaces/third/mappings/${mappingId}`, { cookie: ADM })).status, 404);
});

await check("the role is re-checked on every write: a demoted admin's next write is 403 (§8, no caching)", async () => {
  strictEqual((await call("PATCH", `/workspaces/qelal/mappings/${mappingId}`, { cookie: ADM, body: { linkbackComments: false } })).status, 200);
  plane.roles["u-adm"].qelal = 15;
  strictEqual((await call("PATCH", `/workspaces/qelal/mappings/${mappingId}`, { cookie: ADM, body: { linkbackComments: true } })).status, 403);
  plane.roles["u-adm"].qelal = 20;
});

await check("rule sets are validated by the §7.5 engine before storage: invalid YAML is 422 with the reason, valid YAML is versioned", async () => {
  const bad = await call("PUT", `/workspaces/qelal/mappings/${mappingId}/rules`, { cookie: ADM, body: { yaml: "- when: push\n  iff: { base_branch: main }\n  then: [ { comment: x } ]\n" } });
  strictEqual(bad.status, 422);
  ok(/index 0/.test((await bad.json()).error ?? ""), "422 does not carry the engine's reason");
  const yaml = "- when: pull_request.merged\n  if: { base_branch: \"^main$\" }\n  then:\n    - set_state: Done\n";
  strictEqual((await call("PUT", `/workspaces/qelal/mappings/${mappingId}/rules`, { cookie: ADM, body: { yaml } })).status, 200);
  strictEqual((await call("PUT", `/workspaces/qelal/mappings/${mappingId}/rules`, { cookie: ADM, body: { yaml } })).status, 200);
  const versions = (await db.query(`SELECT version FROM rule_sets ORDER BY version`)).rows.map((r) => Number(r.version));
  ok(versions.length >= 2 && versions.at(-1) > versions[0], `versions ${versions}`);
  const got = await (await call("GET", `/workspaces/qelal/mappings/${mappingId}/rules`, { cookie: ADM })).json();
  strictEqual(got.yaml, yaml);
});

await check("conflict policies default per §7.3 and reject unknown fields or policies", async () => {
  const def = await (await call("GET", `/workspaces/qelal/mappings/${mappingId}/conflict-policies`, { cookie: ADM })).json();
  strictEqual(def.title, "source_of_truth:github"); strictEqual(def.description, "source_of_truth:github");
  strictEqual(def.state, "last_write_wins"); strictEqual(def.assignees, "last_write_wins");
  strictEqual((await call("PUT", `/workspaces/qelal/mappings/${mappingId}/conflict-policies`, { cookie: ADM, body: { title: "whoever_shouts" } })).status, 422);
  strictEqual((await call("PUT", `/workspaces/qelal/mappings/${mappingId}/conflict-policies`, { cookie: ADM, body: { colour: "last_write_wins" } })).status, 422);
  strictEqual((await call("PUT", `/workspaces/qelal/mappings/${mappingId}/conflict-policies`, { cookie: ADM, body: { title: "source_of_truth:plane" } })).status, 200);
  strictEqual((await (await call("GET", `/workspaces/qelal/mappings/${mappingId}/conflict-policies`, { cookie: ADM })).json()).title, "source_of_truth:plane");
});

await check("unlinking a user removes the mapping and revokes their stored tokens (§9 revocation path)", async () => {
  strictEqual((await call("PUT", `/workspaces/qelal/user-links/u-mem`, { cookie: ADM, body: { githubLogin: "memgh" } })).status, 200);
  const vault = new TokenVault(new PgTokenStore(db), KEY);
  await vault.store("u-mem", "plane_pat", "plane_api_MEMSECRET");
  strictEqual((await call("DELETE", `/workspaces/qelal/user-links/u-mem`, { cookie: ADM })).status, 204);
  strictEqual(await vault.load("u-mem", "plane_pat"), null);
  strictEqual((await db.query(`SELECT count(*)::int AS n FROM user_map WHERE github_login = 'memgh'`)).rows[0].n, 0);
});

await check("instance settings need a Plane instance-admin session; GitHub App secrets are stored encrypted and never returned", async () => {
  const appBody = { appId: 4242, privateKey: "-----BEGIN RSA PRIVATE KEY-----\nSECRETKEYMATERIAL\n-----END RSA PRIVATE KEY-----", webhookSecret: "whsec_TOPSECRET", gheBaseUrl: null };
  strictEqual((await call("PUT", "/instance/github-app", { cookie: ADM, body: appBody })).status, 401);
  strictEqual((await call("PUT", "/instance/github-app", { cookie: "admin-session-id=nope", body: appBody })).status, 401);
  strictEqual((await call("PUT", "/instance/github-app", { cookie: "admin-session-id=inst", body: appBody })).status, 200);
  const got = await (await call("GET", "/instance/github-app", { cookie: "admin-session-id=inst" })).text();
  ok(!got.includes("SECRETKEYMATERIAL") && !got.includes("TOPSECRET"), "secret returned to the browser");
  ok(/"configured"\s*:\s*true/.test(got), got);
  const stored = JSON.stringify((await db.query(`SELECT * FROM github_app_config`)).rows);
  ok(!stored.includes("SECRETKEYMATERIAL") && !stored.includes("TOPSECRET") && stored.includes("v1:"), "secrets stored in plaintext");
  const words = await call("PUT", "/instance/magic-words", { cookie: "admin-session-id=inst", body: { closing: ["fixes", "closes"], non_closing: ["refs"], relation: ["relates to"] } });
  strictEqual(words.status, 200);
  strictEqual((await call("PUT", "/instance/magic-words", { cookie: "admin-session-id=inst", body: { closing: [] , bogus_tier: ["x"] } })).status, 422);
});

await check("configuration never writes to Plane, and only the Plane session cookie is forwarded (§8 residual risk)", () => {
  const writes = plane.calls.filter((c) => c.method !== "GET");
  deepStrictEqual(writes, [], `config API issued Plane writes: ${JSON.stringify(writes)}`);
  ok(plane.calls.length > 0);
  ok(plane.calls.every((c) => !/csrftoken|ajs_anonymous_id/.test(c.cookie)), "unrelated cookies were forwarded to Plane");
});

await check("the React app builds and both entry routes serve it; assets are served with types; traversal is refused", async () => {
  const out = mkdtempSync(join(tmpdir(), "gitsync-ui-"));
  try {
    const b = spawnSync(process.execPath, [join(root, "src/ui/build.mjs"), "--outdir", out], { cwd: root, encoding: "utf8" });
    strictEqual(b.status, 0, `build failed: ${b.stderr || b.stdout}`);
    ok(existsSync(join(out, "index.html")), "no index.html");
    const js = readdirSync(out, { recursive: true }).filter((f) => String(f).endsWith(".js"));
    ok(js.length >= 1, "no JS bundle");
    const ui = await startServer({ port: 0, host: "127.0.0.1", routes: createUiRoutes({ distDir: out }) });
    try {
      const u = `http://127.0.0.1:${ui.port}`;
      for (const p of ["/git-sync/ui/admin", "/git-sync/ui/workspaces/qelal", "/git-sync/ui/workspaces/qelal/rules"]) {
        const r = await fetch(u + p); strictEqual(r.status, 200, p); ok((r.headers.get("content-type") || "").startsWith("text/html"), p);
        ok((await r.text()).includes("<div id=\"root\""), `${p} is not the app shell`);
      }
      const html = readFileSync(join(out, "index.html"), "utf8");
      const src = /src="([^"]+\.js)"/.exec(html)?.[1];
      ok(src, "index.html references no script");
      const asset = await fetch(u + (src.startsWith("/") ? src : "/git-sync/ui/" + src));
      strictEqual(asset.status, 200, `asset ${src}`); ok(/javascript/.test(asset.headers.get("content-type") || ""));
      const raw = (path) => new Promise((ok2, no) => { const rq = httpRequest({ host: "127.0.0.1", port: ui.port, path }, (rs) => { rs.resume(); ok2(rs.statusCode); }); rq.on("error", no); rq.end(); });
      ok([400, 404].includes(await raw("/git-sync/ui/%2e%2e/%2e%2e/package.json")), "traversal not refused");
    } finally { await ui.close(); }
  } finally { rmSync(out, { recursive: true, force: true }); }
});

await srv.close(); papi.close(); await db.close();
let bad = 0;
for (const [name, err] of results) { if (err) { bad++; console.error(`FAIL: ${name}: ${String(err.message).split("\n")[0]}`); } else console.log(`ok   ${name}`); }
if (bad) process.exit(1);
console.log(`B3 config API verification passed (${results.length} checks)`);
