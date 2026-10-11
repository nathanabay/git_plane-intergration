import test from "node:test";
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { SecretString } from "../../src/auth/identity.ts";
import { loadConfig } from "../../src/config/env.ts";
import type { Db } from "../../src/db/migrate.ts";
import { opHash } from "../../src/sync/ophash.ts";
import { PlaneApiError, PlaneClient, PlaneWritePath } from "../../src/sync/plane.ts";
import type { PlaneWrite } from "../../src/sync/plane.ts";

type Call = { method: string; url: URL; body: any; key: string | null };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const target = { slug: "ws", projectId: "p" };
const issue: PlaneWrite = { kind: "create_issue", ...target, fields: { name: "Mirror me" } };
const comment: PlaneWrite = { kind: "add_comment", ...target, issueId: "i", commentHtml: "<p>Once</p>" };

function fixture(reply: (call: Call) => Response | Promise<Response>, query?: (sql: string, params: unknown[]) => void) {
  const calls: Call[] = [], sleeps: number[] = [];
  const client = new PlaneClient({ baseUrl: "http://plane.test", token: new SecretString("SERVICE-SECRET"),
    fetch: async (input, init) => {
      const call: Call = { method: (init?.method ?? "GET").toUpperCase(), url: new URL(String(input)),
        body: init?.body ? JSON.parse(String(init.body)) : undefined, key: new Headers(init?.headers).get("X-API-Key") };
      calls.push(call); return reply(call);
    }, maxRetries: 3, sleep: async (ms) => { sleeps.push(ms); } });
  // Inject only the ledger I/O boundary: these tests exercise the actual HTTP client and writer.
  const db: Db = { async query<R>(sql: string, params: unknown[] = []) { query?.(sql, params); return { rows: [] as R[] }; }, async exec() {} };
  return { client, writer: new PlaneWritePath({ client, db }), calls, sleeps };
}

for (const method of ["POST", "post"]) for (const fault of ["network", 500, 502, 504] as const) {
  test(`F9 ${method} does not retry an ambiguous ${fault} response`, async () => {
    const h = fixture(() => { if (fault === "network") throw new Error("connection dropped"); return json({ error: "proxy failed" }, fault); });
    await rejects(h.client.request(method, "/issues/", {}));
    strictEqual(h.calls.length, 1); deepStrictEqual(h.sleeps, []);
  });
}

test("F9 idempotent reads/updates still retry, and a rejected POST 429 honors Retry-After", async () => {
  for (const method of ["GET", "PATCH", "POST"]) {
    let attempt = 0;
    const h = fixture(() => ++attempt === 1
      ? method === "POST" ? new Response("{}", { status: 429, headers: { "retry-after": "2" } }) : json({}, 503)
      : json({ id: "ok" }));
    deepStrictEqual(await h.client.request(method, "/issues/", {}), { id: "ok" });
    strictEqual(h.calls.length, 2); deepStrictEqual(h.sleeps, [method === "POST" ? 2000 : 1000]);
  }
  let attempt = 0;
  const h = fixture(() => { if (++attempt === 1) throw new Error("temporary read outage"); return json({ id: "ok" }); });
  await h.client.request("GET", "/issues/"); strictEqual(h.calls.length, 2);
});

test("F9 Plane rejection preserves public rate-limit headers for the F10 actor fallback", async () => {
  const cases: Record<string, string>[] = [{}, { "Retry-After": "2" }, { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "123" }];
  for (const headers of cases) {
    const h = fixture(() => new Response("{}", { status: 403, headers: { ...headers, "set-cookie": "SENSITIVE" } }));
    await rejects(h.client.request("POST", "/issues/", {}), (e) => {
      if (!(e instanceof PlaneApiError)) return false;
      strictEqual(e.status, 403); strictEqual(e.response.status, 403);
      deepStrictEqual(e.response.headers, Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])));
      ok(!JSON.stringify(e).includes("SENSITIVE")); return true;
    });
  }
});

for (const write of [issue, comment]) for (const fault of ["network", "gateway", "missing-id"] as const) {
  test(`F9 ${write.kind} recovers a committed ${fault} response by durable intent without another POST`, async () => {
    const stored: any[] = [];
    const h = fixture((call) => {
      if (call.method === "GET") {
        if (write.kind === "add_comment") return json(stored);
        strictEqual(call.url.searchParams.get("external_id"), "intent-42");
        strictEqual(call.url.searchParams.get("external_source"), "gitsync");
        return stored.length ? json(stored[0]) : json({ error: "not found" }, 404);
      }
      const created = { ...call.body, id: `made-${stored.length + 1}` };
      stored.push(created);
      if (stored.length === 1) {
        if (fault === "network") throw new Error("connection dropped after commit");
        if (fault === "gateway") return json({}, 502);
        return json({}, 201);
      }
      return json(created, 201);
    });
    const opts = { intentId: "intent-42", actorToken: new SecretString("ACTOR-SECRET") };
    await rejects(h.writer.apply(write, opts));
    deepStrictEqual(await h.writer.apply(write, opts), { ok: true, id: "made-1" });
    strictEqual(stored.length, 1);
    strictEqual(h.calls.filter((c) => c.method === "POST").length, 1);
    strictEqual(stored[0].external_id, "intent-42"); strictEqual(stored[0].external_source, "gitsync");
    strictEqual(h.calls.find((c) => c.method === "POST")!.key, "ACTOR-SECRET");
    ok(h.calls.every((c) => c.key === "ACTOR-SECRET"));
  });
}

test("F9 comment recovery follows pagination and matches source plus intent, not comment content", async () => {
  const h = fixture((call) => {
    strictEqual(call.method, "GET");
    return call.url.searchParams.has("cursor") ? json({ results: [
      { id: "correct", external_source: "gitsync", external_id: "intent-42" },
    ], next_page_results: false }) : json({ results: [
      { id: "foreign", external_source: "foreign", external_id: "intent-42" },
      { id: "another", external_source: "gitsync", external_id: "another-intent" },
    ], next_page_results: true, next_cursor: "page 2" });
  });
  deepStrictEqual(await h.writer.apply(comment, { intentId: "intent-42" }), { ok: true, id: "correct" });
  strictEqual(h.calls.length, 2); strictEqual(h.calls[1]!.url.searchParams.get("cursor"), "page 2");
});

test("F9 distinct intents create distinct issues even when their fields are identical", async () => {
  const stored = new Map<string, any>();
  const h = fixture((call) => {
    if (call.method === "GET") {
      const found = stored.get(call.url.searchParams.get("external_id")!);
      return found ? json(found) : json({}, 404);
    }
    const created = { ...call.body, id: `made-${stored.size + 1}` };
    stored.set(call.body.external_id, created); return json(created, 201);
  });
  const spoofed: PlaneWrite = { ...issue, fields: { name: "Mirror me", external_id: "payload-spoof", external_source: "foreign" } };
  deepStrictEqual(await h.writer.apply(spoofed, { intentId: "intent ?&/1" }), { ok: true, id: "made-1" });
  deepStrictEqual(await h.writer.apply(spoofed, { intentId: "intent-2" }), { ok: true, id: "made-2" });
  strictEqual(stored.size, 2); strictEqual(stored.get("intent ?&/1").external_source, "gitsync");
});

test("F9 unrelated 409s and invalid intent ids are rejected rather than reported as created", async () => {
  const h = fixture((call) => call.method === "GET" ? json({}, 404) : json({ id: "wrong", error: "Other conflict" }, 409));
  await rejects(h.writer.apply(issue, { intentId: "intent-42" }), (e) => e instanceof PlaneApiError && e.status === 409);
  for (const intentId of ["", " ", "x".repeat(256)]) {
    const before = h.calls.length;
    await rejects(h.writer.apply(issue, { intentId })); strictEqual(h.calls.length, before);
  }
});

for (const write of [issue, comment]) {
  test(`F9 ${write.kind} handles Plane's external-intent conflict if the lookup replica lags`, async () => {
    const h = fixture((call) => call.method === "GET" ? write.kind === "create_issue" ? json({}, 404) : json([])
      : json({ id: "already-created", error: write.kind === "create_issue"
        ? "Issue with the same external id and external source already exists"
        : "Work item comment with the same external id and external source already exists" }, 409));
    deepStrictEqual(await h.writer.apply(write, { intentId: "intent-42" }), { ok: true, id: "already-created" });
    strictEqual(h.calls.filter((c) => c.method === "POST").length, 1);
  });
  for (const stage of ["record", "cleanup", "both"]) {
    test(`F9 ${write.kind} preserves a successful response after ${stage} bookkeeping fails`, async (t) => {
      const logs: string[] = [];
      t.mock.method(console, "error", (message: unknown) => { logs.push(String(message)); });
      const h = fixture(() => json({ id: "made" }, 201), (sql, params) => {
        if ((stage === "record" || stage === "both") && params[0] === opHash("plane", "made", "created", null)) throw new Error("SENSITIVE bookkeeping error");
        if ((stage === "cleanup" || stage === "both") && sql.includes("DELETE FROM applied_ops")) throw new Error("SENSITIVE cleanup error");
      });
      deepStrictEqual(await h.writer.apply(write), { ok: true, id: "made" });
      strictEqual(h.calls.length, 1); ok(logs.length > 0); ok(logs.every((l) => !l.includes("SENSITIVE")));
    });
  }
}

test("F9 cleanup failure cannot replace the original POST authentication failure", async (t) => {
  t.mock.method(console, "error", () => {});
  const h = fixture(() => json({ error: "actor rejected" }, 401), (sql) => {
    if (sql.includes("DELETE FROM applied_ops")) throw new Error("cleanup unavailable");
  });
  await rejects(h.writer.apply(comment), (e) => e instanceof PlaneApiError && e.status === 401);
});

test("F9 issue intent lookup errors or mismatched identities fail closed before POST", async () => {
  for (const reply of [() => json({}, 403), () => json({ id: "foreign", external_id: "intent-42", external_source: "another-integration" })]) {
    const h = fixture(reply);
    await rejects(h.writer.apply(issue, { intentId: "intent-42" }));
    ok(h.calls.every((c) => c.method === "GET"));
  }
});

const configEnv = { DATABASE_URL: "postgres://x", REDIS_URL: "redis://x", PLANE_BASE_URL: "http://plane.test",
  PLANE_SERVICE_PAT: "SERVICE-SECRET", PLANE_WEBHOOK_SECRET: "w", GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY_PATH: "/k",
  GITHUB_WEBHOOK_SECRET: "g", GITSYNC_TOKEN_KEY: "k" };

test("F17 startup rejects a missing, empty or whitespace service identity", () => {
  for (const value of [undefined, "", "   "]) {
    const env = { ...configEnv, ...(value === undefined ? {} : { PLANE_SERVICE_USER_ID: value }) };
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", 'import {loadConfig} from "./src/config/env.ts"; loadConfig(process.env);'],
      { cwd: resolve(import.meta.dirname, "../.."), env: { ...env, NODE_OPTIONS: "--max-old-space-size=1024" }, encoding: "utf8", timeout: 5000 });
    strictEqual(run.status, 1); ok(run.stderr.includes("PLANE_SERVICE_USER_ID")); ok(!run.stderr.includes("SERVICE-SECRET"));
  }
});

test("F17 an explicit service identity is loaded and normalized with the existing rate default", () => {
  const config = loadConfig({ ...configEnv, PLANE_SERVICE_USER_ID: " service-user " });
  strictEqual(config.PLANE_SERVICE_USER_ID, "service-user"); strictEqual(config.PLANE_API_RATE_PER_MINUTE, 60);
});
