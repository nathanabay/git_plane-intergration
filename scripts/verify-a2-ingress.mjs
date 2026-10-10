#!/usr/bin/env node
// Oracle for task A2 (spec §4, §3, §1.2, §5). Signature verification exactly as Plane v1.4.2 and
// GitHub sign, enqueue-and-return, four BullMQ queues on Valkey under the gitsync prefix,
// GitHub App installation-token minting with caching, and the wired process end to end.
import { resolve, join } from "node:path";
import { createHmac, generateKeyPairSync, createVerify } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { strictEqual, deepStrictEqual, ok } from "node:assert/strict";
import { Queue } from "bullmq";
import { startValkey } from "./lib/valkey.mjs";

const root = resolve(import.meta.dirname, "..");
const results = [];
async function check(name, fn) { try { await fn(); results.push([name, null]); } catch (e) { results.push([name, e]); } }

const { startServer, WEBHOOK_PATHS } = await import(join(root, "src/index.ts"));
const { createWebhookRoutes } = await import(join(root, "src/api/handler.ts"));
const { createQueues, QUEUE_NAMES } = await import(join(root, "src/queue/index.ts"));
const { createGithubApp } = await import(join(root, "src/api/github-app.ts"));

// Python's json.dumps defaults, as Plane signs: separators ", " and ": ", ensure_ascii=True.
const pyStr = (str) => JSON.stringify(str).replace(/[\u0080-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
const pyJson = (v) => v === null ? "null" : Array.isArray(v) ? "[" + v.map(pyJson).join(", ") + "]"
  : typeof v === "object" ? "{" + Object.entries(v).map(([k, x]) => pyStr(k) + ": " + pyJson(x)).join(", ") + "}"
  : typeof v === "string" ? pyStr(v) : JSON.stringify(v);
const PLANE_SECRET = "plane-secret-123", GH_SECRET = "gh-secret-456";
const planeSig = (body, secret = PLANE_SECRET) => createHmac("sha256", secret).update(body).digest("hex");
const ghSig = (body, secret = GH_SECRET) => "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
const planePayload = { event: "issue", action: "update", webhook_id: "w1", workspace_id: "ws1", workspace_slug: "qelal", data: { id: "i1", name: "Fix — ünïcode" }, activity: { field: "state", new_value: "s2", old_value: "s1", actor: { id: "u1", email: "a@b.c" }, old_identifier: null, new_identifier: null } };

async function withHandler(deps, fn) {
  const jobs = [];
  const enqueue = deps.enqueue ?? (async (j) => { jobs.push(j); });
  const srv = await startServer({ port: 0, host: "127.0.0.1", routes: createWebhookRoutes({ planeSecret: PLANE_SECRET, githubSecret: GH_SECRET, ...deps, enqueue }) });
  try { await fn(`http://127.0.0.1:${srv.port}`, jobs); } finally { await srv.close(); }
}
const post = (url, body, headers) => fetch(url, { method: "POST", body, headers: { "content-type": "application/json", ...headers } });

await check("webhook routes are exactly the two POST endpoints of spec §3", async () => {
  const routes = createWebhookRoutes({ planeSecret: PLANE_SECRET, githubSecret: GH_SECRET, enqueue: async () => {} });
  deepStrictEqual(routes.map((r) => `${r.method} ${r.path}`).sort(), [`POST ${WEBHOOK_PATHS.github}`, `POST ${WEBHOOK_PATHS.plane}`].sort());
});

await check("a Plane delivery signed as Plane v1.4.2 signs it is verified over the raw body and enqueued", async () => {
  const body = pyJson(planePayload);
  ok(body.includes('", "') && body.includes('": '), "fixture is not python-style json");
  await withHandler({}, async (base, jobs) => {
    const r = await post(base + WEBHOOK_PATHS.plane, body, { "x-plane-signature": planeSig(body), "x-plane-delivery": "pd-1", "x-plane-event": "issue" });
    strictEqual(r.status, 200);
    strictEqual(jobs.length, 1);
    strictEqual(jobs[0].source, "plane"); strictEqual(jobs[0].deliveryId, "pd-1"); strictEqual(jobs[0].event, "issue");
    deepStrictEqual(jobs[0].payload, planePayload);
    ok(!Number.isNaN(Date.parse(jobs[0].receivedAt)));
  });
});

await check("Plane deliveries with a missing, wrong-secret or tampered signature are 401 and never enqueued", async () => {
  const body = pyJson(planePayload);
  await withHandler({}, async (base, jobs) => {
    const h = { "x-plane-delivery": "pd-2", "x-plane-event": "issue" };
    strictEqual((await post(base + WEBHOOK_PATHS.plane, body, h)).status, 401);
    strictEqual((await post(base + WEBHOOK_PATHS.plane, body, { ...h, "x-plane-signature": planeSig(body, "other") })).status, 401);
    strictEqual((await post(base + WEBHOOK_PATHS.plane, body.replace("s2", "s3"), { ...h, "x-plane-signature": planeSig(body) })).status, 401);
    strictEqual((await post(base + WEBHOOK_PATHS.plane, body, { ...h, "x-plane-signature": "zz" })).status, 401);
    strictEqual(jobs.length, 0);
  });
});

await check("a re-serialised body does not verify: the signature covers the exact bytes received", async () => {
  const body = pyJson(planePayload);
  await withHandler({}, async (base, jobs) => {
    const compact = JSON.stringify(planePayload);
    strictEqual((await post(base + WEBHOOK_PATHS.plane, compact, { "x-plane-signature": planeSig(body), "x-plane-delivery": "pd-3", "x-plane-event": "issue" })).status, 401);
    strictEqual(jobs.length, 0);
  });
});

await check("missing delivery/event headers are 400; invalid JSON with a valid signature is 400; events outside Plane's catalog are acknowledged but not enqueued", async () => {
  const body = pyJson(planePayload);
  await withHandler({}, async (base, jobs) => {
    strictEqual((await post(base + WEBHOOK_PATHS.plane, body, { "x-plane-signature": planeSig(body), "x-plane-event": "issue" })).status, 400);
    strictEqual((await post(base + WEBHOOK_PATHS.plane, body, { "x-plane-signature": planeSig(body), "x-plane-delivery": "pd-4" })).status, 400);
    const bad = "{not json";
    strictEqual((await post(base + WEBHOOK_PATHS.plane, bad, { "x-plane-signature": planeSig(bad), "x-plane-delivery": "pd-5", "x-plane-event": "issue" })).status, 400);
    const r = await post(base + WEBHOOK_PATHS.plane, body, { "x-plane-signature": planeSig(body), "x-plane-delivery": "pd-6", "x-plane-event": "page" });
    strictEqual(r.status, 200);
    strictEqual(jobs.length, 0);
  });
});

await check("GitHub deliveries verify X-Hub-Signature-256, enqueue with their event name, and ping is acknowledged without enqueueing", async () => {
  const body = JSON.stringify({ action: "opened", sender: { login: "octo", id: 1, type: "User" }, repository: { id: 9 } });
  await withHandler({}, async (base, jobs) => {
    const h = { "x-github-delivery": "gd-1", "x-github-event": "pull_request" };
    strictEqual((await post(base + WEBHOOK_PATHS.github, body, { ...h, "x-hub-signature-256": ghSig(body, "nope") })).status, 401);
    strictEqual((await post(base + WEBHOOK_PATHS.github, body, h)).status, 401);
    strictEqual((await post(base + WEBHOOK_PATHS.github, body, { ...h, "x-hub-signature-256": ghSig(body) })).status, 200);
    strictEqual(jobs.length, 1);
    strictEqual(jobs[0].source, "github"); strictEqual(jobs[0].event, "pull_request"); strictEqual(jobs[0].deliveryId, "gd-1");
    const ping = JSON.stringify({ zen: "x", hook_id: 1 });
    strictEqual((await post(base + WEBHOOK_PATHS.github, ping, { "x-github-delivery": "gd-2", "x-github-event": "ping", "x-hub-signature-256": ghSig(ping) })).status, 200);
    strictEqual(jobs.length, 1);
  });
});

await check("an enqueue failure is 503 so the sender retries; an oversized body is 413", async () => {
  const body = pyJson(planePayload);
  await withHandler({ enqueue: async () => { throw new Error("valkey down"); } }, async (base) => {
    strictEqual((await post(base + WEBHOOK_PATHS.plane, body, { "x-plane-signature": planeSig(body), "x-plane-delivery": "pd-7", "x-plane-event": "issue" })).status, 503);
  });
  await withHandler({ maxBodyBytes: 64 }, async (base, jobs) => {
    const big = JSON.stringify({ pad: "x".repeat(500) });
    strictEqual((await post(base + WEBHOOK_PATHS.plane, big, { "x-plane-signature": planeSig(big), "x-plane-delivery": "pd-8", "x-plane-event": "issue" })).status, 413);
    strictEqual(jobs.length, 0);
  });
});

await check("router: `:param` segments and a trailing `/*` prefix route, exact paths win, params decoded (B3 and the UI depend on this)", async () => {
  const hit = [];
  const srv = await startServer({ port: 0, host: "127.0.0.1", routes: [
    { method: "GET", path: "/git-sync/api/workspaces/:slug/mappings/:id", handler: (_q, r, p) => { hit.push(p); r.end("param"); } },
    { method: "GET", path: "/git-sync/api/workspaces/:slug/mappings/new", handler: (_q, r) => { r.end("exact"); } },
    { method: "GET", path: "/git-sync/ui/*", handler: (_q, r, p) => { hit.push(p); r.end("prefix"); } },
  ] });
  const base = `http://127.0.0.1:${srv.port}`;
  try {
    strictEqual(await (await fetch(base + "/git-sync/api/workspaces/qel%20al/mappings/7")).text(), "param");
    deepStrictEqual(hit[0], { slug: "qel al", id: "7" });
    strictEqual(await (await fetch(base + "/git-sync/api/workspaces/qelal/mappings/new")).text(), "exact");
    strictEqual(await (await fetch(base + "/git-sync/ui/workspaces/qelal/assets/app.js?v=1")).text(), "prefix");
    strictEqual(hit[1]["*"], "workspaces/qelal/assets/app.js");
    strictEqual((await fetch(base + "/git-sync/api/workspaces/qelal/mappings")).status, 404);
    strictEqual((await fetch(base + "/git-sync/api/workspaces/qelal/mappings/7", { method: "DELETE" })).status, 405);
    const raw = (path) => new Promise((ok2, no) => { const rq = httpRequest({ host: "127.0.0.1", port: srv.port, path, method: "GET" }, (rs) => { rs.resume(); ok2(rs.statusCode); }); rq.on("error", no); rq.end(); });
    strictEqual(await raw("/git-sync/ui/../api/workspaces/x/mappings/1"), 400);
    strictEqual(await raw("/git-sync/ui/%2e%2e/secret"), 400);
  } finally { await srv.close(); }
});

const vk = await startValkey();
await check("four queues on Valkey under the gitsync prefix; inbound jobs keyed by source and delivery id", async () => {
  deepStrictEqual(Object.values(QUEUE_NAMES).sort(), ["inbound-github", "inbound-plane", "outbound-github", "outbound-plane"]);
  const q = createQueues({ connectionUrl: vk.url, prefix: "gitsync" });
  try {
    for (const k of ["inboundGithub", "inboundPlane", "outboundPlane", "outboundGithub"]) {
      ok(q[k] instanceof Queue, `${k} is not a BullMQ Queue`);
      strictEqual(q[k].opts.prefix, "gitsync");
    }
    const job = { source: "plane", deliveryId: "pd-9", event: "issue", receivedAt: new Date().toISOString(), payload: planePayload };
    await q.enqueueInbound(job);
    await q.enqueueInbound(job);
    const probe = new Queue("inbound-plane", { connection: { url: vk.url }, prefix: "gitsync" });
    const jobs = await probe.getJobs(["waiting", "wait", "delayed", "prioritized"]);
    strictEqual(jobs.length, 1, `expected one job after a duplicate enqueue, got ${jobs.length}`);
    strictEqual(jobs[0].id, "plane-pd-9");
    deepStrictEqual(jobs[0].data, job);
    const ghJobs = await new Queue("inbound-github", { connection: { url: vk.url }, prefix: "gitsync" }).getJobs(["waiting", "wait"]);
    strictEqual(ghJobs.length, 0, "a plane job landed on the github queue");
    await probe.close();
  } finally { await q.close(); }
});

await check("GitHub App: a JWT signed with the app key mints an installation token, which is cached and reused", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  let mints = 0; const seen = [];
  const api = createServer((req, res) => {
    let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
      if (req.method === "POST" && req.url === "/app/installations/123/access_tokens") {
        mints++;
        const jwt = (req.headers.authorization || "").replace(/^bearer /i, "");
        const [h, p, s] = jwt.split(".");
        const v = createVerify("RSA-SHA256"); v.update(`${h}.${p}`);
        const claims = JSON.parse(Buffer.from(p, "base64url").toString());
        const valid = v.verify(publicKey, Buffer.from(s, "base64url")) && String(claims.iss) === "4242";
        res.writeHead(valid ? 201 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify(valid ? { token: "ghs_minted", expires_at: new Date(Date.now() + 3600e3).toISOString(), permissions: {}, repository_selection: "all" } : { message: "bad jwt" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  try {
    const gh = createGithubApp({ appId: 4242, privateKey, baseUrl: `http://127.0.0.1:${api.address().port}` });
    const o = await gh.installationOctokit(123);
    await o.request("GET /repos/{owner}/{repo}", { owner: "o", repo: "r" });
    await o.request("GET /repos/{owner}/{repo}", { owner: "o", repo: "r" });
    const o2 = await gh.installationOctokit(123);
    await o2.request("GET /repos/{owner}/{repo}", { owner: "o", repo: "r" });
    strictEqual(mints, 1, `minted ${mints} tokens; expected one cached token`);
    ok(seen.filter((s) => s.startsWith("GET /repos/o/r")).every((s) => /token ghs_minted$/.test(s)), seen.join("\n"));
  } finally { api.close(); }
});

await check("the wired service starts from env, verifies, and lands a Plane delivery on the inbound-plane queue", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gitsync-a2-"));
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  writeFileSync(join(dir, "key.pem"), privateKey);
  const port = 30000 + Math.floor(Math.random() * 20000);
  const env = { ...process.env, PORT: String(port), HOST: "127.0.0.1", REDIS_URL: vk.url, QUEUE_PREFIX: "gitsync", PLANE_WEBHOOK_SECRET: PLANE_SECRET, GITHUB_WEBHOOK_SECRET: GH_SECRET, GITHUB_APP_ID: "4242", GITHUB_PRIVATE_KEY_PATH: join(dir, "key.pem"), PLANE_BASE_URL: "http://127.0.0.1:1", PLANE_SERVICE_PAT: "plane_api_x", DATABASE_URL: "postgres://u:p@127.0.0.1:1/gitsync", GITSYNC_TOKEN_KEY: Buffer.alloc(32, 1).toString("base64") };
  const child = spawn(process.execPath, [join(root, "src/index.ts")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { await new Promise((r) => setTimeout(r, 100)); try { up = (await fetch(`http://127.0.0.1:${port}/git-sync/healthz`)).ok; } catch {} }
    ok(up, `service did not come up: ${out.slice(0, 400)}`);
    const body = pyJson({ ...planePayload, data: { id: "i-e2e" } });
    const r = await post(`http://127.0.0.1:${port}${WEBHOOK_PATHS.plane}`, body, { "x-plane-signature": planeSig(body), "x-plane-delivery": "pd-e2e", "x-plane-event": "issue" });
    strictEqual(r.status, 200);
    const probe = new Queue("inbound-plane", { connection: { url: vk.url }, prefix: "gitsync" });
    const job = await probe.getJob("plane-pd-e2e");
    await probe.close();
    ok(job, "delivery did not reach the inbound-plane queue");
    strictEqual(job.data.payload.data.id, "i-e2e");
    ok(!out.includes(PLANE_SECRET) && !out.includes("plane_api_x"), "a secret appeared in the service output");
  } finally { child.kill("SIGTERM"); await new Promise((r) => child.once("exit", r)); rmSync(dir, { recursive: true, force: true }); }
});

await check("the service refuses to start without a webhook secret, naming the variable", async () => {
  const env = { ...process.env, PORT: "0", REDIS_URL: vk.url, PLANE_WEBHOOK_SECRET: "", GITHUB_WEBHOOK_SECRET: GH_SECRET };
  const child = spawn(process.execPath, [join(root, "src/index.ts")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
  const code = await Promise.race([new Promise((r) => child.once("exit", r)), new Promise((r) => setTimeout(() => r("timeout"), 8000))]);
  if (code === "timeout") child.kill("SIGKILL");
  ok(code !== 0 && code !== "timeout", `exit code ${code}`);
  ok(out.includes("PLANE_WEBHOOK_SECRET"), `error does not name PLANE_WEBHOOK_SECRET: ${out.slice(0, 300)}`);
});

await vk.stop();
let bad = 0;
for (const [name, err] of results) { if (err) { bad++; console.error(`FAIL: ${name}: ${String(err.message).split("\n")[0]}`); } else console.log(`ok   ${name}`); }
if (bad) process.exit(1);
console.log(`A2 ingress verification passed (${results.length} checks)`);
