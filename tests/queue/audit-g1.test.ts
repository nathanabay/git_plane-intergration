import test from "node:test";
import { deepStrictEqual, strictEqual, ok, rejects } from "node:assert/strict";
import { DelayedError, UnrecoverableError } from "bullmq";
import { classifyGithubError, GithubRateLimitError, withGithubRateLimits } from "../../src/github/errors.ts";
import { retryDelayMs } from "../../src/sync/backoff.ts";
import { GithubWritePath } from "../../src/sync/github.ts";
import { PlaneRateLimitError } from "../../src/sync/plane.ts";
import { opHash } from "../../src/sync/ophash.ts";
import { processInbound, processQueueJob, isPermanentWriteError, planeCommentIdentity } from "../../src/queue/workers.ts";
import type { DeferredJob, InboundDeps } from "../../src/queue/workers.ts";
import type { InboundJob } from "../../src/queue/index.ts";
import { createOrderedOutbox, deliveryScope, OrderedWriteDeferredError, QueuedWriteFailedError } from "../../src/app/writers.ts";
import { database, queue, intentJob } from "../writers/outbox-fixture.ts";

const NOW = Date.UTC(2026, 9, 12);
const target = { installationId: 801, owner: "audit", repo: "test", repoId: 802, number: 3 };
const http = (status: number, headers: Record<string, string | number> = {}, message = "GitHub failure") =>
  Object.assign(new Error(message), { status, response: { status, headers, data: { message } } });

function deferredJob(data: any = {}, attempts = 10) {
  const deadlines: number[] = [];
  const job: DeferredJob = { data, attemptsMade: 0, opts: { attempts }, token: "lock",
    updateData: async (next) => { job.data = next; },
    moveToDelayed: async (at, token) => { strictEqual(token, "lock"); deadlines.push(at); },
  };
  return { job, deadlines };
}

test("G2: message-only secondary 403 is retriable; permission and not-found remain distinct", () => {
  const err = http(403, { "x-ratelimit-remaining": "42" }, "You have exceeded a secondary rate limit.");
  deepStrictEqual(classifyGithubError(err, { now: NOW }), { kind: "rate_limited", retryAt: NOW + 60_000 });
  deepStrictEqual(classifyGithubError(err, { now: NOW, attempt: 2 }), { kind: "rate_limited", retryAt: NOW + 240_000 });
  strictEqual(isPermanentWriteError(err), false);
  const bodyOnly = http(403, { "x-ratelimit-remaining": "42" }, "You have exceeded a secondary rate limit.");
  bodyOnly.message = "Forbidden";
  deepStrictEqual(classifyGithubError(bodyOnly, { now: NOW }), { kind: "rate_limited", retryAt: NOW + 60_000 });
  deepStrictEqual(classifyGithubError(http(403, {}, "Resource not accessible by integration")), { kind: "permission" });
  strictEqual(isPermanentWriteError(http(403)), true);
  deepStrictEqual(classifyGithubError(http(404)), { kind: "not_found" });
  deepStrictEqual(classifyGithubError(http(503)), { kind: "transient" });
  deepStrictEqual(classifyGithubError(http(422)), { kind: "permanent" });
});

test("G2/G3: long, mixed-case and numeric headers preserve all server deadlines", () => {
  deepStrictEqual(classifyGithubError(http(403, { "X-RateLimit-Remaining": 0, "X-RateLimit-Reset": (NOW + 2_700_000) / 1000 }), { now: NOW }),
    { kind: "rate_limited", retryAt: NOW + 2_700_000 });
  deepStrictEqual(classifyGithubError(http(429, { "Retry-After": "900" }), { now: NOW }),
    { kind: "rate_limited", retryAt: NOW + 900_000 });
  deepStrictEqual(classifyGithubError(http(429, { "retry-after": "900", "x-ratelimit-remaining": "0", "x-ratelimit-reset": (NOW + 2_700_000) / 1000 }), { now: NOW }),
    { kind: "rate_limited", retryAt: NOW + 2_700_000 });
  deepStrictEqual(classifyGithubError(http(429), { now: NOW, attempt: 1 }), { kind: "rate_limited", retryAt: NOW + 120_000 });
  const headers = { "retry-after": "1800" };
  strictEqual(retryDelayMs((n) => headers[n as keyof typeof headers], 0, { now: NOW }), 1_800_000);
  strictEqual(retryDelayMs((n) => n === "x-ratelimit-reset" ? String((NOW + 2_700_000) / 1000) : undefined, 0, { now: NOW }), 2_700_000);
  strictEqual(retryDelayMs((n) => n === "retry-after" ? new Date(NOW + 900_000).toUTCString() : undefined, 0, { now: NOW }), 900_000);
});

test("G4: inbound and raw outbound reads move to delayed, with bounded exponential secondary retries", async () => {
  for (const outbound of [false, true]) {
    const { job, deadlines } = deferredJob({}, 3);
    const err = http(403, {}, "You have exceeded a secondary rate limit.");
    await rejects(processQueueJob(job, async () => { throw err; }, { outbound, now: () => NOW }), DelayedError);
    await rejects(processQueueJob(job, async () => { throw err; }, { outbound, now: () => NOW + 60_000 }), DelayedError);
    deepStrictEqual(deadlines, [NOW + 60_000, NOW + 180_000]);
    strictEqual(job.data._rateLimitAttempts, 2);
    await rejects(processQueueJob(job, async () => { throw err; }, { outbound, now: () => NOW + 180_000 }), UnrecoverableError);
    strictEqual(deadlines.length, 2);
  }
  const h = deferredJob();
  await rejects(processQueueJob(h.job, async () => { throw http(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": (NOW + 2_700_000) / 1000 }); }, { now: () => NOW }), DelayedError);
  deepStrictEqual(h.deadlines, [NOW + 2_700_000]);
});

test("G3: ordered retries use absolute deadlines without adding worker scheduling drift", async () => {
  const h = deferredJob();
  await rejects(processQueueJob(h.job, async () => { throw new OrderedWriteDeferredError(900_000, NOW + 900_000); }, { now: () => NOW + 2000 }), DelayedError);
  deepStrictEqual(h.deadlines, [NOW + 900_000]);
  const budget = deferredJob({}, 1);
  await rejects(processQueueJob(budget.job, async () => { throw new GithubRateLimitError(NOW + 900_000, undefined, false); }, { now: () => NOW }), DelayedError);
  strictEqual(budget.job.data._rateLimitAttempts, 0, "an already blocked request has not consumed an API attempt");
  const restarted = deferredJob({ _rateLimitAttempts: 3 });
  await rejects(processQueueJob(restarted.job, async () => {
    throw new GithubRateLimitError(NOW + 60_000, http(403, {}, "You have exceeded a secondary rate limit."));
  }, { now: () => NOW }), DelayedError);
  deepStrictEqual(restarted.deadlines, [NOW + 480_000], "durable attempt count drives exponential fallback after restart");
});

test("G4 relay: Plane deferrals preserve their carried deadline and any later response deadline", () => {
  const unsent = new PlaneRateLimitError(NOW + 5000, { requestMade: false, headers: { "retry-after": "900" } });
  deepStrictEqual(classifyGithubError(unsent, { now: NOW, attempt: 3 }), { kind: "rate_limited", retryAt: NOW + 5000 });
  const laterResponse = new PlaneRateLimitError(NOW + 5000, { headers: { "retry-after": "900" } });
  deepStrictEqual(classifyGithubError(laterResponse, { now: NOW }), { kind: "rate_limited", retryAt: NOW + 900_000 });
  const laterCarried = new PlaneRateLimitError(NOW + 900_000, { headers: { "retry-after": "2" } });
  deepStrictEqual(classifyGithubError(laterCarried, { now: NOW }), { kind: "rate_limited", retryAt: NOW + 900_000 });
});

test("G4 relay: queue deferrals spend attempts only for errors with an actual request", async () => {
  const { job, deadlines } = deferredJob({}, 1);
  await rejects(processQueueJob(job, async () => {
    throw new PlaneRateLimitError(NOW + 5000, { requestMade: false });
  }, { now: () => NOW }), DelayedError);
  strictEqual(job.data._rateLimitAttempts, 0);
  await rejects(processQueueJob(job, async () => {
    throw Object.assign(http(429, { "retry-after": "2" }), { requestMade: false });
  }, { now: () => NOW }), DelayedError);
  strictEqual(job.data._rateLimitAttempts, 0, "the contract applies to every error, not only typed GitHub/Plane errors");
  deepStrictEqual(deadlines, [NOW + 5000, NOW + 2000]);
  await rejects(processQueueJob(job, async () => {
    throw new PlaneRateLimitError(NOW + 60_000);
  }, { now: () => NOW }), UnrecoverableError);
  strictEqual(deadlines.length, 2, "an actual request exhausts the configured one-attempt budget");
});

test("G4 relay: outbox budget deferrals retain zero attempts until a request actually fails", async (t) => {
  const db = await database(t);
  let clock = NOW;
  let failure: unknown = new PlaneRateLimitError(clock + 5000, { requestMade: false });
  const outbox = createOrderedOutbox({ db, maxAttempts: 1, now: () => clock,
    queues: { plane: queue() as any, github: queue() as any }, loadActorToken: async () => null,
    plane: { preflight: async () => {}, apply: async () => { throw failure; } },
    github: { apply: async () => ({ ok: true }) },
  });
  await deliveryScope.run({ deliveryId: "g4-budget-relay" }, () => outbox.plane.apply({
    kind: "update_issue", slug: "ws", projectId: "project", issueId: "issue", fields: { name: "updated" },
  }));
  const job = await intentJob(db);
  for (const wait of [5000, 2000]) {
    const expectedDeadline = clock + wait;
    if (wait === 2000) failure = Object.assign(http(429, { "retry-after": "2" }), { requestMade: false });
    await rejects(outbox.executePlane(job), (err: unknown) => err instanceof OrderedWriteDeferredError && err.retryAt === expectedDeadline);
    const row = (await db.query<{ status: string; attempts: number; retry_at: string }>(
      "SELECT status, attempts, retry_at FROM outbound_writes WHERE id = $1", [job.id])).rows[0]!;
    strictEqual(row.status, "pending");
    strictEqual(row.attempts, 0, "any unsent deferral must preserve the request-attempt budget");
    strictEqual(new Date(row.retry_at).getTime(), expectedDeadline);
    clock = expectedDeadline;
  }
  failure = new PlaneRateLimitError(clock + 60_000);
  await rejects(outbox.executePlane(job), QueuedWriteFailedError);
  deepStrictEqual((await db.query("SELECT status, attempts, retry_at FROM outbound_writes WHERE id = $1", [job.id])).rows,
    [{ status: "failed", attempts: 1, retry_at: null }]);
});

test("G3/G4: cooldown persists between clients and blocks reads from other jobs until the full deadline", async (t) => {
  const db = await database(t);
  let clock = NOW, calls = 0;
  const key = "installation:audit-g1-read";
  const first = withGithubRateLimits({ request: async (_route: string) => { calls++; throw http(429, { "retry-after": "900" }); } }, { db, key, now: () => clock });
  await rejects(first.request("GET /repos/audit/test"), (err: unknown) => err instanceof GithubRateLimitError && err.retryAt === NOW + 900_000);
  const second = withGithubRateLimits({ request: async (_route: string) => { calls++; return { data: [] }; } }, { db, key, now: () => clock });
  clock += 300_000;
  await rejects(second.request("GET /repos/audit/test/pulls"), (err: unknown) => err instanceof GithubRateLimitError && !err.requestMade);
  strictEqual(calls, 1);
  const row = (await db.query<{ received_at: string }>("SELECT received_at FROM webhook_deliveries WHERE delivery_id = $1", [`github-rate-limit:${key}`])).rows[0]!;
  strictEqual(new Date(row.received_at).getTime(), NOW + 900_000);
  clock = NOW + 900_000;
  deepStrictEqual(await second.request("GET /repos/audit/test/pulls"), { data: [] });
  strictEqual(calls, 2);
});

test("G4: durable outbox read failures retain the full retry_at and release execution", async (t) => {
  const db = await database(t);
  let clock = NOW, reads = 0;
  const pq = queue(), gq = queue();
  const outbox = createOrderedOutbox({ db, plane: { preflight: async () => {}, apply: async () => ({ ok: true }) },
    github: { apply: async () => ({ ok: true }) }, queues: { plane: pq as any, github: gq as any }, loadActorToken: async () => null,
    listGithubAssignees: async () => { reads++; throw http(429, { "retry-after": "1800" }); }, now: () => clock });
  await deliveryScope.run({ deliveryId: "audit-read", workspaceSlug: "ws" }, () => outbox.github.setAssignees({ kind: "add_assignees", ...target, assignees: [] }, "ws"));
  const job = await intentJob(db);
  await rejects(outbox.executeGithub(job), (err: unknown) => err instanceof OrderedWriteDeferredError && err.retryAt === NOW + 1_800_000);
  const row = (await db.query<{ status: string; attempts: number; retry_at: string }>("SELECT status, attempts, retry_at FROM outbound_writes WHERE id = $1", [job.id])).rows[0]!;
  strictEqual(row.status, "pending"); strictEqual(row.attempts, 1);
  strictEqual(new Date(row.retry_at).getTime(), NOW + 1_800_000);
  clock += 300_000;
  await rejects(outbox.executeGithub(job), OrderedWriteDeferredError);
  strictEqual(reads, 1, "retry does not read GitHub at the old five-minute cap");
});

test("G2/G3: a GitHub write clears echo markers and defers instead of sleeping/retrying", async (t) => {
  const db = await database(t);
  let calls = 0, sleeps = 0;
  const writer = new GithubWritePath({ db, sleep: async () => { sleeps++; }, app: { installationOctokit: async () => ({
    request: async () => { calls++; throw http(403, {}, "You have exceeded a secondary rate limit."); },
  }) } });
  const started = Date.now();
  await rejects(writer.apply({ kind: "comment", ...target, installationId: 810, body: "hello" }),
    (err: unknown) => err instanceof GithubRateLimitError && err.retryAt >= started + 60_000);
  strictEqual(calls, 1); strictEqual(sleeps, 0);
  strictEqual((await db.query("SELECT 1 FROM applied_ops WHERE op_hash = $1", [opHash("github", `${target.repoId}#${target.number}`, "comment", "hello")])).rows.length, 0);
});

test("G13: 404 removal succeeds only for an accessible, well-formed issue lacking the label", async (t) => {
  const db = await database(t);
  for (const [index, labels] of [[], [{ name: "Keep" }], [{ name: "Gone" }], undefined, [{ invalid: true }]].entries()) {
    const routes: string[] = [];
    const writer = new GithubWritePath({ db, app: { installationOctokit: async () => ({ request: async (route: string) => {
      routes.push(route);
      if (route.startsWith("DELETE")) throw http(404);
      return { data: { labels } };
    } }) } });
    const write = { kind: "remove_label" as const, ...target, installationId: 820 + index, label: "gone" };
    if (index < 2) deepStrictEqual(await writer.apply(write), { ok: true });
    else await rejects(writer.apply(write), (err: any) => err.status === 404);
    deepStrictEqual(routes, ["DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}", "GET /repos/{owner}/{repo}/issues/{issue_number}"]);
  }
  for (const status of [404, 403, 429]) {
    const writer = new GithubWritePath({ db, app: { installationOctokit: async () => ({ request: async (route: string) => {
      if (route.startsWith("DELETE")) throw http(404);
      throw http(status);
    } }) } });
    await rejects(writer.apply({ kind: "remove_label", ...target, installationId: 830 + status, label: "gone" }),
      (err: unknown) => status === 429 ? err instanceof GithubRateLimitError : (err as any).status === status);
  }
});

const comment = (deliveryId: string, id = "comment-one"): InboundJob => ({ source: "plane", event: "issue_comment", deliveryId,
  receivedAt: "", payload: { workspace_id: "ws-id", webhook_id: "hook", action: "created",
    data: { id, project: "project", issue: "issue", comment_html: "<p>hello</p>" }, activity: { actor: { id: "user" } } } });

test("P4: fresh Plane delivery UUIDs deduplicate one immutable comment, but distinct comments and replay run", async (t) => {
  const db = await database(t);
  const handled: InboundJob[] = [];
  const deps: InboundDeps = { db, opTtlMinutes: 5, onGithubEvent: async () => {}, onPlaneEvent: async (job) => { handled.push(job); } };
  strictEqual(await processInbound(comment("attempt-one"), deps), "handled");
  strictEqual(await processInbound(comment("attempt-two"), deps), "duplicate");
  strictEqual(await processInbound(comment("distinct", "comment-two"), deps), "handled");
  const key = planeCommentIdentity(comment("unused"));
  ok(key);
  strictEqual(handled[0]!.deliveryId, key);
  const audit = (await db.query<{ detail: any }>("SELECT detail FROM audit_log WHERE delivery_id = $1", ["attempt-one"])).rows[0]!;
  strictEqual(audit.detail.writeDeliveryId, key);
  strictEqual(await processInbound({ ...comment("replay-123"), writeDeliveryId: key }, deps), "handled");
  strictEqual(handled.length, 3);
});

test("P4: failed content claims are released, and TTL expiry retains the same durable write identity", async (t) => {
  const db = await database(t);
  let fail = true;
  const identities: string[] = [];
  const deps: InboundDeps = { db, opTtlMinutes: 5, onGithubEvent: async () => {}, onPlaneEvent: async (job) => {
    identities.push(job.deliveryId); if (fail) throw new Error("temporary failure");
  } };
  await rejects(processInbound(comment("failed-attempt"), deps), /temporary failure/);
  fail = false;
  strictEqual(await processInbound(comment("retry-attempt"), deps), "handled");
  await db.query("UPDATE webhook_deliveries SET received_at = now() - interval '6 minutes' WHERE delivery_id = $1", [`content:${identities[0]}`]);
  strictEqual(await processInbound(comment("late-attempt"), deps), "handled");
  deepStrictEqual(identities, [identities[0], identities[0], identities[0]]);
  strictEqual(planeCommentIdentity({ ...comment("edited"), payload: { ...(comment("edited").payload as any), action: "updated" } }), null);
  strictEqual(planeCommentIdentity({ ...comment("issue"), event: "issue" }), null, "ordinary edits are not collapsed by content");
});

test("P4: duplicate Plane comment attempts register only one GitHub comment even after claim expiry", async (t) => {
  const db = await database(t);
  const pq = queue(), gq = queue();
  const outbox = createOrderedOutbox({ db, plane: { preflight: async () => {}, apply: async () => ({ ok: true }) }, github: { apply: async () => ({ ok: true }) },
    queues: { plane: pq as any, github: gq as any }, loadActorToken: async () => null });
  const deps: InboundDeps = { db, opTtlMinutes: 5, onGithubEvent: async () => {}, onPlaneEvent: async (job) => {
    await deliveryScope.run({ deliveryId: `plane-${job.writeDeliveryId ?? job.deliveryId}`, workspaceSlug: "ws" },
      () => outbox.github.apply({ kind: "comment", ...target, body: String((job.payload as any).data.comment_html) }));
  } };
  await processInbound(comment("first"), deps);
  await processInbound(comment("second"), deps);
  await db.query("UPDATE webhook_deliveries SET received_at = now() - interval '6 minutes' WHERE delivery_id = $1", [`content:${planeCommentIdentity(comment("unused"))}`]);
  const late = comment("third");
  (late.payload as any).data.comment_html = "<p>Edited after the original creation</p>";
  await processInbound(late, deps);
  strictEqual((await db.query("SELECT 1 FROM outbound_writes")).rows.length, 1);
});
