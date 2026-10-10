#!/usr/bin/env node
// Oracle for task A1 (spec §3). Checks the compose fragment against Plane's real v1.4.2 compose
// file, the Caddy route, the image and env artifacts, and boots the service to probe it.
import { readFileSync, existsSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const fails = [];
const fail = (m) => fails.push(m);
const read = (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : null);

// 1. Compose fragment merges onto upstream v1.4.2 compose.
const override = "docker-compose.override.yaml";
if (!read(override)) fail(`${override} missing`);
else {
  const r = spawnSync("docker", ["compose", "-p", "gitsyncverify", "--project-directory", root,
    "-f", "scripts/fixtures/plane-compose.v1.4.2.yml", "-f", override, "config", "--format", "json"],
    { cwd: root, encoding: "utf8", env: { ...process.env, APP_RELEASE: "v1.4.2" } });
  if (r.status !== 0) fail(`docker compose config failed: ${(r.stderr || "").split("\n").filter((l) => !/level=warning/.test(l)).join(" ").slice(0, 400)}`);
  else {
    const cfg = JSON.parse(r.stdout);
    const svc = cfg.services?.["git-sync"];
    if (!svc) fail("compose: no git-sync service");
    else {
      if (!svc.image) fail("git-sync: no image (the fragment must reference a built image, not a build context on the host)");
      const nets = svc.networks || {};
      if (!("default" in nets)) fail("git-sync: not on the default network");
      if (!("gateway" in nets)) fail("git-sync: not on the gateway network");
      const aliases = nets.gateway?.aliases || [];
      if (!aliases.includes("git-sync")) fail("git-sync: gateway alias 'git-sync' missing");
      if (svc.ports?.length) fail("git-sync: publishes host ports; traffic must arrive only through Caddy");
      if (!svc.healthcheck?.test) fail("git-sync: no healthcheck");
      if (!svc.restart) fail("git-sync: no restart policy");
      const deps = Object.keys(svc.depends_on || {});
      for (const d of ["plane-db", "plane-redis"]) if (!deps.includes(d)) fail(`git-sync: does not depend_on ${d}`);
    }
    if (cfg.networks?.gateway?.external !== true) fail("compose: gateway network is not declared external");
    const admin = cfg.services?.admin?.image, web = cfg.services?.web?.image;
    if (admin !== "plane-admin-gitsync:v1.4.2") fail(`compose: admin image resolves to ${admin}, expected plane-admin-gitsync:v1.4.2`);
    if (web !== "plane-frontend-gitsync:v1.4.2") fail(`compose: web image resolves to ${web}, expected plane-frontend-gitsync:v1.4.2`);
    for (const s of ["api", "worker", "plane-db", "proxy"]) {
      if (!cfg.services?.[s]) fail(`compose: merge dropped upstream service ${s}`);
    }
  }
}

// 2. Caddy route sits inside the site block, before the catch-all.
const caddy = read("deploy/caddy/Caddyfile");
if (!caddy) fail("deploy/caddy/Caddyfile missing");
else {
  const code = caddy.split("\n").map((l) => l.replace(/#.*$/, "")).join("\n");
  const site = code.indexOf("tasks.qelal.et");
  const handle = code.search(/handle\s+\/git-sync\/\*\s*\{/);
  const rp = code.search(/reverse_proxy\s+git-sync:3100/);
  const catchAll = code.search(/reverse_proxy\s+plane-proxy:80/);
  if (site < 0) fail("Caddyfile: no tasks.qelal.et site block");
  if (handle < 0) fail("Caddyfile: no `handle /git-sync/* {` route");
  if (rp < 0) fail("Caddyfile: no `reverse_proxy git-sync:3100`");
  if (catchAll < 0) fail("Caddyfile: catch-all `reverse_proxy plane-proxy:80` missing");
  if (site >= 0 && handle >= 0 && catchAll >= 0 && !(site < handle && handle < rp && rp < catchAll)) {
    fail("Caddyfile: the git-sync route must sit inside the site block and before the catch-all");
  }
  if (/handle_path\s+\/git-sync/.test(code) || /uri\s+strip_prefix/.test(code)) {
    fail("Caddyfile: the prefix must not be stripped; the service serves under /git-sync/");
  }
}

// 3. Image and env artifacts.
const df = read("Dockerfile");
if (!df) fail("Dockerfile missing");
else {
  if (!/^FROM\s+node:24/m.test(df)) fail("Dockerfile: base image must be node:24*");
  if (!/^EXPOSE\s+3100\b/m.test(df)) fail("Dockerfile: EXPOSE 3100 missing");
  if (!/^USER\s+(?!root\b)\S+/m.test(df)) fail("Dockerfile: must drop to a non-root USER");
  if (!/src\/index\.ts/.test(df)) fail("Dockerfile: CMD must run src/index.ts");
}
const di = read(".dockerignore");
if (!di) fail(".dockerignore missing");
else for (const p of ["node_modules", ".git", ".unlazy"]) if (!di.split("\n").some((l) => l.trim().replace(/^\//, "") === p)) fail(`.dockerignore: does not exclude ${p}`);
const env = read("deploy/git-sync.env.example");
const REQUIRED_ENV = ["PORT", "DATABASE_URL", "REDIS_URL", "QUEUE_PREFIX", "PLANE_BASE_URL", "PLANE_SERVICE_PAT",
  "PLANE_WEBHOOK_SECRET", "GITHUB_APP_ID", "GITHUB_PRIVATE_KEY_PATH", "GITHUB_WEBHOOK_SECRET", "GITSYNC_TOKEN_KEY"];
if (!env) fail("deploy/git-sync.env.example missing");
else {
  for (const k of REQUIRED_ENV) if (!new RegExp(`^${k}=`, "m").test(env)) fail(`env example: ${k} missing`);
  if (!/^DATABASE_URL=\S*\/gitsync\b/m.test(env)) fail("env example: DATABASE_URL must target the gitsync database");
  if (!/^QUEUE_PREFIX=gitsync\s*$/m.test(env)) fail("env example: QUEUE_PREFIX must be gitsync");
  if (!/^PORT=3100\s*$/m.test(env)) fail("env example: PORT must be 3100");
}
const sql = read("deploy/sql/000-create-database.sql");
if (!sql || !/CREATE\s+DATABASE\s+gitsync/i.test(sql)) fail("deploy/sql/000-create-database.sql must CREATE DATABASE gitsync");
const apply = read("deploy/APPLY.md");
if (!apply) fail("deploy/APPLY.md missing");
else for (const k of ["docker-compose.override.yaml", "Caddyfile", "000-create-database.sql", "git-sync.env", "API_KEY_RATE_LIMIT", "docker build"]) {
  if (!apply.includes(k)) fail(`APPLY.md: never mentions ${k}`);
}

// 4. Boot the service and probe it.
async function freePort() {
  return new Promise((ok, no) => { const s = createServer(); s.once("error", no); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
}
async function probe() {
  if (!read("src/index.ts")) { fail("src/index.ts missing"); return; }
  const mod = await import(join(root, "src/index.ts"));
  if (mod.DEFAULT_PORT !== 3100) fail(`src/index.ts: DEFAULT_PORT is ${mod.DEFAULT_PORT}, expected 3100`);
  if (mod.BASE_PATH !== "/git-sync") fail("src/index.ts: BASE_PATH must be /git-sync");
  if (mod.WEBHOOK_PATHS?.plane !== "/git-sync/webhooks/plane" || mod.WEBHOOK_PATHS?.github !== "/git-sync/webhooks/github") fail("src/index.ts: WEBHOOK_PATHS wrong");
  if (typeof mod.startServer !== "function") { fail("src/index.ts: startServer not exported"); return; }

  // In-process: a registered route is dispatched, and close() releases the port.
  const p1 = await freePort();
  const srv = await mod.startServer({ port: p1, host: "127.0.0.1", routes: [{ method: "POST", path: "/git-sync/webhooks/plane", handler: (_req, res) => { res.statusCode = 202; res.end("queued"); } }] });
  const r1 = await fetch(`http://127.0.0.1:${p1}/git-sync/webhooks/plane`, { method: "POST", body: "{}" });
  if (r1.status !== 202) fail(`registered route not dispatched (status ${r1.status})`);
  const r1b = await fetch(`http://127.0.0.1:${p1}/git-sync/webhooks/plane`);
  if (r1b.status !== 405 && r1b.status !== 404) fail(`wrong method on a registered path returned ${r1b.status}, expected 405 or 404`);
  await srv.close();

  // As a process: env PORT, health, 404s, graceful SIGTERM.
  const port = await freePort();
  const child = spawn(process.execPath, [join(root, "src/index.ts")], { env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try { const r = await fetch(`http://127.0.0.1:${port}/git-sync/healthz`); up = true;
      if (r.status !== 200) fail(`/git-sync/healthz returned ${r.status}`);
      const body = await r.json().catch(() => null);
      if (body?.status !== "ok") fail(`/git-sync/healthz body must be JSON {"status":"ok"}, got ${JSON.stringify(body)}`);
    } catch { /* not up yet */ }
  }
  if (!up) { fail(`service never answered on PORT=${port}; output: ${out.slice(0, 300)}`); child.kill("SIGKILL"); return; }
  for (const path of ["/healthz", "/git-sync/definitely-not-a-route"]) {
    const r = await fetch(`http://127.0.0.1:${port}${path}`);
    if (r.status !== 404) fail(`${path} returned ${r.status}, expected 404`);
  }
  const exited = new Promise((r) => child.once("exit", (code, sig) => r({ code, sig })));
  child.kill("SIGTERM");
  const res = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 5000))]);
  if (!res) { fail("service did not exit within 5s of SIGTERM"); child.kill("SIGKILL"); }
  else if (res.code !== 0) fail(`service exited ${res.code}/${res.sig} on SIGTERM, expected a clean 0`);
}
await probe().catch((e) => fail(`probe threw: ${e.message}`));

if (fails.length) { for (const f of fails) console.error("FAIL: " + f); process.exit(1); }
console.log("A1 deploy verification passed");
