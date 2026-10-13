import test from "node:test";
import { strictEqual, deepStrictEqual, ok, rejects } from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../../src/db/migrate.ts";
import { SecretString } from "../../src/auth/identity.ts";
import { PlaneApiError, PlaneClient, PlaneRateLimitError, PlaneWritePath, TokenBucket, TriageWriteRejected, pendingCommentHash, pendingCreateHash } from "../../src/sync/plane.ts";
import { createPending } from "../../src/db/ledgers.ts";
import { opHash } from "../../src/sync/ophash.ts";

type Call = { method: string; url: string; key: string | null; body: any };
type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

function harness(script: Reply[] = [], states = [{ id: "s1", name: "Todo", group: "unstarted" }, { id: "st", name: "Triage", group: "triage" }]) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const queue = [...script];
  const f = (async (url: string, init: any) => {
    const u = new URL(url);
    calls.push({ method: init.method, url: u.pathname + u.search, key: init.headers["X-API-Key"], body: init.body ? JSON.parse(init.body) : null });
    const next = queue.shift();
    if (next) return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status, headers: next.headers });
    if (init.method === "GET" && u.pathname.endsWith("/states/")) return new Response(JSON.stringify(states), { status: 200 });
    if (init.method === "POST" && u.pathname.endsWith("/work-items/")) return new Response(JSON.stringify({ id: "new1" }), { status: 201 });
    if (init.method === "POST" && u.pathname.endsWith("/comments/")) return new Response(JSON.stringify({ id: "c1" }), { status: 201 });
    return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
  }) as unknown as typeof fetch;
  const client = new PlaneClient({ baseUrl: "http://plane.test/", token: new SecretString("svc"), fetch: f, sleep: async (ms) => { sleeps.push(ms); }, maxRetries: 3 });
  return { client, calls, sleeps };
}
async function setup(script: Reply[] = []) {
  const db = new PGlite(); await db.waitReady; await migrate(db);
  const h = harness(script);
  return { ...h, db, writer: new PlaneWritePath({ client: h.client, db }) };
}
const count = async (db: PGlite, hs: string[]) => (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM applied_ops WHERE op_hash = ANY($1)", [hs])).rows[0]!.n;
const W = { slug: "ws", projectId: "p" };

test("client: prefixes /api/v1, sends X-API-Key, and accepts an already-prefixed path", async () => {
  const { client, calls } = harness();
  await client.request("GET", "/workspaces/ws/x/");
  await client.request("GET", "/api/v1/workspaces/ws/y/");
  deepStrictEqual(calls.map((c) => c.url), ["/api/v1/workspaces/ws/x/", "/api/v1/workspaces/ws/y/"]);
  strictEqual(calls[0]!.key, "svc");
});
test("client: an error envelope becomes PlaneApiError with status and body", async () => {
  const { client } = harness([{ status: 403, body: { error: "nope" } }]);
  await rejects(client.request("GET", "/x/"), (e: any) => e instanceof PlaneApiError && e.status === 403 && (e.body as { error: string }).error === "nope" && e.message.includes("nope"));
});
test("client: 5xx retries up to maxRetries then throws", async () => {
  const { client, calls, sleeps } = harness(Array.from({ length: 10 }, () => ({ status: 500, body: { error: "x" } })));
  await rejects(client.request("GET", "/x/"), PlaneApiError);
  strictEqual(calls.length, 4);
  deepStrictEqual(sleeps, [1000, 2000, 4000]);
});
test("client: 4xx other than 429 is not retried", async () => {
  const { client, calls } = harness([{ status: 400, body: { error: "bad" } }]);
  await rejects(client.request("POST", "/x/", {}));
  strictEqual(calls.length, 1);
});
test("client: 429 throws PlaneRateLimitError at the Retry-After deadline without sleeping", async () => {
  const { client, sleeps, calls } = harness([{ status: 429, body: {}, headers: { "retry-after": "2" } }]);
  await rejects(client.request("GET", "/x/"), (e: any) => e instanceof PlaneRateLimitError && e.retryAt >= Date.now() + 1000);
  deepStrictEqual(sleeps, []); strictEqual(calls.length, 1);
});
test("client: list follows cursors, and a bare array is one page", async () => {
  const { client, calls } = harness([
    { status: 200, body: { results: [1, 2], next_cursor: "c2", next_page_results: true } },
    { status: 200, body: { results: [3], next_cursor: null, next_page_results: false } },
  ]);
  deepStrictEqual(await client.listAll("/things/"), [1, 2, 3]);
  ok(calls[1]!.url.includes("cursor=c2"));
  const bare = harness([{ status: 200, body: [9] }]);
  deepStrictEqual(await bare.client.listAll("/things/"), [9]);
});
test("client: an error never contains the token", async () => {
  const { client } = harness([{ status: 401, body: { error: "bad key" } }]);
  await rejects(client.request("GET", "/x/"), (e: any) => !String(e.message).includes("svc") && !JSON.stringify(e.body).includes("svc"));
});
test("client: issue lookups use the documented paths", async () => {
  const { client, calls } = harness();
  await client.getIssueByIdentifier("ws", "PROJ-12");
  await client.getIssue("ws", "p", "i1");
  deepStrictEqual(calls.map((c) => c.url), ["/api/v1/workspaces/ws/work-items/PROJ-12/", "/api/v1/workspaces/ws/projects/p/work-items/i1/"]);
});

test("write: update_issue records per-field ops and sends the exact body", async () => {
  const { writer, db, calls } = await setup();
  await writer.apply({ kind: "update_issue", ...W, issueId: "i", fields: { name: "n", priority: "high" } });
  strictEqual(await count(db, [opHash("plane", "i", "name", "n"), opHash("plane", "i", "priority", "high")]), 2);
  deepStrictEqual(calls.at(-1)!.body, { name: "n", priority: "high" });
});
test("write: a failed update forgets only its own ops", async () => {
  const { writer, db } = await setup([{ status: 500, body: { error: "x" } }, { status: 500, body: { error: "x" } }, { status: 500, body: { error: "x" } }, { status: 500, body: { error: "x" } }]);
  const h = opHash("plane", "i", "name", "n");
  await db.query("INSERT INTO applied_ops (op_hash, direction) VALUES ($1, 'to_plane')", [h]); // an earlier, still-live write
  await rejects(writer.apply({ kind: "update_issue", ...W, issueId: "i", fields: { name: "n" } }));
  strictEqual(await count(db, [h]), 1);
});
test("write: empty field set sends nothing", async () => {
  const { writer, calls } = await setup();
  await writer.apply({ kind: "update_issue", ...W, issueId: "i", fields: {} });
  strictEqual(calls.length, 0);
});
test("write: triage state is rejected for update and create with no record and no write", async () => {
  const { writer, db, calls } = await setup();
  await rejects(writer.apply({ kind: "update_issue", ...W, issueId: "i", fields: { state: "st" } }), TriageWriteRejected);
  await rejects(writer.apply({ kind: "create_issue", ...W, fields: { name: "x", state: "st" } }), TriageWriteRejected);
  strictEqual(await count(db, [opHash("plane", "i", "state", "st")]), 0);
  ok(calls.every((c) => c.method === "GET"));
});
test("write: an unknown state id is a loud error", async () => {
  const { writer } = await setup();
  await rejects(writer.apply({ kind: "update_issue", ...W, issueId: "i", fields: { state: "zzz" } }), /unknown Plane state/);
});
test("write: states are cached per project", async () => {
  const { writer, calls } = await setup();
  await writer.apply({ kind: "update_issue", ...W, issueId: "i", fields: { state: "s1" } });
  await writer.apply({ kind: "update_issue", ...W, issueId: "j", fields: { state: "s1" } });
  strictEqual(calls.filter((c) => c.url.includes("/states/")).length, 1);
});
test("write: create_issue and add_comment record a `created` op for the new id", async () => {
  const { writer, db } = await setup();
  const a = await writer.apply({ kind: "create_issue", ...W, fields: { name: "x" } });
  const b = await writer.apply({ kind: "add_comment", ...W, issueId: "i", commentHtml: "<p>hi</p>" });
  strictEqual(a.id, "new1"); strictEqual(b.id, "c1");
  strictEqual(await count(db, [opHash("plane", "new1", "created", null), opHash("plane", "c1", "created", null)]), 2);
});
test("write: a per-user actor token is used instead of the service key", async () => {
  const { writer, calls } = await setup();
  await writer.apply({ kind: "update_issue", ...W, issueId: "i", fields: { name: "a" } }, { actorToken: new SecretString("user") });
  strictEqual(calls.at(-1)!.key, "user");
});
test("write: duplicate link 400 is success, other 400 throws, update_link PATCHes in place", async () => {
  const { writer, calls } = await setup([{ status: 400, body: { error: "URL already exists for this Issue" } }, { status: 400, body: { error: "Invalid URL" } }]);
  deepStrictEqual(await writer.apply({ kind: "add_link", ...W, issueId: "i", url: "u", title: "t" }), { ok: true, duplicate: true });
  await rejects(writer.apply({ kind: "add_link", ...W, issueId: "i", url: "u", title: "t" }), PlaneApiError);
  await writer.apply({ kind: "update_link", ...W, issueId: "i", linkId: "l", url: "u", title: "t" });
  strictEqual(calls.at(-1)!.method, "PATCH");
});
test("write: label 409 returns the existing id; a 409 without an id throws", async () => {
  const { writer } = await setup([{ status: 409, body: { error: "dup", id: "L1" } }, { status: 409, body: { error: "dup" } }]);
  strictEqual((await writer.apply({ kind: "upsert_label", ...W, name: "x" })).id, "L1");
  await rejects(writer.apply({ kind: "upsert_label", ...W, name: "x" }), PlaneApiError);
});

test("write: create_issue and add_comment mark create pending during in-flight request and bind id afterwards (F13)", async () => {
  let pendingDuringIssueCreate = false;
  let pendingDuringComment = false;
  const db = new PGlite(); await db.waitReady; await migrate(db);
  const f = (async (url: string, init: any) => {
    const u = new URL(url);
    if (init.method === "GET" && u.pathname.endsWith("/states/")) return new Response(JSON.stringify([{ id: "s1", name: "Todo", group: "unstarted" }]), { status: 200 });
    if (init.method === "POST" && u.pathname.endsWith("/work-items/")) {
      pendingDuringIssueCreate = await createPending(db, pendingCreateHash(W.projectId));
      return new Response(JSON.stringify({ id: "iss-123" }), { status: 201 });
    }
    if (init.method === "POST" && u.pathname.endsWith("/comments/")) {
      pendingDuringComment = await createPending(db, pendingCommentHash("iss-123"));
      return new Response(JSON.stringify({ id: "com-456" }), { status: 201 });
    }
    return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
  }) as unknown as typeof fetch;
  const client = new PlaneClient({ baseUrl: "http://plane.test/", token: new SecretString("svc"), fetch: f });
  const writer = new PlaneWritePath({ client, db });

  const iss = await writer.apply({ kind: "create_issue", ...W, fields: { name: "test-f13" } });
  strictEqual(iss.id, "iss-123");
  strictEqual(pendingDuringIssueCreate, true, "marker must be present while create_issue is in-flight");
  strictEqual(await createPending(db, pendingCreateHash(W.projectId)), false, "marker must be cleared after create_issue");
  strictEqual(await count(db, [opHash("plane", "iss-123", "created", null)]), 1, "created op must be bound to new id");

  const com = await writer.apply({ kind: "add_comment", ...W, issueId: "iss-123", commentHtml: "<p>hello</p>" });
  strictEqual(com.id, "com-456");
  strictEqual(pendingDuringComment, true, "marker must be present while add_comment is in-flight");
  strictEqual(await createPending(db, pendingCommentHash("iss-123")), false, "marker must be cleared after add_comment");
  strictEqual(await count(db, [opHash("plane", "com-456", "created", null)]), 1, "created op must be bound to new comment id");
  await db.close();
});

test("client: token bucket rate budget paces burst of requests under budget (F11)", async () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); };
  const client = new PlaneClient({
    baseUrl: "http://plane.test/",
    token: new SecretString("svc"),
    fetch: (async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 })) as typeof fetch,
    sleep,
    rateLimitPerMinute: 60,
    burstCapacity: 2,
  });

  strictEqual(client.rateLimitPerMinute, 60);
  strictEqual(client.rateBudget.capacity, 2);

  // Launch a burst of 5 requests concurrently
  await Promise.all([
    client.request("GET", "/a/"),
    client.request("GET", "/b/"),
    client.request("GET", "/c/"),
    client.request("GET", "/d/"),
    client.request("GET", "/e/"),
  ]);

  // First 2 requests consume the burst capacity immediately (0ms delay)
  // Subsequent 3 requests wait for tokens to adhere to 60/min
  strictEqual(sleeps.length, 3);
  for (const s of sleeps) {
    ok(s > 0 && s <= 1000, `delay should be at most 1000ms (got ${s})`);
  }
  const totalWait = sleeps.reduce((a, b) => a + b, 0);
  ok(totalWait >= 2900 && totalWait <= 3000, `total wait should pace burst under budget (got ${totalWait}ms)`);
});

test("writer: token bucket rate budget paces burst of writes under budget (F11)", async () => {
  const db = { query: async () => ({ rows: [] }) } as any;
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); };
  const f = (async (url: string, init: any) => {
    const u = new URL(url);
    if (init.method === "GET" && u.pathname.endsWith("/states/")) {
      return new Response(JSON.stringify([{ id: "s1", name: "Todo", group: "unstarted" }]), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
  }) as unknown as typeof fetch;

  const client = new PlaneClient({
    baseUrl: "http://plane.test/",
    token: new SecretString("svc"),
    fetch: f,
    sleep,
    rateLimitPerMinute: 60,
    burstCapacity: 2,
  });
  const writer = new PlaneWritePath({ client, db });

  // Burst of 5 writes launched concurrently (5 issue PATCHes = 5 requests total)
  await Promise.all([1, 2, 3, 4, 5].map((i) =>
    writer.apply({
      kind: "update_issue",
      ...W,
      issueId: `iss-${i}`,
      fields: { name: `Name ${i}` },
    })
  ));

  // Burst capacity of 2 allows 2 immediately; remaining 3 wait for tokens.
  strictEqual(sleeps.length, 3);
  for (const s of sleeps) {
    ok(s > 0 && s <= 1000, `delay should be at most 1000ms (got ${s})`);
  }
  const totalWait = sleeps.reduce((a, b) => a + b, 0);
  ok(totalWait >= 2900 && totalWait <= 3000, `total wait should pace burst under budget (got ${totalWait}ms)`);
});


