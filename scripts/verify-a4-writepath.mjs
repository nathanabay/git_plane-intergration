#!/usr/bin/env node
// Oracle for task A4 (spec §5, §3, §7.1, §9, §1.3). The single write path: field-granular op
// hashes recorded before the write and forgotten on failure, echoes consumed once on ingress,
// Plane's 400/409 semantics, the triage ban, the 429 deferral contract (contract 2), and the queue workers.
// Plane item paths: the client uses `work-items/` (A10; v1.4.2 serves the same views under the deprecated
// `issues/`), so the fake answers both. GitHub's /repos/.../issues/ routes are a different API and unchanged.
import { resolve, join } from "node:path";
import { createServer } from "node:http";
import { strictEqual, deepStrictEqual, ok, rejects, notStrictEqual } from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Queue } from "bullmq";
import { startValkey } from "./lib/valkey.mjs";

const root = resolve(import.meta.dirname, "..");
const results = [];
async function check(name, fn, ms = 60000) {
  let timer;
  const limit = new Promise((_, no) => { timer = setTimeout(() => no(new Error(`timed out after ${ms}ms`)), ms); });
  try { await Promise.race([fn(), limit]); results.push([name, null]); console.log(`ok   ${name}`); }
  catch (e) { results.push([name, e]); console.error(`FAIL: ${name}: ${String(e?.message ?? e).split("\n")[0]}`); }
  finally { clearTimeout(timer); }
}

const { opHash, normalizeValue } = await import(join(root, "src/sync/ophash.ts"));
const plane = await import(join(root, "src/sync/plane.ts"));
const gh = await import(join(root, "src/sync/github.ts"));
const workers = await import(join(root, "src/queue/workers.ts"));
const { EventRouter } = await import(join(root, "src/sync/router.ts"));
const { migrate } = await import(join(root, "src/db/migrate.ts"));
const { SecretString } = await import(join(root, "src/auth/identity.ts"));

const db = new PGlite(); await db.waitReady; await migrate(db);
const opsCount = async (hashes) => (await db.query(`SELECT count(*)::int AS n FROM applied_ops WHERE op_hash = ANY($1)`, [hashes])).rows[0].n;

// ---- fake Plane API ---------------------------------------------------------------------------
const STATES = [
  { id: "s-backlog", name: "Backlog", group: "backlog", default: true },
  { id: "s-progress", name: "In Progress", group: "started" },
  { id: "s-triage", name: "Triage", group: "triage" },
];
const fake = { requests: [], script: [], opsAtWrite: null };
const api = createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d)); req.on("end", async () => {
    const entry = { method: req.method, url: req.url, key: req.headers["x-api-key"], body: body ? JSON.parse(body) : null };
    fake.requests.push(entry);
    const send = (status, obj, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(obj)); };
    const next = fake.script.shift();
    if (next) return send(next.status, next.body, next.headers);
    if (req.method === "GET" && /\/states\/(\?|$)/.test(req.url)) {
      if (!req.url.includes("cursor=page2")) return send(200, { results: STATES.slice(0, 2), next_cursor: "page2", next_page_results: true });
      return send(200, { results: STATES.slice(2), next_cursor: null, next_page_results: false });
    }
    if (req.method === "PATCH" && /\/(?:issues|work-items)\/[^/]+\/$/.test(req.url)) {
      if (fake.hashesToProbe) fake.opsAtWrite = await opsCount(fake.hashesToProbe);
      return send(200, { id: req.url.split("/").at(-2), ...entry.body });
    }
    if (req.method === "POST" && /\/(?:issues|work-items)\/$/.test(req.url)) return send(201, { id: "i-new", ...entry.body });
    if (req.method === "POST" && /\/comments\/$/.test(req.url)) return send(201, { id: "c-new" });
    if (req.method === "POST" && /\/links\/$/.test(req.url)) return send(201, { id: "l-new" });
    if (req.method === "PATCH" && /\/links\/[^/]+\/$/.test(req.url)) return send(200, { id: req.url.split("/").at(-2) });
    if (req.method === "POST" && /\/labels\/$/.test(req.url)) return send(201, { id: "lab-new" });
    send(404, { error: "Not found" });
  });
});
await new Promise((r) => api.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${api.address().port}`;
const sleeps = [];
// The request budget is A5's subject (verify-a5-a7); here it is off (0/min) so `sleeps` only records retry
// backoff. A budget of 0 also ignores 429 pauses, so the 429 check passes a real (large) budget.
const newClient = (rateLimitPerMinute = 0) => new plane.PlaneClient({ baseUrl, token: new SecretString("plane_api_SERVICE"), rateLimitPerMinute, sleep: async (ms) => { sleeps.push(ms); } });
const client = newClient();
const writer = new plane.PlaneWritePath({ client, db });
const W = { slug: "qelal", projectId: "p1" };
const reset = () => { fake.requests = []; fake.script = []; fake.opsAtWrite = null; fake.hashesToProbe = null; sleeps.length = 0; };

await check("opHash is field-granular, deterministic, and normalizes key order and scalar-array order only", () => {
  strictEqual(opHash("plane", "i1", "state", "s1"), opHash("plane", "i1", "state", "s1"));
  notStrictEqual(opHash("plane", "i1", "state", "s1"), opHash("plane", "i1", "priority", "s1"));
  notStrictEqual(opHash("plane", "i1", "state", "s1"), opHash("github", "i1", "state", "s1"));
  notStrictEqual(opHash("plane", "i1", "state", "s1"), opHash("plane", "i2", "state", "s1"));
  strictEqual(normalizeValue({ b: 1, a: [3, 1, 2] }), normalizeValue({ a: [1, 2, 3], b: 1 }));
  notStrictEqual(normalizeValue("Done"), normalizeValue("done"));
  notStrictEqual(normalizeValue(" x"), normalizeValue("x"));
  ok(/^[0-9a-f]{64}$/.test(opHash("plane", "i1", "state", "s1")));
});

await check("update_issue records one op per field BEFORE the PATCH and sends exactly those fields with the service key", async () => {
  reset();
  const fields = { state: "s-progress", name: "New title" };
  const hashes = Object.entries(fields).map(([f, v]) => opHash("plane", "i1", f, v));
  fake.hashesToProbe = hashes;
  const r = await writer.apply({ kind: "update_issue", ...W, issueId: "i1", fields });
  strictEqual(r.ok, true);
  strictEqual(fake.opsAtWrite, 2, "ops were not recorded before the write");
  const patch = fake.requests.find((q) => q.method === "PATCH");
  ok(patch && /^\/api\/v1\/workspaces\/qelal\/projects\/p1\/(?:issues|work-items)\/i1\/$/.test(patch.url), `PATCH url ${patch?.url}`);
  deepStrictEqual(patch.body, fields);
  strictEqual(patch.key, "plane_api_SERVICE");
});

await check("a per-user actor token replaces the service key for that write (§9 phase 2)", async () => {
  reset();
  await writer.apply({ kind: "update_issue", ...W, issueId: "i1", fields: { priority: "high" } }, { actorToken: new SecretString("plane_api_USER") });
  strictEqual(fake.requests.find((q) => q.method === "PATCH").key, "plane_api_USER");
});

await check("states are read across cursor pages, and a write into the triage group is rejected before anything is recorded or sent (§7.1)", async () => {
  reset();
  const h = opHash("plane", "i2", "state", "s-triage");
  await rejects(writer.apply({ kind: "update_issue", ...W, issueId: "i2", fields: { state: "s-triage" } }), plane.TriageWriteRejected);
  strictEqual(await opsCount([h]), 0);
  ok(!fake.requests.some((q) => q.method !== "GET"), "a write was sent");
  await rejects(writer.apply({ kind: "create_issue", ...W, fields: { name: "x", state: "s-triage" } }), plane.TriageWriteRejected);
  await rejects(writer.apply({ kind: "update_issue", ...W, issueId: "i2", fields: { state: "s-nonexistent" } }));
});

await check("a failed write forgets exactly the ops it recorded", async () => {
  reset();
  const h = opHash("plane", "i3", "name", "doomed");
  fake.script.push({ status: 403, body: { error: "You do not have permission" } });
  await rejects(writer.apply({ kind: "update_issue", ...W, issueId: "i3", fields: { name: "doomed" } }), (e) => e instanceof plane.PlaneApiError && e.status === 403);
  strictEqual(await opsCount([h]), 0);
});

await check("a duplicate-URL 400 on links is success; any other 400 is an error (§3)", async () => {
  reset();
  fake.script.push({ status: 400, body: { error: "URL already exists for this Issue" } });
  deepStrictEqual(await writer.apply({ kind: "add_link", ...W, issueId: "i1", url: "https://github.com/o/r/pull/1", title: "PR #1" }), { ok: true, duplicate: true });
  fake.script.push({ status: 400, body: { error: "Invalid URL" } });
  await rejects(writer.apply({ kind: "add_link", ...W, issueId: "i1", url: "nope", title: "x" }), plane.PlaneApiError);
  reset();
  const r = await writer.apply({ kind: "update_link", ...W, issueId: "i1", linkId: "l9", url: "https://ci/1", title: "[CI] Build #1" });
  strictEqual(r.ok, true);
  strictEqual(fake.requests.at(-1).method, "PATCH"); ok(/\/(?:issues|work-items)\/i1\/links\/l9\/$/.test(fake.requests.at(-1).url), fake.requests.at(-1).url);
});

await check("a duplicate-label 409 returns the existing label id (§3 free upsert)", async () => {
  reset();
  fake.script.push({ status: 409, body: { error: "Label with the same name already exists in the project", id: "lab-existing" } });
  const r = await writer.apply({ kind: "upsert_label", ...W, name: "plane" });
  strictEqual(r.id, "lab-existing");
  strictEqual(fake.requests.filter((q) => q.method === "POST").length, 1, "list-then-create race");
});

await check("429 is deferred, never slept: PlaneRateLimitError at the Retry-After / X-RateLimit-Reset deadline, the budget pauses; 5xx backs off; other 4xx are not retried (§9, contract 2)", async () => {
  // Fresh clients: a 429 pauses the client's budget until the deadline, which would defer later checks' writes.
  const deferred = async (headers, name) => {
    reset();
    const w = new plane.PlaneWritePath({ client: newClient(6000), db });
    const h = opHash("plane", "i4", "name", name);
    fake.script.push({ status: 429, body: { error: "throttled" }, headers });
    const before = Date.now();
    let err;
    await rejects(w.apply({ kind: "update_issue", ...W, issueId: "i4", fields: { name } }), (e) => { err = e; return true; });
    ok(err instanceof plane.PlaneRateLimitError, `expected PlaneRateLimitError, got ${err?.name}: ${err?.message}`);
    strictEqual(err.status, 429, "still a PlaneApiError with status 429");
    strictEqual(err.requestMade, true);
    strictEqual(sleeps.length, 0, `slept inline: ${sleeps}`);
    strictEqual(fake.requests.filter((q) => q.method === "PATCH").length, 1, "a 429 was retried inline");
    strictEqual(await opsCount([h]), 0, "the failed write's op was not forgotten");
    // The paused budget defers the next request on this key without sending it.
    const sent = fake.requests.length;
    await rejects(w.apply({ kind: "update_issue", ...W, issueId: "i4", fields: { name: name + "-next" } }),
      (e) => e instanceof plane.PlaneRateLimitError && e.requestMade === false && e.retryAt >= err.retryAt - 1);
    strictEqual(fake.requests.length, sent, "a request was sent while the budget was paused");
    strictEqual(sleeps.length, 0);
    return { err, before };
  };
  const a = await deferred({ "retry-after": "3" }, "a");
  ok(a.err.retryAt >= a.before + 3000 && a.err.retryAt <= Date.now() + 4000, `retryAt ${a.err.retryAt - a.before}ms after the request for Retry-After: 3`);
  const reset5 = Math.floor(Date.now() / 1000) + 5;
  const b = await deferred({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset5) }, "b");
  ok(b.err.retryAt >= reset5 * 1000 && b.err.retryAt <= reset5 * 1000 + 1000, `retryAt ${b.err.retryAt} vs X-RateLimit-Reset ${reset5 * 1000}`);
  reset();
  const c5 = new plane.PlaneWritePath({ client: newClient(), db });
  fake.script.push({ status: 502, body: { error: "bad gateway" } }, { status: 503, body: { error: "down" } });
  await c5.apply({ kind: "update_issue", ...W, issueId: "i4", fields: { name: "c" } });
  strictEqual(sleeps.length, 2); ok(sleeps[1] > sleeps[0], `backoff not increasing: ${sleeps}`);
  reset();
  fake.script.push({ status: 404, body: { error: "Not found" } });
  await rejects(c5.apply({ kind: "update_issue", ...W, issueId: "i5", fields: { name: "d" } }));
  strictEqual(sleeps.length, 0); strictEqual(fake.requests.filter((q) => q.method === "PATCH").length, 1);
});

const planeJob = (deliveryId, issueId, field, value, actorId = "u-human") => ({ source: "plane", deliveryId, event: "issue", receivedAt: new Date().toISOString(),
  payload: { event: "issue", action: field ? "update" : "create", workspace_slug: "qelal", data: { id: issueId }, activity: { field, new_value: value, old_value: null, actor: { id: actorId, email: "h@x.y" } } } });

await check("ingress: a repeated delivery is `duplicate`; our own echo is `echo` once; a later identical human edit is `handled` (§5, pitfall 2)", async () => {
  reset();
  const handled = [];
  const deps = { db, serviceUserId: "u-service", opTtlMinutes: 30, onPlaneEvent: async (j) => { handled.push(j.deliveryId); }, onGithubEvent: async () => {} };
  await writer.apply({ kind: "update_issue", ...W, issueId: "i6", fields: { state: "s-progress", name: "T" } });
  strictEqual(await workers.processInbound(planeJob("e1", "i6", "state", "s-progress"), deps), "echo");
  strictEqual(await workers.processInbound(planeJob("e1", "i6", "state", "s-progress"), deps), "duplicate");
  strictEqual(await workers.processInbound(planeJob("e2", "i6", "name", "T"), deps), "echo");
  strictEqual(await workers.processInbound(planeJob("e3", "i6", "state", "s-progress"), deps), "handled");
  strictEqual(await workers.processInbound(planeJob("e4", "i6", "state", "s-backlog"), deps), "handled");
  deepStrictEqual(handled, ["e3", "e4"]);
});

await check("ingress: the service-actor pre-filter drops the event AND consumes its op, so it cannot later swallow a human edit", async () => {
  reset();
  const deps = { db, serviceUserId: "u-service", opTtlMinutes: 30, onPlaneEvent: async () => {}, onGithubEvent: async () => {} };
  await writer.apply({ kind: "update_issue", ...W, issueId: "i7", fields: { priority: "urgent" } });
  strictEqual(await workers.processInbound(planeJob("f1", "i7", "priority", "urgent", "u-service"), deps), "echo");
  strictEqual(await opsCount([opHash("plane", "i7", "priority", "urgent")]), 0);
  strictEqual(await workers.processInbound(planeJob("f2", "i7", "priority", "urgent"), deps), "handled");
});

await check("ingress: creations we made are echoes; creations we did not make are handled", async () => {
  reset();
  const deps = { db, opTtlMinutes: 30, onPlaneEvent: async () => {}, onGithubEvent: async () => {} };
  const r = await writer.apply({ kind: "create_issue", ...W, fields: { name: "from PR", state: "s-progress" } });
  strictEqual(r.id, "i-new");
  strictEqual(await workers.processInbound(planeJob("g1", "i-new", null, null), deps), "echo");
  strictEqual(await workers.processInbound(planeJob("g2", "i-other", null, null), deps), "handled");
});

// ---- GitHub side --------------------------------------------------------------------------------
const ghCalls = [];
const octo = { request: async (route, params) => { ghCalls.push([route, params]); return { data: { id: 99, number: 12 }, status: 200, headers: {} }; } };
const ghWriter = new gh.GithubWritePath({ app: { installationOctokit: async () => octo }, db, sleep: async () => {} });
const R = { installationId: 1, owner: "acme", repo: "web", repoId: 555, number: 12 };

await check("GitHub field vocabulary: edits, state, labels, assignees, comments and opens map to field-granular changes", () => {
  const issue = { number: 12, title: "New", body: "B", state: "closed" };
  const repository = { id: 555 };
  deepStrictEqual(gh.githubFieldChanges("issues", { action: "edited", issue, repository, changes: { title: { from: "Old" } } }), [{ targetId: "555#12", field: "title", value: "New" }]);
  deepStrictEqual(gh.githubFieldChanges("issues", { action: "closed", issue, repository }), [{ targetId: "555#12", field: "state", value: "closed" }]);
  deepStrictEqual(gh.githubFieldChanges("issues", { action: "labeled", issue, repository, label: { name: "plane" } }), [{ targetId: "555#12", field: "label:plane", value: true }]);
  deepStrictEqual(gh.githubFieldChanges("issues", { action: "unassigned", issue, repository, assignee: { login: "octo" } }), [{ targetId: "555#12", field: "assignee:octo", value: false }]);
  deepStrictEqual(gh.githubFieldChanges("issue_comment", { action: "created", issue, repository, comment: { body: "hi" } }), [{ targetId: "555#12", field: "comment", value: "hi" }]);
  deepStrictEqual(gh.githubFieldChanges("push", { ref: "refs/heads/main", repository }), []);
});

await check("GitHub writes record the same hashes their webhooks produce, so our own GitHub echoes are dropped on ingress", async () => {
  const deps = { db, opTtlMinutes: 30, onPlaneEvent: async () => {}, onGithubEvent: async () => {} };
  await ghWriter.apply({ kind: "update_issue", ...R, fields: { title: "Synced title", state: "closed" } });
  ok(ghCalls.some(([route]) => /PATCH \/repos\/\{owner\}\/\{repo\}\/issues\/\{issue_number\}/.test(route)), JSON.stringify(ghCalls.map((c) => c[0])));
  const issue = { number: 12, title: "Synced title", body: "", state: "closed" }, repository = { id: 555 };
  const j = (id, action, extra) => ({ source: "github", deliveryId: id, event: "issues", receivedAt: new Date().toISOString(), payload: { action, issue, repository, sender: { login: "gitsync[bot]", type: "Bot" }, ...extra } });
  strictEqual(await workers.processInbound(j("h1", "edited", { changes: { title: { from: "x" } } }), deps), "echo");
  strictEqual(await workers.processInbound(j("h2", "closed", {}), deps), "echo");
  strictEqual(await workers.processInbound(j("h3", "closed", {}), deps), "handled");
  await ghWriter.apply({ kind: "add_labels", ...R, labels: ["plane"] });
  strictEqual(await workers.processInbound(j("h4", "labeled", { label: { name: "plane" } }), deps), "echo");
});

await check("EventRouter routes by source and event, falls back to `*`, and reports unhandled", async () => {
  const r = new EventRouter(); const seen = [];
  r.on("github", "pull_request", async (j) => { seen.push("pr:" + j.deliveryId); });
  r.on("plane", "*", async (j) => { seen.push("plane:" + j.deliveryId); });
  strictEqual(await r.dispatch({ source: "github", event: "pull_request", deliveryId: "1" }), "routed");
  strictEqual(await r.dispatch({ source: "plane", event: "cycle", deliveryId: "2" }), "routed");
  strictEqual(await r.dispatch({ source: "github", event: "push", deliveryId: "3" }), "unhandled");
  deepStrictEqual(seen, ["pr:1", "plane:2"]);
});

const vk = await startValkey();
await check("workers: an outbound-plane job is written through the write path; an inbound echo never reaches the handler", async () => {
  reset();
  const handled = [];
  const w = workers.startWorkers({ connectionUrl: vk.url, prefix: "gitsync", plane: writer, github: ghWriter,
    inbound: { db, opTtlMinutes: 30, onPlaneEvent: async (j) => { handled.push(j.deliveryId); }, onGithubEvent: async () => {} } });
  const out = new Queue("outbound-plane", { connection: { url: vk.url }, prefix: "gitsync" });
  const inb = new Queue("inbound-plane", { connection: { url: vk.url }, prefix: "gitsync" });
  try {
    await out.add("write", { kind: "update_issue", ...W, issueId: "i8", fields: { name: "via queue" } });
    for (let i = 0; i < 100 && !fake.requests.some((q) => q.method === "PATCH" && q.url.includes("/i8/")); i++) await new Promise((r) => setTimeout(r, 50));
    ok(fake.requests.some((q) => q.method === "PATCH" && q.url.includes("/i8/")), "outbound job never reached Plane");
    await inb.add("delivery", planeJob("q1", "i8", "name", "via queue"), { jobId: "plane-q1" });
    await inb.add("delivery", planeJob("q2", "i8", "name", "a human typed this"), { jobId: "plane-q2" });
    for (let i = 0; i < 100 && handled.length < 1; i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 300));
    deepStrictEqual(handled, ["q2"]);
  } finally { await out.close(); await inb.close(); await w.close(); }
});
await vk.stop();

api.close(); await db.close();
let bad = 0;
for (const [, err] of results) if (err) bad++;
if (bad) process.exit(1);
console.log(`A4 write path verification passed (${results.length} checks)`);
process.exit(0); // lingering client sockets must not keep a passed oracle alive