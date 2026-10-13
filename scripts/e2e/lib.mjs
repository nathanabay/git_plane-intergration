// End-to-end harness: drives the real test Plane v1.4.2 and the real GitHub App on nathanabay/gitsync-test.
// Contract: .unlazy/impl/briefs/e2e-suite.md ("Harness API"). Everything else exported here is an addition.
// Secrets (GitHub token, Plane keys, passwords, session cookies) are only held in memory and never printed.
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const HOME = homedir();
const PLANE_DIR = join(HOME, "plane-test");
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ---- configuration and the test-environment guard -----------------------------------------------

const TEST_PLANE = "http://100.85.50.109:8090";
const TEST_REPO = "nathanabay/gitsync-test";

function newRunId() {
  const d = new Date();
  const stamp = d.toISOString().slice(0, 16).replace(/[-:T]/g, "").slice(2); // yymmddhhmm
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}

export const cfg = Object.freeze({
  planeUrl: (process.env.E2E_PLANE_URL ?? TEST_PLANE).replace(/\/+$/, ""),
  slug: "gitsync-test",
  projectId: "972d93a8-6889-46b8-9b47-93f9e7546afb",
  projectKey: "GITSY",
  mappingId: 1,
  repo: process.env.E2E_REPO ?? TEST_REPO,
  owner: (process.env.E2E_REPO ?? TEST_REPO).split("/")[0],
  repoName: (process.env.E2E_REPO ?? TEST_REPO).split("/")[1],
  runId: process.env.E2E_RUN_ID ?? newRunId(),
  docker: { context: "rootless", db: "plane-test-plane-db-1", api: "plane-test-api-1", gitsync: "plane-test-git-sync-1" },
  /** git-sync seen from inside its own container (bypasses the Caddy proxy). */
  gitsyncInternal: "http://127.0.0.1:3100",
  outDir: join(ROOT, "docs", "impl", "e2e-runs"),
});

/** Refuses to run against anything but the test Plane and the test repository. Called on import. */
export function assertTestEnvironment(c = cfg) {
  let u;
  try { u = new URL(c.planeUrl); } catch { throw new Error(`E2E refused: Plane URL is not a URL`); }
  const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(u.hostname);
  if (!(c.planeUrl === TEST_PLANE || (loopback && u.protocol === "http:"))) {
    throw new Error(`E2E refused: Plane URL ${c.planeUrl} is not the test Plane (${TEST_PLANE}) or loopback`);
  }
  if (c.repo !== TEST_REPO) throw new Error(`E2E refused: repository ${c.repo} is not ${TEST_REPO}`);
  if (!/^[a-z0-9-]{4,40}$/i.test(c.runId)) throw new Error("E2E refused: run id must be [a-z0-9-]{4,40}");
}
assertTestEnvironment();

export const name = (s) => `[e2e ${cfg.runId}] ${s}`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- secrets (lazy, memory only) ------------------------------------------------------------------

const secrets = {};
function readKv(file) {
  return Object.fromEntries(readFileSync(file, "utf8").split("\n").filter((l) => l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
}
async function ghToken() {
  if (!secrets.gh) secrets.gh = (await run("gh", ["auth", "token"])).stdout.trim();
  if (!secrets.gh) throw new Error("no GitHub token from `gh auth token`");
  return secrets.gh;
}
function adminPat() {
  return (secrets.pat ??= readFileSync(join(PLANE_DIR, "git-sync", ".admin-pat"), "utf8").trim());
}
function adminCredentials() {
  return (secrets.admin ??= readKv(join(PLANE_DIR, ".admin-credentials")));
}

// ---- GitHub REST as the user ----------------------------------------------------------------------

const GH_API = "https://api.github.com";

/** Only the test repository (and read-only user/app endpoints) may be reached. */
function assertGhPath(method, path) {
  const p = path.replace(/^https:\/\/api\.github\.com/, "");
  if (p.startsWith("/repos/")) {
    const [, , owner, repo] = p.split(/[/?#]/);
    if (`${owner}/${repo}`.toLowerCase() !== cfg.repo.toLowerCase()) throw new Error(`E2E refused: GitHub path outside ${cfg.repo}: ${p}`);
    return p;
  }
  if (method === "GET" && /^\/(user|users\/[^/]+|rate_limit|search\/issues)(\/|\?|$)/.test(p)) return p;
  throw new Error(`E2E refused: GitHub path not allowed: ${method} ${p}`);
}

/** `path` may start with `repo:` for `/repos/<owner>/<repo>`, e.g. `gh("GET", "repo:/issues/1")`. */
export async function gh(method, path, body) {
  const p = assertGhPath(method.toUpperCase(), path.startsWith("repo:") ? `/repos/${cfg.repo}${path.slice(5)}` : path);
  const token = await ghToken();
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(GH_API + p, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28",
        "user-agent": "gitsync-e2e", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    // Secondary rate limits: back off and retry a few times.
    if ((res.status === 403 || res.status === 429) && attempt < 3 && /rate limit/i.test(text)) {
      await sleep(Number(res.headers.get("retry-after") ?? 20) * 1000);
      continue;
    }
    return { status: res.status, data, headers: Object.fromEntries(res.headers) };
  }
}

// ---- Plane v1 API as the admin ---------------------------------------------------------------------

/** `path` is relative to /api/v1/workspaces/<slug>; a path starting with /api/ is used as is. */
export async function plane(method, path, body) {
  const url = cfg.planeUrl + (path.startsWith("/api/") ? path : `/api/v1/workspaces/${cfg.slug}${path.startsWith("/") ? "" : "/"}${path}`);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { "x-api-key": adminPat(), accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    // The admin key is shared by both suite authors; Plane allows 60 requests per minute per key.
    if (res.status === 429 && attempt < 6) {
      await sleep(Math.min(60, Number(res.headers.get("retry-after") ?? 10)) * 1000 + 250);
      continue;
    }
    return { status: res.status, data };
  }
}

/** Every row of a paginated Plane v1 list. */
export async function planeAll(path) {
  const out = [];
  let cursor;
  for (let page = 0; page < 50; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const r = await plane("GET", `${path}${sep}per_page=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (r.status !== 200) throw new Error(`Plane GET ${path} → ${r.status}`);
    const rows = Array.isArray(r.data) ? r.data : r.data?.results ?? [];
    out.push(...rows);
    if (Array.isArray(r.data) || !r.data?.next_page_results || !r.data?.next_cursor) return out;
    cursor = r.data.next_cursor;
  }
  return out;
}

export const items = (id = "") => `/projects/${cfg.projectId}/work-items/${id ? `${id}/` : ""}`;

// ---- docker helpers ---------------------------------------------------------------------------------

const dockerEnv = { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? "/run/user/1001" };

function docker(args, input, { timeout = 120_000, env = {} } = {}) {
  return new Promise((resolveP, reject) => {
    const child = spawn("docker", ["--context", cfg.docker.context, ...args], { env: { ...dockerEnv, ...env } });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`docker ${args[0]} timed out`)); }, timeout);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveP({ stdout: out, stderr: err });
      else reject(Object.assign(new Error(`docker ${args.slice(0, 3).join(" ")} exited ${code}: ${err.trim().slice(-800)}`), { stdout: out, stderr: err }));
    });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

// ---- gitsync database ---------------------------------------------------------------------------------

function literal(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") { if (!Number.isFinite(v)) throw new Error("sql: non-finite number"); return String(v); }
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (v instanceof Date) return literal(v.toISOString());
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s.includes("\0")) throw new Error("sql: NUL in parameter");
  return `'${s.replace(/'/g, "''")}'`;
}

/** `$1…$n` are replaced by quoted literals (test harness only; values come from the scenarios). */
export async function sql(query, params = []) {
  const text = query.trim().replace(/;\s*$/, "").replace(/\$(\d+)/g, (_, n) => {
    if (Number(n) < 1 || Number(n) > params.length) throw new Error(`sql: missing parameter $${n}`);
    return literal(params[Number(n) - 1]);
  });
  const returnsRows = /^(select|with|values|table)\b/i.test(text) || /\breturning\b/i.test(text);
  const wrapped = !returnsRows ? text
    : /^(select|values|table)\b/i.test(text) || (/^with\b/i.test(text) && !/\b(insert|update|delete)\b/i.test(text))
      ? `SELECT coalesce(json_agg(t), '[]'::json) FROM (${text}) t`
      : `WITH t AS (${text}) SELECT coalesce(json_agg(t), '[]'::json) FROM t`;
  let stdout;
  try {
    ({ stdout } = await docker(["exec", "-i", cfg.docker.db, "sh", "-c",
      "unset PGHOST; exec psql -U gitsync -d gitsync -X -q -At -v ON_ERROR_STOP=1 -f -"], wrapped + ";\n"));
  } catch (e) {
    throw new Error(`sql: ${(e.stderr || e.message).replace(/^psql:<stdin>:\d+: /, "").trim().slice(0, 600)}`);
  }
  if (!returnsRows) return [];
  return JSON.parse(stdout.trim() || "[]");
}

// ---- Plane Django shell ---------------------------------------------------------------------------------

/** Runs Python in `manage.py shell` in the Plane API container; returns stdout. */
export async function planeOrm(pythonSnippet) {
  const { stdout } = await docker(["exec", "-i", cfg.docker.api, "python", "manage.py", "shell"], pythonSnippet + "\n");
  return stdout.split("\n").filter((l) => !/objects imported automatically/.test(l)).join("\n").trim();
}

/** planeOrm with a JSON answer: the snippet must `print(json.dumps(...))` as its last line. */
export async function planeOrmJson(pythonSnippet) {
  const out = await planeOrm(`import json\n${pythonSnippet}`);
  const last = out.split("\n").filter(Boolean).pop() ?? "null";
  return JSON.parse(last);
}

// ---- Node inside the git-sync container ---------------------------------------------------------------

const APP_PRELUDE = `
import { loadConfig } from "/app/src/config/env.ts";
import { createDb } from "/app/src/db/client.ts";
import { SecretString, loadTokenKey } from "/app/src/auth/identity.ts";
import { createCredentialSource } from "/app/src/app/credentials.ts";
import { createGithubClient } from "/app/src/app/github.ts";
import { PlaneClient } from "/app/src/sync/plane.ts";
const config = loadConfig(process.env);
const db = createDb(config.DATABASE_URL);
const tokenKey = loadTokenKey(process.env);
const credentials = createCredentialSource(db, tokenKey, config);
const ghClient = createGithubClient(credentials, db);
const planeClient = new PlaneClient({ baseUrl: config.PLANE_BASE_URL, token: new SecretString(config.PLANE_SERVICE_PAT) });
const installationOctokit = (id) => ghClient.installationOctokit(id);
const service = ${JSON.stringify(cfg.gitsyncInternal)};
`;

/**
 * Runs an async Node function body inside plane-test-git-sync-1 with `config`, `db`, `tokenKey`, `credentials`,
 * `ghClient`, `planeClient`, `installationOctokit(id)` and `service` (the internal base URL) in scope. Its return
 * value comes back JSON-decoded. Never return secrets from the body.
 */
export async function app(scriptBody, { timeout = 180_000 } = {}) {
  const file = `/tmp/e2e-${cfg.runId}-${randomBytes(4).toString("hex")}.mts`;
  const source = `${APP_PRELUDE}
let __code = 0;
try {
  const __r = await (async () => { ${scriptBody}\n })();
  process.stdout.write("\\n@@E2E@@" + JSON.stringify(__r ?? null) + "\\n");
} catch (e) {
  process.stdout.write("\\n@@E2E-ERR@@" + JSON.stringify(String(e?.message ?? e).slice(0, 2000)) + "\\n");
  __code = 1;
} finally { await db.close().catch(() => {}); }
process.exit(__code);
`;
  await docker(["exec", "-i", cfg.docker.gitsync, "sh", "-c", `cat > ${file}`], source);
  try {
    let stdout;
    try { ({ stdout } = await docker(["exec", "-w", "/app", cfg.docker.gitsync, "node", "--no-warnings", file], undefined, { timeout })); }
    catch (e) { stdout = e.stdout ?? ""; if (!stdout.includes("@@E2E")) throw e; }
    const err = stdout.match(/@@E2E-ERR@@(.*)/);
    if (err) throw new Error(`app(): ${JSON.parse(err[1])}`);
    const ok = stdout.match(/@@E2E@@(.*)/);
    if (!ok) throw new Error("app(): no result");
    return JSON.parse(ok[1]);
  } finally {
    await docker(["exec", cfg.docker.gitsync, "rm", "-f", file]).catch(() => {});
  }
}

// ---- Plane browser sessions -------------------------------------------------------------------------------

const MEMBER_EMAIL = "e2e-member@test.local";
const MEMBER_SECRET_FILE = join(PLANE_DIR, "git-sync", ".e2e-member");
const sessions = new Map();

class Jar {
  constructor() { this.c = new Map(); }
  take(res) {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [kv] = raw.split(";");
      const i = kv.indexOf("=");
      if (i > 0) this.c.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  }
  header() { return [...this.c].map(([k, v]) => `${k}=${v}`).join("; "); }
}

/** Fixture: a non-admin (role 15, Member) of the test workspace, created once and kept. Returns its Plane id. */
export async function ensureMemberUser() {
  if (!existsSync(MEMBER_SECRET_FILE)) {
    writeFileSync(MEMBER_SECRET_FILE, `${randomBytes(18).toString("base64url")}Aa1!\n`, { mode: 0o600 });
    chmodSync(MEMBER_SECRET_FILE, 0o600);
  }
  const password = readFileSync(MEMBER_SECRET_FILE, "utf8").trim();
  const out = await planeOrmJson(`
import uuid
from plane.db.models import User, Workspace, WorkspaceMember, Profile
u = User.objects.filter(email=${JSON.stringify(MEMBER_EMAIL)}).first()
if u is None:
    u = User(email=${JSON.stringify(MEMBER_EMAIL)}, username=uuid.uuid4().hex, first_name="E2E", last_name="Member", is_password_autoset=False, is_active=True)
u.set_password(${JSON.stringify(password)})
u.is_active = True
u.save()
Profile.objects.get_or_create(user=u)
ws = Workspace.objects.get(slug=${JSON.stringify(cfg.slug)})
m = WorkspaceMember.all_objects.filter(workspace=ws, member=u).first() if hasattr(WorkspaceMember, "all_objects") else WorkspaceMember.objects.filter(workspace=ws, member=u).first()
if m is None:
    m = WorkspaceMember(workspace=ws, member=u)
m.role = 15
m.is_active = True
m.deleted_at = None
m.save()
print(json.dumps({"id": str(u.id)}))`);
  return out.id;
}

async function signIn(kind) {
  const jar = new Jar();
  const csrf = await fetch(cfg.planeUrl + "/auth/get-csrf-token/");
  jar.take(csrf);
  const { csrf_token } = await csrf.json();
  let email, password;
  if (kind === "member") {
    await ensureMemberUser();
    email = MEMBER_EMAIL;
    password = readFileSync(MEMBER_SECRET_FILE, "utf8").trim();
  } else ({ EMAIL: email, PASSWORD: password } = adminCredentials());
  const path = kind === "instance" ? "/api/instances/admins/sign-in/" : "/auth/sign-in/";
  const res = await fetch(cfg.planeUrl + path, {
    method: "POST", redirect: "manual",
    headers: { cookie: jar.header(), "content-type": "application/x-www-form-urlencoded", origin: cfg.planeUrl, referer: cfg.planeUrl + "/" },
    body: new URLSearchParams({ csrfmiddlewaretoken: csrf_token, email, password }),
  });
  jar.take(res);
  const want = kind === "instance" ? "admin-session-id" : "session-id";
  if (!jar.c.has(want)) throw new Error(`Plane sign-in (${kind}) gave no ${want} cookie (status ${res.status})`);
  return jar;
}

async function session(kind) {
  if (!sessions.has(kind)) sessions.set(kind, signIn(kind));
  try { return await sessions.get(kind); } catch (e) { sessions.delete(kind); throw e; }
}

/**
 * Runs `[[method, path, body?, opts?], …]` as a signed-in Plane browser session and returns
 * `[{ status, data, headers }]`. Paths are relative to the Plane origin (e.g. `/git-sync/api/...`).
 * Like a browser, writes carry `Origin: <plane>` and JSON bodies `Content-Type: application/json`.
 * Options: `{ admin: true }` → God-mode (instance admin) session; `{ as: "member" }` → the non-admin fixture
 * user; `{ as: "anonymous" }` → no cookies. Per call `opts`: `{ headers, raw, noOrigin }` (`raw` sends the
 * body string unchanged). A call `["SCREENSHOT", "/page", undefined, { file?, expectText?: string[], textWaitMs? }]` saves a
 * PNG via headless Chromium and returns `{ status, file, found: { [text]: boolean }, frames: [{ title, src, width, height,
 * viewportHeight }] }` (page and every iframe checked).
 */
export async function web(calls, { admin = false, as } = {}) {
  const kind = as === "anonymous" ? "anonymous" : as === "member" ? "member" : admin ? "instance" : "web";
  const jar = kind === "anonymous" ? new Jar() : await session(kind);
  const results = [];
  for (const [method, path, body, opts = {}] of calls) {
    if (method === "SCREENSHOT") { results.push(await screenshot(jar, path, opts)); continue; }
    const headers = { accept: "application/json", cookie: jar.header() };
    if (!["GET", "HEAD"].includes(method.toUpperCase()) && !opts.noOrigin) headers.origin = cfg.planeUrl;
    let payload;
    if (body !== undefined) {
      payload = opts.raw ? body : JSON.stringify(body);
      if (!opts.raw) headers["content-type"] = "application/json";
    }
    Object.assign(headers, opts.headers ?? {});
    for (const [k, v] of Object.entries(headers)) if (v === null) delete headers[k];
    const res = await fetch(cfg.planeUrl + path, { method, headers, body: payload, redirect: "manual" });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    results.push({ status: res.status, data, headers: Object.fromEntries(res.headers) });
  }
  return results;
}

const PW_IMAGE = "mcr.microsoft.com/playwright:v1.55.0-noble";
const PW_CACHE = join(HOME, ".cache", "gitsync-e2e", "playwright");
const PW_SCRIPT = `const { chromium } = require("/pw/node_modules/playwright");
(async () => {
  const want = JSON.parse(process.env.E2E_EXPECT || "[]");
  const b = await chromium.launch();
  const c = await b.newContext({ viewport: { width: 1400, height: 900 } });
  await c.addCookies(JSON.parse(process.env.E2E_COOKIES));
  const p = await c.newPage();
  const r = await p.goto(process.env.E2E_URL, { waitUntil: "networkidle", timeout: 60000 });
  const found = Object.fromEntries(want.map((t) => [t, false]));
  // The settings app and the Development panel render inside iframes: read the page and every frame.
  const scan = async () => {
    const texts = [];
    for (const f of p.frames()) { try { texts.push(await f.evaluate(() => document.body ? document.body.innerText : "")); } catch {} }
    const all = texts.join("\\n");
    for (const t of want) if (all.includes(t)) found[t] = true;
    return want.every((t) => found[t]);
  };
  const deadline = Date.now() + Number(process.env.E2E_TEXT_WAIT_MS || 20000);
  while (!(await scan()) && Date.now() < deadline) {
    await p.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    await p.waitForTimeout(1000);
  }
  // Geometry of every iframe (nested ones too), measured in its parent document; viewportHeight is the top window's.
  const viewportHeight = await p.evaluate(() => window.innerHeight);
  const frames = [];
  for (const f of p.frames()) {
    try {
      frames.push(...await f.evaluate(() => [...document.querySelectorAll("iframe")].map((el) => {
        const box = el.getBoundingClientRect();
        return { title: el.title || "", src: el.getAttribute("src") || "", width: Math.round(box.width), height: Math.round(box.height) };
      })));
    } catch {}
  }
  for (const fr of frames) fr.viewportHeight = viewportHeight;
  await p.screenshot({ path: "/out/" + process.env.E2E_FILE, fullPage: true });
  console.log("@@PW@@" + JSON.stringify({ status: r ? r.status() : 0, finalUrl: p.url().replace(/[?#].*$/, ""), found, frames }));
  await b.close();
})().catch((e) => { console.log("@@PW@@" + JSON.stringify({ status: 0, error: String(e && e.message || e).slice(0, 500) })); process.exit(1); });`;

async function ensurePlaywright() {
  if (existsSync(join(PW_CACHE, "node_modules", "playwright", "package.json"))) return;
  mkdirSync(PW_CACHE, { recursive: true });
  await docker(["run", "--rm", "--network", "host", "-v", `${PW_CACHE}:/pw`, "-w", "/pw", PW_IMAGE, "sh", "-c",
    "npm init -y >/dev/null && npm i --silent --no-audit --no-fund playwright@1.55.0"], undefined, { timeout: 300_000 });
}

/**
 * SCREENSHOT call: loads `path` in headless Chromium with this session's cookies, waits for network idle, then
 * (with `expectText`) polls the page and every iframe for each string. Returns `{ status, file, found?, frames, finalUrl?, error? }`;
 * `found` maps each expected string to whether it appeared; `frames` is `[{ title, src, width, height, viewportHeight }]`
 * for every iframe on the page (nested included), in CSS pixels at a 1400×900 viewport.
 */
async function screenshot(jar, path, { file, expectText = [], textWaitMs = 20_000 } = {}) {
  const out = file ?? join(cfg.outDir, cfg.runId, `shot-${Date.now()}.png`);
  mkdirSync(dirname(out), { recursive: true });
  const fail = (error) => ({ status: 0, file: out, frames: [], ...(expectText.length ? { found: Object.fromEntries(expectText.map((t) => [t, false])) } : {}), error });
  try { await ensurePlaywright(); } catch (e) { return fail(`playwright setup failed: ${e.message.slice(0, 300)}`); }
  const scriptDir = join(PW_CACHE, "..", "scripts");
  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(join(scriptDir, "shot.cjs"), PW_SCRIPT);
  const cookies = [...jar.c].map(([cname, value]) => ({ name: cname, value, url: cfg.planeUrl }));
  let stdout = "";
  try {
    ({ stdout } = await docker(["run", "--rm", "--network", "host", "-v", `${dirname(out)}:/out`, "-v", `${PW_CACHE}:/pw:ro`,
      "-v", `${scriptDir}:/e2e:ro`, "-e", "E2E_COOKIES", "-e", "E2E_URL", "-e", "E2E_EXPECT", "-e", "E2E_FILE", "-e", "E2E_TEXT_WAIT_MS",
      "-w", "/tmp", PW_IMAGE, "node", "/e2e/shot.cjs"],
    // Cookies reach the container through the environment of `docker run` only, never its argv.
    undefined, { timeout: 240_000, env: { E2E_COOKIES: JSON.stringify(cookies), E2E_URL: cfg.planeUrl + path,
      E2E_EXPECT: JSON.stringify(expectText), E2E_FILE: out.split("/").pop(), E2E_TEXT_WAIT_MS: String(textWaitMs) } }));
  } catch (e) { stdout = e.stdout ?? ""; if (!stdout.includes("@@PW@@")) return fail(e.message.slice(0, 300)); }
  const line = stdout.split("\n").find((l) => l.startsWith("@@PW@@"));
  if (!line) return fail("no result from headless browser");
  return { file: out, ...JSON.parse(line.slice(6)) };
}

// ---- polling ------------------------------------------------------------------------------------------------

/** Polls `check` until it returns a truthy value (returned). Errors inside `check` are retried until timeout. */
export async function waitFor(check, { timeout = 120_000, interval = 3_000, label = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      const v = await check();
      if (v) return v;
      last = undefined;
    } catch (e) { last = e; }
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${Math.round(timeout / 1000)}s waiting for ${label}${last ? ` (last error: ${last.message})` : ""}`);
    }
    await sleep(interval);
  }
}

// ---- scenario registry -------------------------------------------------------------------------------------

export const registry = [];

export class SkipSignal extends Error { constructor(reason) { super(reason); this.skip = true; } }

/**
 * Registers a scenario. `fn(ctx)` gets `{ log, evidence, cleanup(fn), skip(reason), defect(id), id }`; it fails by
 * throwing. Options: `needs` (informational capability list), `timeout` (ms, default 300 s), `defect` (a known
 * defect id: a FAIL is reported as known, e.g. "E2E-1").
 */
export function scenario(id, title, fn, { needs = [], timeout, defect } = {}) {
  if (!/^S\d{2,3}$/.test(id)) throw new Error(`scenario id ${id} must look like S01`);
  if (registry.some((s) => s.id === id)) throw new Error(`duplicate scenario ${id}`);
  registry.push({ id, title, fn, needs, timeout, defect });
}

// ---- assertions -----------------------------------------------------------------------------------------------

export function assert(cond, message) { if (!cond) throw new Error(message); }
export function eq(actual, expected, what) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`.slice(0, 1000));
  }
}

// ---- shared helpers for GitHub ↔ Plane scenarios ---------------------------------------------------------------

/** Active sync link rows for a GitHub issue/PR number in the test repository. */
export async function linksForGh(number) {
  return sql(`SELECT l.* FROM sync_links l JOIN repo_mappings m ON m.gh_repo_id = l.gh_repo_id
    WHERE m.id = $1 AND l.gh_number = $2 ORDER BY l.id`, [cfg.mappingId, number]);
}
export async function linksForPlane(issueId) {
  return sql(`SELECT * FROM sync_links WHERE plane_issue_id = $1 ORDER BY id`, [issueId]);
}

/** Waits until a GitHub issue is linked to a Plane item; returns the Plane work item. */
export async function waitForPlaneItem(number, opts = {}) {
  const link = await waitFor(async () => (await linksForGh(number)).find((l) => l.status === "active" && l.gh_kind === "issue"),
    { label: `Plane item for GitHub #${number}`, ...opts });
  const r = await plane("GET", items(link.plane_issue_id));
  assert(r.status === 200, `Plane item ${link.plane_issue_id} → ${r.status}`);
  return r.data;
}

export async function projectStates() {
  return planeAll(`/projects/${cfg.projectId}/states/`);
}
export async function projectLabels() {
  return planeAll(`/projects/${cfg.projectId}/labels/`);
}
/** The project label with this name, created if missing (labels are fixtures and are kept). */
export async function ensurePlaneLabel(labelName, color = "#2f80ed") {
  const found = (await projectLabels()).find((l) => l.name.toLowerCase() === labelName.toLowerCase());
  if (found) return found;
  const r = await plane("POST", `/projects/${cfg.projectId}/labels/`, { name: labelName, color });
  assert(r.status === 201, `create Plane label ${labelName} → ${r.status}`);
  return r.data;
}
/** The repository label with this name, created if missing (kept). */
export async function ensureGhLabel(labelName, color = "5319e7") {
  const r = await gh("GET", `repo:/labels/${encodeURIComponent(labelName)}`);
  if (r.status === 200) return r.data;
  const c = await gh("POST", "repo:/labels", { name: labelName, color });
  assert(c.status === 201 || c.status === 422, `create GitHub label ${labelName} → ${c.status}`);
  return c.data;
}

/** Creates a GitHub issue named for the run and registers its closing as cleanup. */
export async function createGhIssue(ctx, title, body = "", labels = []) {
  const r = await gh("POST", "repo:/issues", { title: name(title), body, labels });
  assert(r.status === 201, `create GitHub issue → ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
  ctx.cleanup(async () => { await gh("PATCH", `repo:/issues/${r.data.number}`, { state: "closed" }); });
  ctx.evidence?.(`GitHub issue #${r.data.number}`, r.data.html_url);
  return r.data;
}

/** Creates a Plane work item named for the run and registers its deletion as cleanup. */
export async function createPlaneItem(ctx, title, fields = {}) {
  const r = await plane("POST", items(), { name: name(title), ...fields });
  assert(r.status === 201, `create Plane item → ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
  ctx.cleanup(async () => { await plane("DELETE", items(r.data.id)); });
  ctx.evidence?.(`Plane item ${cfg.projectKey}-${r.data.sequence_id}`, r.data.id);
  return r.data;
}
