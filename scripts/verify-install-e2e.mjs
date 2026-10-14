#!/usr/bin/env node
// End-to-end oracle for ./install.sh. Builds a throwaway Plane-shaped Compose project in Docker (Plane's real
// Postgres, Valkey and proxy images; small stand-ins for Plane's api and web), started the way Plane's setup.sh
// starts Plane (--env-file plane.env), then drives the real installer through install, re-run, a rejected key,
// uninstall and purge. Prints "INSTALL E2E PASSED" only when every assertion holds. Cleans up after itself.
import { spawnSync } from "node:child_process";
import { randomBytes, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const INSTALL = join(ROOT, "install.sh");
const failures = [];
const check = (cond, what) => { if (cond) console.log(`  ok   ${what}`); else { console.log(`  FAIL ${what}`); failures.push(what); } };
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20, ...opts });
const docker = (...args) => sh("docker", args);

const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function http(url) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(5000) }); return { status: r.status, body: await r.text() }; }
  catch (e) { return { status: 0, body: String(e) }; }
}
const parseEnv = (t) => Object.fromEntries(t.split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

const port = await freePort();
const project = `gsinst${randomBytes(3).toString("hex")}`;
const dir = mkdtempSync(join(tmpdir(), "gitsync-install-e2e-"));
const key = `plane_api_${randomBytes(12).toString("hex")}`;
const pgPassword = randomBytes(12).toString("hex");

// ---- the stand-in Plane ----------------------------------------------------------------------------------
mkdirSync(join(dir, "stub"));
writeFileSync(join(dir, "stub", "api.mjs"), `import { createServer } from "node:http";
createServer((req, res) => {
  if (req.url === "/api/v1/users/me/" && req.headers["x-api-key"] === process.env.STUB_KEY) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ id: "svc-user-1", email: "bot@e2e.test", display_name: "e2e bot" }));
  }
  res.writeHead(req.url.startsWith("/api/v1/") ? 403 : 404); res.end();
}).listen(8000);
`);
writeFileSync(join(dir, "docker-compose.yaml"), `services:
  plane-db:
    image: postgres:15.7-alpine
    environment:
      POSTGRES_USER: \${POSTGRES_USER:-plane}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:-plane}
      POSTGRES_DB: plane
  plane-redis:
    image: valkey/valkey:7.2.11-alpine
  api:
    image: node:24-alpine
    command: ["node", "/stub/api.mjs"]
    volumes: ["./stub:/stub:ro"]
    environment:
      WEB_URL: \${WEB_URL:-http://localhost}
      API_KEY_RATE_LIMIT: \${API_KEY_RATE_LIMIT:-60/minute}
      PGHOST: plane-db
      POSTGRES_USER: \${POSTGRES_USER:-plane}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:-plane}
      REDIS_URL: redis://plane-redis:6379/
      STUB_KEY: \${STUB_KEY:-}
  web:
    image: node:24-alpine
    command: ["node", "-e", "require('http').createServer((q, s) => s.end('plane web')).listen(3000)"]
  proxy:
    image: makeplane/plane-proxy:v1.4.2
    environment:
      SITE_ADDRESS: ":80"
      FILE_SIZE_LIMIT: "5242880"
      BUCKET_NAME: uploads
    ports:
      - "127.0.0.1:\${HTTP_PORT:-80}:80"
    depends_on: [api, web]
`);
// The operator's own override, with a comment, an extra service and a Compose merge tag.
const operatorOverride = `# operator notes: keep me
services:
  proxy:
    ports: !override
      - "127.0.0.1:\${HTTP_PORT:-80}:80"
  extra:
    image: node:24-alpine
    command: ["sleep", "infinity"]
`;
writeFileSync(join(dir, "docker-compose.override.yaml"), operatorOverride);
writeFileSync(join(dir, "plane.env"), [
  `POSTGRES_USER=planeadmin`, `POSTGRES_PASSWORD=${pgPassword}`, `WEB_URL=http://127.0.0.1:${port}`,
  `API_KEY_RATE_LIMIT=120/minute`, `HTTP_PORT=${port}`, `STUB_KEY=${key}`, "",
].join("\n"));

const compose = (...args) => sh("docker", ["compose", "-p", project, "--project-directory", dir, "-f", join(dir, "docker-compose.yaml"),
  "-f", join(dir, "docker-compose.override.yaml"), "--env-file", join(dir, "plane.env"), ...args]);
const cid = (svc) => compose("ps", "-q", svc).stdout.trim();
const psql = (sql, user = "planeadmin", db = "postgres") => compose("exec", "-T", "plane-db", "psql", "-U", user, "-d", db, "-tAc", sql);
const install = (args, env = {}) => {
  const r = sh(INSTALL, ["--plane-dir", dir, "--yes", ...args], { env: { ...process.env, ...env }, input: "" });
  return { ...r, out: `${r.stdout}\n${r.stderr}` };
};

async function cleanup() {
  compose("down", "-v", "--remove-orphans", "-t", "1");
  // Files written by the installer's container may belong to a remapped uid (rootless Docker): delete from a container.
  docker("run", "--rm", "-v", `${dir}:/d`, "--entrypoint", "sh", "node:24-alpine", "-c", "rm -rf /d/* /d/.[!.]*");
  sh("rm", ["-rf", dir]);
}

try {
  console.log(`Scratch Plane: ${dir} (project ${project}, port ${port})`);
  const up = compose("up", "-d");
  if (up.status !== 0) throw new Error(`could not start the scratch Plane: ${up.stderr}`);
  for (let i = 0; i < 60 && psql("SELECT 1").stdout.trim() !== "1"; i++) await sleep(1000);
  check(psql("SELECT 1").stdout.trim() === "1", "scratch Plane database is up");
  const before = { api: cid("api"), db: cid("plane-db"), redis: cid("plane-redis") };

  // ---- 1. install ----------------------------------------------------------------------------------------
  console.log("\n[install]");
  const first = install([], { GITSYNC_PLANE_PAT: key, GITSYNC_PLANE_WEBHOOK_SECRET: "plane_wh_e2e" });
  if (first.status !== 0 || process.env.SHOW_OUTPUT) console.log(first.out);
  check(first.status === 0, "install.sh exits 0");
  check(/git-sync is installed/.test(first.out), "install.sh reports success");
  check(first.out.includes("Plane env file: ") && first.out.includes("plane.env"), "detects that Plane runs with --env-file plane.env");
  check(first.out.includes(`--env-file plane.env up -d`), "prints the exact command to start Plane with git-sync included");
  check(!first.out.includes(key) && !first.out.includes("plane_wh_e2e") && !first.out.includes(pgPassword), "prints no secret");
  const health = await http(`http://127.0.0.1:${port}/git-sync/healthz`);
  check(health.status === 200 && health.body.includes('"status":"ok"'), "GET /git-sync/healthz through Plane's proxy answers 200 ok");
  check((await http(`http://127.0.0.1:${port}/`)).body === "plane web", "Plane's own routes still reach Plane");
  check(cid("api") === before.api && cid("plane-db") === before.db && cid("plane-redis") === before.redis, "Plane's api, database and redis were not recreated");

  const envPath = join(dir, "git-sync.env");
  const env1 = parseEnv(readFileSync(envPath, "utf8"));
  check((statSync(envPath).mode & 0o777) === 0o600, "git-sync.env is owner-only (0600)");
  check(env1.PLANE_SERVICE_USER_ID === "svc-user-1", "service user id came from the Plane API key");
  check(env1.PLANE_API_RATE_PER_MINUTE === "120", "rate limit follows Plane's API_KEY_RATE_LIMIT");
  check(env1.PUBLIC_ORIGIN === `http://127.0.0.1:${port}`, "public URL came from Plane's WEB_URL");
  check(Buffer.from(env1.GITSYNC_TOKEN_KEY ?? "", "base64").length === 32, "a 32-byte token key was generated");
  check(!("GITHUB_APP_ID" in env1), "no GitHub App needed at install time");

  const override1 = readFileSync(join(dir, "docker-compose.override.yaml"), "utf8");
  check(override1.startsWith("# operator notes: keep me") && override1.includes("extra:") && override1.includes("!override"), "operator's override entries, comment and !override tag are kept");
  check(override1.includes("git-sync:") && override1.includes("./git-sync/Caddyfile:/etc/caddy/Caddyfile:ro"), "override gains git-sync and the proxy route");
  check(cid("extra") !== "", "operator's extra service still runs");
  check(psql("SELECT 1 FROM pg_database WHERE datname = 'gitsync'").stdout.trim() === "1", "gitsync database was created");
  const migrated = sh("docker", ["exec", "-e", `PGPASSWORD=${decodeURIComponent(new URL(env1.DATABASE_URL).password)}`, cid("plane-db"),
    "psql", "-h", "127.0.0.1", "-U", "gitsync", "-d", "gitsync", "-tAc", "SELECT count(*) FROM github_app_config"]);
  check(migrated.status === 0 && migrated.stdout.trim() === "0", "git-sync logs in with its own password and its migrations ran");
  const logs = compose("logs", "git-sync").stdout;
  check(!/Missing required|Invalid GitHub configuration/.test(logs), "service started without GitHub App settings");
  const pem = join(dir, "git-sync", "github-app.pem");
  check(existsSync(pem) && statSync(pem).isFile(), "the key mount is a file, never a Docker-made directory");

  // ---- 2. re-run, adding a GitHub App ----------------------------------------------------------------------
  console.log("\n[re-run with a GitHub App]");
  const keyFile = join(dir, "app.pem");
  writeFileSync(keyFile, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }));
  const second = install(["--github-app-id", "4242", "--github-private-key", keyFile], { GITSYNC_GITHUB_WEBHOOK_SECRET: "gh_hook_e2e" });
  if (second.status !== 0) console.log(second.out);
  check(second.status === 0, "re-run exits 0 without asking for the Plane secrets again");
  const env2 = parseEnv(readFileSync(envPath, "utf8"));
  for (const k of ["GITSYNC_TOKEN_KEY", "DATABASE_URL", "PLANE_SERVICE_PAT", "PLANE_WEBHOOK_SECRET"]) check(env2[k] === env1[k], `re-run keeps ${k}`);
  check(env2.GITHUB_APP_ID === "4242" && env2.GITHUB_WEBHOOK_SECRET === "gh_hook_e2e", "GitHub App bootstrap was written");
  check(statSync(pem).size > 1000 && (statSync(pem).mode & 0o777) === 0o400, "App private key installed read-only (0400)");
  check(readFileSync(join(dir, "docker-compose.override.yaml"), "utf8") === override1, "override unchanged by the re-run");
  check((await http(`http://127.0.0.1:${port}/git-sync/healthz`)).body.includes('"status":"ok"'), "healthy after the re-run");
  const health2 = compose("exec", "-T", "git-sync", "node", "-e", "require('fs').readFileSync('/run/secrets/github-app.pem','utf8').includes('PRIVATE KEY')||process.exit(1)");
  check(health2.status === 0, "the service can read the mounted App key");

  // ---- 3. a rejected Plane key changes nothing --------------------------------------------------------------
  console.log("\n[rejected key]");
  const bad = install([], { GITSYNC_PLANE_PAT: "plane_api_wrong" });
  check(bad.status !== 0 && /rejected the API key/.test(bad.out), "a wrong Plane API key is refused with a clear message");
  check(parseEnv(readFileSync(envPath, "utf8")).PLANE_SERVICE_PAT === env1.PLANE_SERVICE_PAT, "git-sync.env untouched by the failed run");

  // ---- 4. uninstall keeps data ----------------------------------------------------------------------------
  console.log("\n[uninstall]");
  const un = install(["--uninstall"]);
  if (un.status !== 0) console.log(un.out);
  check(un.status === 0 && /git-sync has been removed/.test(un.out), "uninstall exits 0");
  check(cid("git-sync") === "", "git-sync container is gone");
  const override2 = readFileSync(join(dir, "docker-compose.override.yaml"), "utf8");
  check(!override2.includes("git-sync") && override2.includes("extra:") && override2.includes("!override"), "override is back to the operator's own entries");
  check(!(await http(`http://127.0.0.1:${port}/git-sync/healthz`)).body.includes('"status":"ok"'), "Plane's proxy no longer routes to git-sync");
  check((await http(`http://127.0.0.1:${port}/`)).body === "plane web", "Plane still serves after uninstall");
  check(existsSync(envPath) && psql("SELECT 1 FROM pg_database WHERE datname = 'gitsync'").stdout.trim() === "1", "settings and database are kept");

  // ---- 5. reinstall from kept settings, then purge ----------------------------------------------------------
  console.log("\n[reinstall, purge]");
  const again = install([]);
  check(again.status === 0 && (await http(`http://127.0.0.1:${port}/git-sync/healthz`)).body.includes('"status":"ok"'), "reinstall from kept settings needs no answers");
  check(parseEnv(readFileSync(envPath, "utf8")).GITSYNC_TOKEN_KEY === env1.GITSYNC_TOKEN_KEY, "reinstall keeps the token key");
  const purge = install(["--uninstall", "--purge"]);
  check(purge.status === 0, "purge exits 0");
  check(!existsSync(envPath) && !existsSync(join(dir, "git-sync")), "purge deletes git-sync.env and git-sync/");
  check(psql("SELECT count(*) FROM pg_database WHERE datname = 'gitsync'").stdout.trim() === "0", "purge drops the gitsync database");
  check(psql("SELECT count(*) FROM pg_database WHERE datname = 'plane'").stdout.trim() === "1", "Plane's database is untouched");
} catch (err) {
  failures.push(String(err?.stack ?? err));
  console.log(`  FAIL ${err?.message ?? err}`);
} finally {
  // E2E_KEEP=1 leaves the scratch Plane running (purged of git-sync) for manual checks.
  if (process.env.E2E_KEEP) console.log(`\nKept: ${dir} project ${project} port ${port} key-file ${join(dir, "plane.env")}`);
  else await cleanup();
}

if (failures.length) { console.log(`\nINSTALL E2E FAILED (${failures.length}):\n - ${failures.join("\n - ")}`); process.exit(1); }
console.log("\nINSTALL E2E PASSED");
