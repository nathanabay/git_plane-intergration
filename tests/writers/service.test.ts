import test from "node:test";
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPostgres } from "../../scripts/lib/postgres.mjs";
import { startValkey } from "../../scripts/lib/valkey.mjs";
import { createDb } from "../../src/db/client.ts";
import { migrate } from "../../src/db/migrate.ts";
import { createVault } from "../../src/app/context.ts";
import { runService } from "../../src/app/main.ts";
import { startServer } from "../../src/index.ts";
import { createQueues } from "../../src/queue/index.ts";

const until = async (pred: () => Promise<boolean>, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

test("F2/F6: the running service registers mirror and actor intents without waiting, preserving FIFO", async (t) => {
  const cleanup: (() => unknown | Promise<unknown>)[] = [];
  t.after(async () => {
    const errors: unknown[] = [];
    for (const close of cleanup.reverse()) { try { await close(); } catch (err) { errors.push(err); } }
    if (errors.length) throw new AggregateError(errors, "service fixture cleanup failed");
  });
  const pg = await startPostgres(); cleanup.push(() => pg.stop());
  const vk = await startValkey(); cleanup.push(() => vk.stop());
  const db = createDb(pg.url); cleanup.push(() => db.close());
  await migrate(db);
  const states = [
    { id: "done", name: "Done", group: "completed", default: true },
    { id: "released", name: "Released", group: "completed" },
  ];
  let fail = true;
  let refused = 0;
  const githubReads: string[] = [];
  const applied: { state: string; token: string }[] = [];
  const api = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const send = (status: number, data: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
      // Current installation authority (GitHub A14) and fresh mirror reads (A10)
      // are part of the real reducer; exercise them against the loopback fixture.
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (req.method === "GET" && path === "/repos/o/r/installation") {
        githubReads.push(path); return send(200, { id: 1, suspended_at: null });
      }
      if (req.method === "POST" && path === "/app/installations/1/access_tokens")
        return send(201, { token: "FIXTURE-INSTALLATION-TOKEN", expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: { issues: "read" } });
      if (req.method === "GET" && path === "/repos/o/r/issues/3") {
        githubReads.push(path); return send(200, { number: 3, state: "closed", labels: [{ name: "plane" }] });
      }
      if (path.startsWith("/repos/") || path.startsWith("/app/")) return send(404, { message: "unexpected GitHub fixture route" });
      if (req.method === "GET" && /\/states\/(\?|$)/.test(req.url ?? "")) return send(200, { results: states, next_page_results: false });
      if (req.method === "PATCH") {
        const w = JSON.parse(body);
        if (w.state === "done" && fail) { refused++; return send(503, { error: "temporary outage" }); }
        applied.push({ state: w.state, token: String(req.headers["x-api-key"]) });
        return send(200, { id: "i" });
      }
      return send(200, {});
    });
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  cleanup.push(() => new Promise<void>((r, no) => api.close((e) => e ? no(e) : r())));
  const address = api.address(); ok(address && typeof address === "object");
  const dir = mkdtempSync(join(tmpdir(), "gitsync-cb-service-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const keyFile = join(dir, "key.pem");
  writeFileSync(keyFile, generateKeyPairSync("rsa", { modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey);
  const key = Buffer.alloc(32, 7);
  await db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (1, 'ws')");
  const mapping = (await db.query<{ id: string }>(`INSERT INTO repo_mappings
    (workspace_slug, gh_repo_id, gh_repo_full_name, plane_project_id, sync_direction, installation_id)
    VALUES ('ws', 2, 'o/r', 'p', 'bidirectional', 1) RETURNING id`)).rows[0]!.id;
  await db.query("INSERT INTO rule_sets (mapping_id, yaml_source, version) VALUES ($1,$2,1)",
    [mapping, "- when: issue.closed\n  then: [{set_state: Released}]\n"]);
  await db.query(`INSERT INTO sync_links (plane_workspace_slug, plane_project_id, plane_issue_id,
    gh_repo_id, gh_number, gh_kind, tier, created_by) VALUES ('ws','p','i',2,3,'issue','relation','label_sync')`);
  await db.query("INSERT INTO user_map (workspace_slug, plane_user_id, gh_login, gh_id) VALUES ('ws','u-actor','octo',1)");
  await createVault(db, key).store("u-actor", "plane_pat", "ACTOR-PAT");
  let base = "";
  const prefix = "cb-service";
  const service = await runService({ PORT: "0", HOST: "127.0.0.1", DATABASE_URL: pg.url, REDIS_URL: vk.url,
    QUEUE_PREFIX: prefix, PLANE_BASE_URL: `http://127.0.0.1:${address.port}`, PLANE_SERVICE_PAT: "SERVICE-PAT", PLANE_SERVICE_USER_ID: "u-service",
    PLANE_WEBHOOK_SECRET: "plane-secret", GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY_PATH: keyFile,
    GITHUB_API_BASE_URL: `http://127.0.0.1:${address.port}`,
    GITHUB_WEBHOOK_SECRET: "gh-secret", GITSYNC_TOKEN_KEY: key.toString("base64") },
  { startServer: async (opts) => { const server = await startServer(opts); base = `http://127.0.0.1:${server.port}`; return server; } });
  // Stop the service before its databases/server. Hooks execute in registration order.
  try {
    const body = JSON.stringify({ action: "closed", installation: { id: 1 },
      repository: { id: 2, full_name: "o/r", name: "r", owner: { login: "o" } },
      sender: { id: 1, login: "octo", type: "User" }, issue: { number: 3, state: "closed", labels: [{ name: "plane" }] } });
    const response = await fetch(base + "/git-sync/webhooks/github", { method: "POST", body,
      headers: { "content-type": "application/json", "x-github-event": "issues", "x-github-delivery": "closed-1",
        "x-hub-signature-256": "sha256=" + createHmac("sha256", "gh-secret").update(body).digest("hex") },
      signal: AbortSignal.timeout(5000) });
    strictEqual(response.status, 200);
    // Wait for registration while the destination remains unavailable. This also warms the inbound fixture's
    // database path before measuring the unrelated delivery, without allowing a blocking writer to succeed.
    ok(await until(async () => (await db.query("SELECT 1 FROM audit_log WHERE kind = 'inbound_delivery' AND delivery_id = 'closed-1' AND outcome = 'handled'")).rows.length > 0),
      "inbound reduction waited for the unavailable Plane destination");
    strictEqual(applied.length, 0);
    strictEqual((await db.query("SELECT 1 FROM outbound_writes WHERE status = 'pending'")).rows.length, 2);
    ok(githubReads.includes("/repos/o/r/installation"), "reducer did not verify current installation authority");
    ok(githubReads.includes("/repos/o/r/issues/3"), "mirror did not read the current GitHub issue");
    ok(await until(async () => refused > 0), "fixture did not exercise an actual Plane outage");
    const began = performance.now();
    const ping = JSON.stringify({ repository: { id: 999 }, check_run: { id: 7 } });
    strictEqual((await fetch(base + "/git-sync/webhooks/github", { method: "POST", body: ping,
      headers: { "content-type": "application/json", "x-github-event": "check_run", "x-github-delivery": "unrelated-1",
        "x-hub-signature-256": "sha256=" + createHmac("sha256", "gh-secret").update(ping).digest("hex") },
      signal: AbortSignal.timeout(5000) })).status, 200);
    ok(await until(async () => (await db.query("SELECT 1 FROM audit_log WHERE kind = 'inbound_delivery' AND delivery_id = 'unrelated-1' AND outcome = 'handled'")).rows.length > 0, 1000),
      "Plane outage stalled the unrelated GitHub delivery");
    ok(performance.now() - began < 1000, "unrelated delivery exceeded one second");
    fail = false;
    ok(await until(async () => (await db.query("SELECT 1 FROM audit_log WHERE kind = 'rule_match' AND outcome = 'applied'")).rows.length > 0),
      `actor rule never completed; successful writes: ${JSON.stringify(applied)}`);
    ok(await until(async () => applied.length === 2), "outbound FIFO never completed");
    deepStrictEqual(applied, [{ state: "done", token: "SERVICE-PAT" }, { state: "released", token: "ACTOR-PAT" }]);
    // The fake Plane records a write before it answers, so the worker marks the intent applied a moment later.
    ok(await until(async () => (await db.query("SELECT 1 FROM outbound_writes WHERE status <> 'applied'")).rows.length === 0),
      "outbound intents never reached applied");
    const intents = (await db.query<{ id: string; status: string; actor_user_id: string | null }>(
      "SELECT id, status, actor_user_id FROM outbound_writes ORDER BY sequence")).rows;
    deepStrictEqual(intents.map((r) => [r.status, r.actor_user_id]), [["applied", null], ["applied", "u-actor"]]);
    const queues = createQueues({ connectionUrl: vk.url, prefix });
    try {
      for (const intent of intents) {
        const job = await queues.outboundPlane.getJob(intent.id); ok(job);
        ok(!JSON.stringify(job.data).includes("ACTOR-PAT"));
        ok(await until(async () => await job.getState() === "completed", 5000), "worker did not acknowledge completion");
      }
    } finally { await queues.close(); }
  } finally { fail = false; await service.close(); }
});
