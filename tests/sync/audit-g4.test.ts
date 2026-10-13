import test from "node:test";
import { strictEqual, deepStrictEqual, ok } from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../../src/db/migrate.ts";
import { SecretString } from "../../src/auth/identity.ts";
import { createWebhookRoutes } from "../../src/api/handler.ts";
import { listSpooled, recordDelivery, spoolInbound, upsertSyncLink } from "../../src/db/ledgers.ts";
import type { InboundJob } from "../../src/queue/index.ts";
import { processQueueJob } from "../../src/queue/workers.ts";
import type { DeferredJob } from "../../src/queue/workers.ts";
import { classifyGithubError } from "../../src/github/errors.ts";
import {
  DEFAULT_PLANE_BURST, PLANE_ITEMS_SEGMENT, PLANE_RATE_MARGIN_MS, PLANE_RATE_WINDOW_MS, PlaneApiError, PlaneClient, PlaneRateLimitError, PlaneWritePath, TokenBucket, UnknownPlaneState, planeItemsPath,
} from "../../src/sync/plane.ts";
import type { PlaneActivity } from "../../src/sync/plane.ts";
import { checkPlaneWebhookHealth, reconcileOnce, replaySpooledDeliveries, verdictFromActivities } from "../../src/sync/reconcile.ts";
import type { ReconcilePlane } from "../../src/sync/reconcile.ts";

const freshDb = async () => { const db = new PGlite(); await db.waitReady; await migrate(db); return db; };

// ---- A1: Plane ingress ---------------------------------------------------------------------------------

function planeDelivery(secret: string, id = "d-1") {
  const body = JSON.stringify({ event: "issue", action: "updated", data: { id: "i1" } });
  const req = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
  (req as any).headers = {
    "x-plane-delivery": id, "x-plane-event": "issue",
    "x-plane-signature": createHmac("sha256", secret).update(body).digest("hex"),
  };
  const out: { status?: number; body?: any } = {};
  const res = {
    writeHead(status: number) { out.status = status; return this; },
    end(chunk?: string) { out.body = chunk ? JSON.parse(chunk) : undefined; },
  } as unknown as ServerResponse;
  return { req, res, out };
}
const planeRoute = (deps: Parameters<typeof createWebhookRoutes>[0]) => createWebhookRoutes(deps).find((r) => r.path.endsWith("/plane"))!.handler;

test("A1: a Plane delivery that cannot be queued is spooled and answered 2xx, not 503", async () => {
  const spooled: InboundJob[] = [];
  const handler = planeRoute({ planeSecret: "s", githubSecret: "g", enqueue: async () => { throw new Error("redis down"); }, spool: async (j) => { spooled.push(j); } });
  const d = planeDelivery("s");
  await handler(d.req, d.res, {});
  strictEqual(d.out.status, 202);
  deepStrictEqual(d.out.body, { queued: false, spooled: true });
  strictEqual(spooled.length, 1); strictEqual(spooled[0]!.deliveryId, "d-1"); strictEqual(spooled[0]!.source, "plane");
});

test("A1: only when neither the queue nor the spool takes it does the route answer 503", async () => {
  const handler = planeRoute({ planeSecret: "s", githubSecret: "g", enqueue: async () => { throw new Error("down"); }, spool: async () => { throw new Error("db down"); } });
  const d = planeDelivery("s");
  await handler(d.req, d.res, {});
  strictEqual(d.out.status, 503);
});

test("A1: during a secret rotation a delivery signed with either secret is accepted, any other is refused", async () => {
  const queued: string[] = [];
  const handler = planeRoute({ planeSecret: ["new", "old"], githubSecret: "g", enqueue: async (j) => { queued.push(j.deliveryId); } });
  for (const [secret, id] of [["old", "a"], ["new", "b"]] as const) {
    const d = planeDelivery(secret, id); await handler(d.req, d.res, {}); strictEqual(d.out.status, 200);
  }
  const bad = planeDelivery("other", "c"); await handler(bad.req, bad.res, {}); strictEqual(bad.out.status, 401);
  deepStrictEqual(queued, ["a", "b"]);
});

test("A1: the spool is replayed in order; a failing queue keeps the rest for the next run", async () => {
  const db = await freshDb();
  for (const id of ["d1", "d2", "d3"]) await spoolInbound(db, { source: "plane", deliveryId: id, event: "issue", receivedAt: new Date().toISOString(), payload: { id } });
  await spoolInbound(db, { source: "plane", deliveryId: "d1", event: "issue", receivedAt: new Date().toISOString(), payload: {} }); // repeat: no-op
  const seen: string[] = [];
  let fail = "d2";
  const enqueue = async (j: InboundJob) => { if (j.deliveryId === fail) throw new Error("still down"); seen.push(j.deliveryId); };
  deepStrictEqual(await replaySpooledDeliveries({ db, enqueue }), { replayed: 1, failed: 1 });
  deepStrictEqual((await listSpooled(db, 10)).map((r) => [r.delivery_id, r.attempts]), [["d2", 1], ["d3", 0]]);
  fail = "";
  deepStrictEqual(await replaySpooledDeliveries({ db, enqueue }), { replayed: 2, failed: 0 });
  deepStrictEqual(seen, ["d1", "d2", "d3"]);
  strictEqual((await listSpooled(db, 10)).length, 0);
});

test("A1: Plane changes with no delivery after them raise one alert, and a delivery clears it", async () => {
  const db = await freshDb();
  await db.query(`INSERT INTO repo_mappings (workspace_slug, gh_repo_id, gh_repo_full_name, plane_project_id, sync_direction) VALUES ('ws', 1, 'a/b', 'p', 'bidirectional')`);
  const now = Date.now();
  const changedAt = new Date(now - 60 * 60_000).toISOString();
  const plane = { latestIssueUpdate: async () => changedAt };
  const first = await checkPlaneWebhookHealth({ db, plane, now });
  strictEqual(first.silent, true);
  strictEqual((await checkPlaneWebhookHealth({ db, plane, now })).silent, true);
  const alerts = async (kind: string) => (await db.query(`SELECT 1 FROM audit_log WHERE kind = $1`, [kind])).rows.length;
  strictEqual(await alerts("plane_webhook_silent"), 1, "alerted once, not on every sweep");
  await recordDelivery(db, "plane", "after-reenable");
  strictEqual((await checkPlaneWebhookHealth({ db, plane, now })).silent, false);
  strictEqual(await alerts("plane_webhook_recovered"), 1);
});

test("A1: a change still inside the grace period, or one followed by a delivery, is not an alert", async () => {
  const db = await freshDb();
  await db.query(`INSERT INTO repo_mappings (workspace_slug, gh_repo_id, gh_repo_full_name, plane_project_id, sync_direction) VALUES ('ws', 1, 'a/b', 'p', 'bidirectional')`);
  const now = Date.now();
  strictEqual((await checkPlaneWebhookHealth({ db, plane: { latestIssueUpdate: async () => new Date(now - 60_000).toISOString() }, now })).silent, false);
  await recordDelivery(db, "plane", "x");
  strictEqual((await checkPlaneWebhookHealth({ db, plane: { latestIssueUpdate: async () => new Date(now - 45 * 60_000).toISOString() }, now: now + 0 })).silent, false);
});

// ---- A2 / A6: reconcile -------------------------------------------------------------------------------

type Fake = { visible?: string[]; archivedProject?: boolean; projectGone?: boolean; activities?: Record<string, PlaneActivity[]>; listPages?: number };
function fakePlane(f: Fake) {
  const calls: string[] = [];
  const plane: ReconcilePlane = {
    getIssue: (async (_s: string, _p: string, id: string) => {
      calls.push(`get:${id}`);
      if ((f.visible ?? []).includes(id)) return { id };
      throw new PlaneApiError(404, {}, "nf");
    }) as any,
    getProject: (async () => {
      calls.push("project");
      if (f.projectGone) throw new PlaneApiError(404, {}, "nf");
      return { id: "p", archived_at: f.archivedProject ? "2026-10-01" : null };
    }) as any,
    listIssueIds: (async () => { calls.push("list"); return { ids: f.visible ?? [], complete: true, totalPages: f.listPages ?? 1 }; }) as any,
    listIssueActivities: (async (_s: string, _p: string, id: string) => { calls.push(`activities:${id}`); return f.activities?.[id] ?? []; }) as any,
  };
  return { plane, calls };
}
async function linkDb(ids: string[]) {
  const db = await freshDb();
  for (const [n, id] of ids.entries()) await upsertSyncLink(db, { planeWorkspaceSlug: "ws", planeProjectId: "p", planeIssueId: id, ghRepoId: 1, ghNumber: n + 1, ghKind: "issue", tier: "closing", createdBy: "manual" });
  return db;
}
const row = async (db: PGlite, id: string) => (await db.query<any>(`SELECT status, plane_archived_at, missing_since FROM sync_links WHERE plane_issue_id = $1`, [id])).rows[0];

test("A2: an archived work item is marked archived, stays active, and is never reported as orphaned", async () => {
  const db = await linkDb(["i1"]);
  const { plane } = fakePlane({ activities: { i1: [{ verb: "updated", field: "archived_at", new_value: "archive", created_at: "2026-10-02T00:00:00Z" }] } });
  const orphans: unknown[] = [];
  for (let sweep = 0; sweep < 3; sweep++) {
    const r = await reconcileOnce({ db, plane, onOrphan: async (l) => { orphans.push(l.id); } });
    strictEqual(r.orphaned, 0); strictEqual(r.archived, 1);
  }
  const l = await row(db, "i1");
  strictEqual(l.status, "active"); ok(l.plane_archived_at); strictEqual(l.missing_since, null);
  deepStrictEqual(orphans, []);
  strictEqual((await db.query(`SELECT 1 FROM audit_log WHERE kind = 'sync_link_archived'`)).rows.length, 1);
});

test("A2: every link in an archived project is archived, not orphaned", async () => {
  const db = await linkDb(["i1", "i2", "i3"]);
  const { plane, calls } = fakePlane({ archivedProject: true });
  const r = await reconcileOnce({ db, plane });
  deepStrictEqual([r.archived, r.orphaned], [3, 0]);
  strictEqual(calls.filter((c) => c === "project").length, 1, "the project is read once per sweep");
});

test("A2: an unarchived item becomes plain active again", async () => {
  const db = await linkDb(["i1"]);
  await reconcileOnce({ db, plane: fakePlane({ archivedProject: true }).plane });
  ok((await row(db, "i1")).plane_archived_at);
  await reconcileOnce({ db, plane: fakePlane({ visible: ["i1"] }).plane });
  strictEqual((await row(db, "i1")).plane_archived_at, null);
});

test("A2: a deleted item is orphaned at once; an unexplained 404 needs a second sweep to agree", async () => {
  const db = await linkDb(["del", "odd"]);
  const { plane } = fakePlane({ activities: { del: [{ verb: "deleted", field: "issue", created_at: "2026-10-02T00:00:00Z" }] } });
  const orphans: string[] = [];
  const onOrphan = async (l: { plane_issue_id: string }) => { orphans.push(l.plane_issue_id); };
  const r1 = await reconcileOnce({ db, plane, onOrphan });
  strictEqual(r1.orphaned, 1); deepStrictEqual(orphans, ["del"]);
  strictEqual((await row(db, "odd")).status, "active"); ok((await row(db, "odd")).missing_since);
  const r2 = await reconcileOnce({ db, plane, onOrphan });
  strictEqual(r2.orphaned, 1); deepStrictEqual(orphans, ["del", "odd"]);
});

test("A2: a 404 that the next sweep does not repeat is forgotten", async () => {
  const db = await linkDb(["i1"]);
  await reconcileOnce({ db, plane: fakePlane({}).plane });
  ok((await row(db, "i1")).missing_since);
  await reconcileOnce({ db, plane: fakePlane({ visible: ["i1"] }).plane });
  strictEqual((await row(db, "i1")).missing_since, null);
  await reconcileOnce({ db, plane: fakePlane({}).plane });
  strictEqual((await row(db, "i1")).status, "active", "a fresh 404 starts the confirmation again");
});

test("A2: the newest archive or delete activity decides; a restore is not proof of anything", () => {
  strictEqual(verdictFromActivities([
    { verb: "updated", field: "archived_at", new_value: "archive", created_at: "2026-10-01T00:00:00Z" },
    { verb: "deleted", field: "issue", created_at: "2026-10-03T00:00:00Z" },
  ]), "deleted");
  strictEqual(verdictFromActivities([{ verb: "updated", field: "archived_at", new_value: "manual_archive", created_at: "2026-10-01T00:00:00Z" }]), "archived");
  strictEqual(verdictFromActivities([{ verb: "updated", field: "archived_at", new_value: "restore", created_at: "2026-10-01T00:00:00Z" }]), "unknown");
  strictEqual(verdictFromActivities([{ verb: "updated", field: "name", created_at: "2026-10-01T00:00:00Z" }]), "unknown");
});

test("A6: links of one project are checked with a listing, not one GET each", async () => {
  const ids = ["a", "b", "c", "d", "e", "f"];
  const db = await linkDb(ids);
  const { plane, calls } = fakePlane({ visible: ids });
  const r = await reconcileOnce({ db, plane });
  strictEqual(r.checked, 6);
  deepStrictEqual(calls, ["list"]);
});

test("A6: ids missing from the listing are read one by one, and a single link is just read", async () => {
  const db = await linkDb(["a", "b", "c"]);
  const listed = fakePlane({ visible: ["a", "b"] });
  (listed.plane as any).getIssue = async (_s: string, _p: string, id: string) => { listed.calls.push(`get:${id}`); return { id }; };
  await reconcileOnce({ db, plane: listed.plane });
  deepStrictEqual(listed.calls, ["list", "get:c"]);

  const one = await linkDb(["solo"]);
  const single = fakePlane({ visible: ["solo"] });
  await reconcileOnce({ db: one, plane: single.plane });
  deepStrictEqual(single.calls, ["get:solo"]);
});

test("A6: the client stops listing after one page when the project has more pages than the caller allows", async () => {
  const urls: string[] = [];
  const fetchFn = (async (url: string) => {
    urls.push(new URL(url).pathname + new URL(url).search);
    return new Response(JSON.stringify({ results: [{ id: "x" }], next_cursor: "100:1:0", next_page_results: true, total_pages: 40 }), { status: 200 });
  }) as unknown as typeof fetch;
  const client = new PlaneClient({ baseUrl: "http://plane.test", token: new SecretString("k"), fetch: fetchFn, rateLimitPerMinute: 0 });
  const page = await client.listIssueIds("ws", "p", { maxPages: 3 });
  deepStrictEqual(page, { ids: ["x"], complete: false, totalPages: 40 });
  strictEqual(urls.length, 1);
  ok(urls[0]!.startsWith("/api/v1/workspaces/ws/projects/p/work-items/?"), urls[0]);
  ok(urls[0]!.includes("fields=id") && urls[0]!.includes("per_page=100"), urls[0]);
});

// ---- A5: rate limiting --------------------------------------------------------------------------------

// The bucket and the measurement share one virtual clock (`now` and `sleep`). Measuring on the fake sleep alone while
// the bucket read Date.now() made this test fail whenever a real millisecond passed during the first burst.
function virtualBucket(rate: number, capacity: number) {
  let now = 1_000_000;
  const sends: number[] = [];
  const bucket = new TokenBucket(rate, capacity, async (ms) => { now += ms; }, () => now);
  return { sends, stall: (ms: number) => { now += ms; }, send: async () => { await bucket.acquire(); sends.push(now); } };
}
/** Most sends inside any window (end - span, end], Plane's own comparison (DRF drops history `<= now - duration`). */
const busiest = (sends: number[], span: number) =>
  Math.max(...sends.map((end) => sends.filter((t) => t > end - span && t <= end).length));

test("A5: the default burst is small, and no sliding minute ever carries more than the per-minute limit", async () => {
  strictEqual(new TokenBucket(60).capacity, DEFAULT_PLANE_BURST);
  strictEqual(new TokenBucket(3).capacity, 3);
  const v = virtualBucket(60, 60);
  // A millisecond of slow code inside the first burst splits it across two instants, the case that used to fail.
  for (let i = 0; i < 150; i++) { if (i === 30) v.stall(1); await v.send(); }
  const n = busiest(v.sends, PLANE_RATE_WINDOW_MS + PLANE_RATE_MARGIN_MS);
  ok(n <= 60, `${n} sends in one window`);
});

test("A5: the limit-plus-first send leaves at least a second of slack past Plane's minute, never exactly t + 60 s", async () => {
  const v = virtualBucket(3, 3);
  for (let i = 0; i < 4; i++) await v.send();
  const [first, , , fourth] = v.sends;
  // Plane's throttle alone would admit the fourth at first + 60 s; a slower first request would then still count.
  ok(fourth! - first! >= PLANE_RATE_WINDOW_MS + 1_000, `fourth sent ${fourth! - first!} ms after the first`);
});

test("A5: a sleep that overruns once is booked at the real send time, so later windows count from it", async () => {
  let now = 0, sleeps = 0;
  // Only the first sleep overruns (a busy event loop): booked at its planned time, that send would leave this
  // history 2.5 s (longer than the margin) before it leaves Plane's minute, and the send after it would be a third there.
  const bucket = new TokenBucket(2, 2, async (ms) => { now += ms + (sleeps++ === 0 ? PLANE_RATE_MARGIN_MS + 1_500 : 0); }, () => now);
  const sends: number[] = [];
  for (let i = 0; i < 6; i++) { await bucket.acquire(); sends.push(now); }
  ok(busiest(sends, PLANE_RATE_WINDOW_MS) <= 2, `busiest window ${busiest(sends, PLANE_RATE_WINDOW_MS)}: ${sends.join(",")}`);
});

test("A5: a response reporting X-RateLimit-Remaining: 0 defers the next request to the reset, without sleeping", async () => {
  const sleeps: number[] = [];
  const reset = Math.ceil(Date.now() / 1000) + 30;
  let n = 0;
  const fetchFn = (async () => { n++; return new Response("{}", { status: 200, headers: n === 1 ? { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(reset) } : {} }); }) as unknown as typeof fetch;
  const client = new PlaneClient({ baseUrl: "http://plane.test", token: new SecretString("k"), fetch: fetchFn, sleep: async (ms) => { sleeps.push(ms); } });
  await client.request("GET", "/a/");
  let err: unknown;
  try { await client.request("GET", "/b/"); } catch (e) { err = e; }
  ok(err instanceof PlaneRateLimitError);
  strictEqual(err.requestMade, false);
  ok(Math.abs(err.retryAt - reset * 1000) < 1000, `retryAt ${err.retryAt} vs reset ${reset * 1000}`);
  strictEqual(n, 1, "nothing was sent while the key is exhausted");
  deepStrictEqual(sleeps, []);
});

test("A5: an exhausted actor key does not pause the service key's budget", async () => {
  const sleeps: number[] = [];
  const reset = Math.ceil(Date.now() / 1000) + 30;
  const fetchFn = (async (_u: string, init: any) => new Response("{}", { status: 200, headers: init.headers["X-API-Key"] === "actor" ? { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(reset) } : {} })) as unknown as typeof fetch;
  const client = new PlaneClient({ baseUrl: "http://plane.test", token: new SecretString("svc"), fetch: fetchFn, sleep: async (ms) => { sleeps.push(ms); } });
  await client.request("GET", "/a/", undefined, { token: new SecretString("actor") });
  await client.request("GET", "/b/");
  deepStrictEqual(sleeps, []);
});

// ---- A9 / A10 -----------------------------------------------------------------------------------------

function writerHarness() {
  const calls: { method: string; path: string }[] = [];
  const fetchFn = (async (url: string, init: any) => {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname });
    if (u.pathname.endsWith("/states/")) return new Response(JSON.stringify([{ id: "s1", name: "Todo", group: "unstarted" }]), { status: 200 });
    if (init.method === "POST") return new Response(JSON.stringify({ id: "new" }), { status: 201 });
    return new Response(JSON.stringify({ id: "x" }), { status: 200 });
  }) as unknown as typeof fetch;
  const client = new PlaneClient({ baseUrl: "http://plane.test", token: new SecretString("k"), fetch: fetchFn, rateLimitPerMinute: 0 });
  const db = { query: async () => ({ rows: [] }) } as any;
  return { client, writer: new PlaneWritePath({ client, db }), calls };
}

test("A9: a state id missing from the refreshed list is reported as unknown or triage", async () => {
  const { writer } = writerHarness();
  let err: unknown;
  try { await writer.apply({ kind: "update_issue", slug: "ws", projectId: "p", issueId: "i", fields: { state: "triage-id" } }); } catch (e) { err = e; }
  ok(err instanceof UnknownPlaneState);
  ok(err.mayBeTriage);
  ok(/unknown Plane state/.test(err.message) && /triage/.test(err.message), err.message);
});

test("A10: every Plane read and write uses the work-items URL family", async () => {
  strictEqual(PLANE_ITEMS_SEGMENT, "work-items");
  strictEqual(planeItemsPath("ws", "p"), "/workspaces/ws/projects/p/work-items/");
  strictEqual(planeItemsPath("ws", "p", "i"), "/workspaces/ws/projects/p/work-items/i/");
  const { client, writer, calls } = writerHarness();
  const W = { slug: "ws", projectId: "p" };
  await client.getIssue("ws", "p", "i");
  await client.getIssueByIdentifier("ws", "PROJ-1");
  await writer.apply({ kind: "update_issue", ...W, issueId: "i", fields: { name: "n" } });
  await writer.apply({ kind: "create_issue", ...W, fields: { name: "n" } });
  await writer.apply({ kind: "add_comment", ...W, issueId: "i", commentHtml: "<p>x</p>" });
  await writer.apply({ kind: "add_link", ...W, issueId: "i", url: "https://x", title: "t" });
  await writer.apply({ kind: "update_link", ...W, issueId: "i", linkId: "l", url: "https://x", title: "t" });
  const itemCalls = calls.filter((c) => !c.path.endsWith("/states/"));
  ok(itemCalls.length >= 7);
  for (const c of itemCalls) ok(c.path.includes("/work-items/") && !c.path.includes("/issues/"), `${c.method} ${c.path}`);
});

// ---- Round 2, contract 2: a Plane 429 defers the job instead of sleeping in the client ----------------

function plane429(headers: Record<string, string>) {
  const sleeps: number[] = [];
  let calls = 0;
  const fetchFn = (async () => { calls++; return new Response(JSON.stringify({ detail: "Request was throttled." }), { status: 429, headers }); }) as unknown as typeof fetch;
  const client = new PlaneClient({ baseUrl: "http://plane.test", token: new SecretString("svc"), fetch: fetchFn, sleep: async (ms) => { sleeps.push(ms); } });
  return { client, sleeps, calls: () => calls };
}
const caught = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e; } throw new Error("expected a rejection"); };

test("contract 2: a Plane 429 is thrown once with the Retry-After deadline; the client never sleeps or resends", async () => {
  for (const method of ["GET", "PATCH", "POST"]) {
    const h = plane429({ "Retry-After": "30" });
    const before = Date.now();
    const err = await caught(h.client.request(method, "/x/", method === "GET" ? undefined : {}));
    ok(err instanceof PlaneRateLimitError, method);
    ok(err instanceof PlaneApiError && err.status === 429, "still a PlaneApiError 429 for existing status checks");
    strictEqual(err.requestMade, true);
    ok(err.retryAt >= before + 30_000 && err.retryAt <= Date.now() + 30_000, `retryAt ${err.retryAt - before}ms`);
    strictEqual(h.calls(), 1); deepStrictEqual(h.sleeps, []);
    const c = classifyGithubError(err);
    ok(c.kind === "rate_limited" && Math.abs(c.retryAt - err.retryAt) < 1000, "G1's classifier reads the same deadline");
  }
});

test("contract 2: without Retry-After the deadline is X-RateLimit-Reset, and the key's later requests defer unsent", async () => {
  const reset = Math.ceil(Date.now() / 1000) + 45;
  const h = plane429({ "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(reset) });
  const first = await caught(h.client.request("GET", "/a/"));
  ok(first instanceof PlaneRateLimitError);
  strictEqual(first.retryAt, reset * 1000);
  const second = await caught(h.client.request("GET", "/b/"));
  ok(second instanceof PlaneRateLimitError);
  strictEqual(second.requestMade, false);
  ok(second.retryAt >= reset * 1000 - 1);
  strictEqual(h.calls(), 1); deepStrictEqual(h.sleeps, []);
});

test("contract 2: the queue moves a job hit by a Plane 429 to its deadline instead of holding the worker", async () => {
  const h = plane429({ "Retry-After": "20" });
  const delayed: number[] = [];
  const job: DeferredJob = {
    data: {}, attemptsMade: 0, opts: { attempts: 10 },
    async updateData(d) { this.data = d; },
    async moveToDelayed(ts) { delayed.push(ts); },
  };
  let thrown: unknown;
  try { await processQueueJob(job, () => h.client.request("GET", "/x/")); } catch (e) { thrown = e; }
  strictEqual((thrown as Error).name, "DelayedError");
  strictEqual(delayed.length, 1);
  ok(delayed[0]! >= Date.now() + 18_000 && delayed[0]! <= Date.now() + 21_000, `delayed to +${delayed[0]! - Date.now()}ms`);
  deepStrictEqual(h.sleeps, []);

  // A deferral raised before any request is never scheduled earlier than the budget's own deadline.
  const local = new PlaneRateLimitError(Date.now() + 5_000, { requestMade: false });
  try { await processQueueJob(job, async () => { throw local; }); } catch { /* DelayedError */ }
  ok(delayed[1]! >= local.retryAt);
});
