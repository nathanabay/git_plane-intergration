#!/usr/bin/env node
// Oracle: ./install.sh on a REAL Plane v1.4.2. Brings up a fresh, throwaway Plane exactly like Plane's setup.sh does
// (folder plane-app, docker-compose.yaml + plane.env, `docker compose -f docker-compose.yaml --env-file plane.env up -d`),
// published on 127.0.0.1 only. Creates a service account, workspace, API key and webhook inside Plane, runs the
// installer non-interactively, then checks git-sync against the real Plane: health through Plane's proxy, the Git Sync
// pages in Plane's forked admin, the service user resolved from the real API key, and a real Plane webhook delivery
// arriving in git-sync after a work item is created. Finishes with uninstall --purge and removes the Plane.
// Prints "REAL PLANE INSTALL PASSED" only when every assertion holds.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const failures = [];
const check = (cond, what) => { if (cond) console.log(`  ok   ${what}`); else { console.log(`  FAIL ${what}`); failures.push(what); } };
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20, ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
// Diagnostic: when a request fails, keep retrying for up to 60s and report what came back and when it recovered.
async function settle(url, ok) {
  const first = await http(url), t0 = Date.now();
  if (ok(first)) return { first, recoveredAfter: 0 };
  for (let r = first; Date.now() - t0 < 60000;) { await sleep(1000); r = await http(url); if (ok(r)) return { first, recoveredAfter: Date.now() - t0 }; }
  return { first, recoveredAfter: -1 };
}
// A fresh connection per request (agent: false). The test blocks in spawnSync while the installer replaces Plane's
// proxy, so it cannot notice the proxy closing a kept-alive connection; reusing that dead socket fails with
// UND_ERR_SOCKET although Plane is answering (reproduced: fetch, restart proxy inside spawnSync, fetch -> fails).
function http(url, init = {}) {
  return new Promise((done) => {
    // Content-Length, not chunked: Plane's API server reads a chunked body as empty (POST answered 400).
    const headers = { ...(init.headers ?? {}), ...(init.body ? { "content-length": Buffer.byteLength(init.body) } : {}) };
    const req = request(url, { method: init.method ?? "GET", headers, agent: false, timeout: 10000 }, (res) => {
      let body = ""; res.setEncoding("utf8"); res.on("data", (c) => (body += c)); res.on("end", () => done({ status: res.statusCode ?? 0, body }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => done({ status: 0, body: String(e) }));
    if (init.body) req.write(init.body);
    req.end();
  });
}

const PROJECT = "plane-app"; // what Plane's setup.sh folder gives Compose
if (sh("docker", ["ps", "-aq", "--filter", `label=com.docker.compose.project=${PROJECT}`]).stdout.trim()) {
  console.log(`REFUSED: a Compose project named ${PROJECT} already exists on this Docker; not touching it.`); process.exit(1);
}
const http_port = await freePort(), https_port = await freePort();
const parent = mkdtempSync(join(tmpdir(), "gitsync-real-plane-"));
const dir = join(parent, PROJECT);
mkdirSync(dir);

// Plane's own compose file (v1.4.2), with two test-only changes: ports bound to 127.0.0.1, and minio from its
// maintained continuation (minio/minio was withdrawn from Docker Hub; same image the test Plane uses).
let compose = readFileSync(join(ROOT, "scripts/fixtures/plane-compose.v1.4.2.yml"), "utf8")
  .replace("image: minio/minio:latest", "image: pgsty/minio@sha256:b6bfe7239bfc83fb90d31612d9704d86039dd714f7904b3f1ad68f211e602372")
  .replace(/(\n\s+)published: (\$\{LISTEN_HTTPS?_PORT:-\d+\})/g, "$1published: $2$1host_ip: 127.0.0.1");
writeFileSync(join(dir, "docker-compose.yaml"), compose);
const origin = `http://127.0.0.1:${http_port}`;
const pg = randomBytes(12).toString("hex");
writeFileSync(join(dir, "plane.env"), [
  "APP_RELEASE=v1.4.2", "APP_DOMAIN=127.0.0.1", `WEB_URL=${origin}`, `CORS_ALLOWED_ORIGINS=${origin}`,
  `LISTEN_HTTP_PORT=${http_port}`, `LISTEN_HTTPS_PORT=${https_port}`, "SITE_ADDRESS=:80",
  `SECRET_KEY=${randomBytes(32).toString("hex")}`, `LIVE_SERVER_SECRET_KEY=${randomBytes(16).toString("hex")}`,
  "POSTGRES_USER=plane", `POSTGRES_PASSWORD=${pg}`, "POSTGRES_DB=plane", `DATABASE_URL=postgresql://plane:${pg}@plane-db/plane`,
  `AWS_ACCESS_KEY_ID=${randomBytes(8).toString("hex")}`, `AWS_SECRET_ACCESS_KEY=${randomBytes(16).toString("hex")}`,
  "API_KEY_RATE_LIMIT=60/minute", "WEBHOOK_ALLOWED_HOSTS=git-sync.internal",
  // Plane's plane.env always sets this; Caddy refuses an empty acme_ca.
  "CERT_ACME_CA=https://acme-v02.api.letsencrypt.org/directory", "",
].join("\n"));

// Plane's files, plus the override once the installer has written one.
const dc = (...args) => sh("docker", ["compose", "-f", "docker-compose.yaml",
  ...(existsSync(join(dir, "docker-compose.override.yaml")) ? ["-f", "docker-compose.override.yaml"] : []), "--env-file", "plane.env", ...args], { cwd: dir });
const cid = (svc) => dc("ps", "-q", svc).stdout.trim();
const install = (args, env = {}) => { const r = sh(join(ROOT, "install.sh"), ["--plane-dir", dir, "--yes", ...args], { env: { ...process.env, ...env }, input: "" }); return { ...r, out: `${r.stdout}\n${r.stderr}` }; };

async function cleanup() {
  dc("down", "-v", "--remove-orphans", "-t", "2");
  sh("docker", ["run", "--rm", "-v", `${parent}:/d`, "--entrypoint", "sh", "node:24-alpine", "-c", "rm -rf /d/* /d/.[!.]*"]);
  sh("rm", ["-rf", parent]);
}

try {
  console.log(`Real Plane v1.4.2 in ${dir}, ${origin}`);
  // ---- Plane, started the way setup.sh starts it ----------------------------------------------------------
  const up = sh("docker", ["compose", "-f", "docker-compose.yaml", "--env-file", "plane.env", "up", "-d"], { cwd: dir });
  if (up.status !== 0) throw new Error(`Plane did not start: ${up.stderr.slice(-2000)}`);
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) { ready = (await http(`${origin}/api/instances/`)).status === 200; if (!ready) await sleep(5000); }
  check(ready, "real Plane is up (GET /api/instances/ 200 through Plane's proxy)");
  if (!ready) throw new Error("Plane never became ready");

  // ---- inside Plane: service account, workspace, API key, webhook ------------------------------------------
  const bootstrap = `
import json
from plane.db.models import User, Workspace, WorkspaceMember, APIToken, Webhook
u = User.objects.create(email="gitsync-bot@example.test", username="gitsync-bot", first_name="GitHub", last_name="Bot", display_name="gitsync-bot", is_active=True)
u.set_password("${randomBytes(12).toString("hex")}"); u.save()
w = Workspace.objects.create(name="Sync Test", slug="sync-test", owner=u)
WorkspaceMember.objects.create(workspace=w, member=u, role=20)
t = APIToken.objects.create(user=u, workspace=w, label="git-sync")
h = Webhook.objects.create(workspace=w, url="http://git-sync.internal:3100/git-sync/webhooks/plane", project=True, issue=True, module=True, cycle=True, issue_comment=True)
print("BOOT" + json.dumps({"user": str(u.id), "token": t.token, "secret": h.secret_key}))
`;
  const boot = sh("docker", ["exec", "-i", cid("api"), "python", "manage.py", "shell"], { input: bootstrap });
  const line = (boot.stdout.split("\n").find((l) => l.startsWith("BOOT")) ?? "").slice(4);
  if (!line) throw new Error(`could not bootstrap Plane: ${boot.stderr.slice(-1500)}`);
  const seed = JSON.parse(line);
  check(Boolean(seed.token && seed.secret && seed.user), "service account, workspace, API key and webhook created in Plane");
  const before = Object.fromEntries(["api", "worker", "beat-worker", "plane-db", "plane-redis", "plane-mq"].map((s) => [s, cid(s)]));

  // ---- install ----------------------------------------------------------------------------------------------
  console.log("\n[install on the real Plane]");
  const t0 = Date.now();
  const inst = install([], { GITSYNC_PLANE_PAT: seed.token, GITSYNC_PLANE_WEBHOOK_SECRET: seed.secret });
  console.log(inst.out.split("\n").map((l) => `    | ${l}`).join("\n"));
  check(inst.status === 0 && /git-sync is installed/.test(inst.out), `install.sh succeeds (${Math.round((Date.now() - t0) / 1000)}s)`);
  check(inst.out.includes("plane.env") && inst.out.includes("plane-admin-gitsync") , "detects setup.sh-style plane.env and uses the Git Sync Plane UI images on v1.4.2");
  check(!inst.out.includes(seed.token) && !inst.out.includes(seed.secret) && !inst.out.includes(pg), "prints no secret");
  check(Object.entries(before).every(([s, id]) => cid(s) === id), "Plane's api, workers, database, redis and queue were not recreated");

  const env = Object.fromEntries(sh("docker", ["run", "--rm", "-v", `${dir}:/p:ro`, "--user", "0", "node:24-alpine", "cat", "/p/git-sync.env"]).stdout
    .split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  check(env.PLANE_SERVICE_USER_ID === seed.user, "service user id resolved from the real Plane API key");
  check(env.PUBLIC_ORIGIN === origin && env.PLANE_API_RATE_PER_MINUTE === "60", "public URL and rate limit read from the real Plane");

  const health = await settle(`${origin}/git-sync/healthz`, (r) => r.status === 200 && r.body.includes('"status":"ok"'));
  check(health.recoveredAfter === 0, `GET /git-sync/healthz through Plane's own proxy right after install (first: ${health.first.status} ${health.first.body.slice(0, 120)}; ok after ${health.recoveredAfter}ms)`);
  check((await http(`${origin}/git-sync/ui/admin`)).status === 200, "git-sync settings app is served at /git-sync/ui/admin");
  const admin = await http(`${origin}/god-mode/git-sync/`);
  check(admin.status === 200, `Plane's admin (God mode) serves the Git Sync page (${admin.status})`);
  check(dc("ps", "--format", "{{.Image}}", "admin").stdout.includes("plane-admin-gitsync") && dc("ps", "--format", "{{.Image}}", "web").stdout.includes("plane-frontend-gitsync"), "admin and web run the Git Sync UI images");
  const unauth = await http(`${origin}/git-sync/api/instance/setup-check`);
  check(unauth.status === 401, `config API refuses requests without a Plane session (${unauth.status})`);

  // ---- a real Plane change reaches git-sync as a signed webhook ------------------------------------------------
  console.log("\n[Plane -> git-sync webhook]");
  const api = (method, path, body) => http(`${origin}/api/v1/workspaces/sync-test${path}`, { method,
    headers: { "X-API-Key": seed.token, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const proj = await api("POST", "/projects/", { name: "Sync Project", identifier: "SYNC" });
  const projectId = JSON.parse(proj.body || "{}").id;
  check(proj.status === 201 && projectId, `project created through the real Plane API (${proj.status})`);
  const item = await api("POST", `/projects/${projectId}/issues/`, { name: "Installer test work item" });
  check(item.status === 201, `work item created (${item.status})`);
  const dbPass = decodeURIComponent(new URL(env.DATABASE_URL).password);
  let delivered = 0;
  for (let i = 0; i < 40 && !delivered; i++) {
    const q = sh("docker", ["exec", "-e", `PGPASSWORD=${dbPass}`, cid("plane-db"), "psql", "-h", "127.0.0.1", "-U", "gitsync", "-d", "gitsync", "-tAc",
      "SELECT count(*) FROM webhook_deliveries WHERE source = 'plane'"]);
    delivered = Number(q.stdout.trim()) || 0;
    if (!delivered) await sleep(3000);
  }
  check(delivered > 0, `Plane's webhook reached git-sync and passed its signature check (${delivered} deliveries recorded)`);
  const logs = dc("logs", "git-sync").stdout;
  check(!/Invalid signature|Missing required/.test(logs), "no signature or configuration errors in git-sync's log");

  // ---- uninstall ----------------------------------------------------------------------------------------------
  console.log("\n[uninstall --purge]");
  const un = install(["--uninstall", "--purge"]);
  check(un.status === 0 && cid("git-sync") === "", "uninstall --purge removes git-sync");
  check(dc("ps", "--format", "{{.Image}}", "admin").stdout.includes("makeplane/plane-admin:v1.4.2"), "Plane's admin is back on Plane's own image");
  const after = await settle(`${origin}/api/instances/`, (r) => r.status === 200);
  check(after.recoveredAfter === 0, `Plane answers right after uninstall (first: ${after.first.status} ${after.first.body.slice(0, 120)}; ok after ${after.recoveredAfter}ms)`);
} catch (err) {
  failures.push(String(err?.message ?? err));
  console.log(`  FAIL ${err?.message ?? err}`);
} finally {
  if (process.env.KEEP_PLANE) console.log(`Kept: ${dir}`); else await cleanup();
}
if (failures.length) { console.log(`\nREAL PLANE INSTALL FAILED (${failures.length}):\n - ${failures.join("\n - ")}`); process.exit(1); }
console.log("\nREAL PLANE INSTALL PASSED");
