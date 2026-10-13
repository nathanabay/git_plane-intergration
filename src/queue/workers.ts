import { DelayedError, UnrecoverableError, Worker } from "bullmq";
import type { Job } from "bullmq";
import type { Db } from "../db/migrate.ts";
import { appendAudit, consumeRecentOp, createPending, forgetDelivery, recordDelivery } from "../db/ledgers.ts";
import { OrderedWriteDeferredError } from "../app/writers.ts";
import type { OrderedOutbox } from "../app/writers.ts";
import { githubFieldChanges, GithubWritePath, pendingGithubCreateHash } from "../sync/github.ts";
import type { GithubWrite } from "../sync/github.ts";
import { opHash } from "../sync/ophash.ts";
import { PlaneApiError, PlaneWritePath, TriageWriteRejected, UnknownPlaneState, pendingCommentHash, pendingCreateHash } from "../sync/plane.ts";
import type { PlaneWrite } from "../sync/plane.ts";
import { QUEUE_NAMES } from "./index.ts";
import type { InboundJob } from "./index.ts";
import { classifyGithubError, GithubRateLimitError, githubErrorStatus, rememberGithubRateLimit } from "../github/errors.ts";
import { createHash } from "node:crypto";
import { normalizeValue } from "../sync/ophash.ts";

const PLANE_CONTENT_TTL_MS = 5 * 60_000;

/** A Plane comment has a durable object ID; transport delivery UUIDs change on retry. */
export function planeCommentIdentity(job: InboundJob): string | null {
  const p = job.payload as any;
  if (job.source !== "plane" || job.event !== "issue_comment" || !["create", "created"].includes(p?.action)
    || typeof p?.data?.id !== "string" || !p.data.id) return null;
  const ref = (v: any) => typeof v === "string" ? v : typeof v?.id === "string" ? v.id : null;
  const identity = { workspace: p.workspace_id ?? p.workspace_slug ?? ref(p.data.workspace),
    project: ref(p.data.project), issue: ref(p.data.issue), comment: p.data.id };
  return `plane-comment-${createHash("sha256").update(normalizeValue(identity)).digest("hex")}`;
}

async function claimPlaneComment(db: Db, identity: string): Promise<boolean> {
  const rows = await db.query(`INSERT INTO webhook_deliveries (source, delivery_id) VALUES ('plane', $1)
    ON CONFLICT (source, delivery_id) DO UPDATE SET received_at = now()
    WHERE webhook_deliveries.received_at < now() - ($2 * interval '1 millisecond') RETURNING delivery_id`,
  [`content:${identity}`, PLANE_CONTENT_TTL_MS]);
  return rows.rows.length > 0;
}

export interface DeferredJob {
  data: any;
  token?: string;
  attemptsMade: number;
  opts: { attempts?: number };
  updateData(data: any): Promise<void>;
  moveToDelayed(timestamp: number, token?: string): Promise<void>;
}

/** Used by all workers: postpone at an absolute server deadline without occupying a worker. */
export async function processQueueJob<T>(job: DeferredJob, work: () => Promise<T>,
  opts: { outbound?: boolean; token?: string; now?: () => number; db?: Db } = {}): Promise<T> {
  const now = opts.now ?? Date.now;
  try { return await work(); }
  catch (err) {
    if (err instanceof OrderedWriteDeferredError) {
      await job.moveToDelayed(err.retryAt ?? now() + err.retryAfterMs, opts.token ?? job.token);
      throw new DelayedError();
    }
    const count = Number(job.data?._rateLimitAttempts ?? 0);
    const classified = classifyGithubError(err, { now: now(), attempt: count });
    if (classified.kind === "rate_limited") {
      const attempts = count + ((err as { requestMade?: unknown } | null)?.requestMade === false ? 0 : 1);
      if (attempts >= (job.opts.attempts ?? (opts.outbound ? 30 : 10)))
        throw new UnrecoverableError("rate-limit retry budget exhausted");
      if (err instanceof GithubRateLimitError && err.key)
        await rememberGithubRateLimit(opts.db, err.key, classified.retryAt, false);
      await job.updateData({ ...job.data, _rateLimitAttempts: attempts });
      await job.moveToDelayed(classified.retryAt, opts.token ?? job.token);
      throw new DelayedError();
    }
    if (opts.outbound && isPermanentWriteError(err, job.attemptsMade))
      throw new UnrecoverableError(err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/** A creation echo may have arrived before its id was recorded; retry shortly instead of treating it as a human event (F13). */
export class CreateInFlightError extends Error {
  constructor() { super("a create is in flight; retrying the event shortly"); this.name = "CreateInFlightError"; }
}

export type InboundOutcome = "duplicate" | "echo" | "handled";

export interface InboundDeps {
  db: Db;
  serviceUserId?: string;
  /** A number, or a function read per event so a changed setting applies without a restart (F17). */
  opTtlMinutes: number | (() => number | Promise<number>);
  onPlaneEvent(job: InboundJob): Promise<void>;
  onGithubEvent(job: InboundJob): Promise<void>;
}

/** The change a Plane webhook reports, hashed exactly as PlaneWritePath recorded it. */
function planeHash(payload: any): string | null {
  const id = payload?.data?.id;
  if (typeof id !== "string") return null;
  const field: string | null = payload?.activity?.field ?? null;
  const val = field ? payload.activity.new_value : null;
  return opHash("plane", id, field ?? "created", val);
}

/** Workspace for the audit row: Plane carries it in the payload; GitHub is resolved through the repo mapping. */
async function workspaceOf(job: InboundJob, db: Db): Promise<string | undefined> {
  const p = job.payload as any;
  if (job.source === "plane") {
    const slug = p?.workspace_slug ?? p?.workspace_detail?.slug ?? p?.data?.workspace_detail?.slug;
    return typeof slug === "string" ? slug : undefined;
  }
  const repoId = p?.repository?.id;
  if (repoId === undefined) return undefined;
  const rows = await db.query<{ workspace_slug: string }>("SELECT DISTINCT workspace_slug FROM repo_mappings WHERE gh_repo_id = $1", [repoId]);
  return rows.rows.length === 1 ? rows.rows[0]!.workspace_slug : undefined;
}

/**
 * Every delivery leaves an `inbound_delivery` audit row (B8 replays from it): the event and payload, never
 * headers or signatures. A duplicate keeps only the event, since its payload is already on file. A failure to
 * write the row of a processed delivery is logged, not thrown: re-running a handled delivery would be worse.
 */
async function auditDelivery(job: InboundJob, deps: InboundDeps, outcome: InboundOutcome | "failed", error?: string): Promise<void> {
  try {
    const workspaceSlug = await workspaceOf(job, deps.db);
    await appendAudit(deps.db, {
      kind: "inbound_delivery",
      source: job.source,
      deliveryId: job.deliveryId,
      ...(workspaceSlug ? { workspaceSlug } : {}),
      detail: {
        ...(outcome === "duplicate" ? { event: job.event } : { event: job.event, payload: job.payload }),
        ...(job.writeDeliveryId ? { writeDeliveryId: job.writeDeliveryId } : {}),
      },
      outcome,
      ...(error ? { error } : {}),
    });
  } catch (err) {
    console.error(`audit of ${job.source} delivery ${job.deliveryId} failed: ${err instanceof Error ? err.message : "unknown error"}`);
  }
}

/**
 * Ingress filter (§5): drop duplicates and our own echoes HERE, never by skipping an outbound write
 * (pitfall 2). Each echo consumes exactly one recorded op, so a later identical human edit is handled.
 *
 * When run inside a BullMQ worker, `attemptInfo` tracks attempt progress so failure is audited only
 * on the final attempt (F14). Standalone invocations omitting `attemptInfo` default to `isFinal = true`.
 */
export async function processInbound(
  job: InboundJob,
  deps: InboundDeps,
  attemptInfo?: { attemptsMade: number; maxAttempts: number }
): Promise<InboundOutcome> {
  if (!(await recordDelivery(deps.db, job.source, job.deliveryId))) {
    await auditDelivery(job, deps, "duplicate");
    return "duplicate";
  }
  // A new transport ID is not a new comment. Keep a stable reducer identity for durable writes
  // even beyond the short content-claim TTL; explicit audit replay bypasses this admission filter.
  const commentIdentity = planeCommentIdentity(job);
  const replay = Boolean(job.writeDeliveryId && job.writeDeliveryId !== job.deliveryId);
  const auditJob = commentIdentity && !replay ? { ...job, writeDeliveryId: commentIdentity } : job;
  let claimedComment = false;
  let outcome: InboundOutcome;
  try {
    if (commentIdentity && !replay) {
      claimedComment = await claimPlaneComment(deps.db, commentIdentity);
      if (!claimedComment) { await auditDelivery(job, deps, "duplicate"); return "duplicate"; }
    }
    outcome = await classifyAndHandle(commentIdentity && !replay ? { ...job, deliveryId: commentIdentity } : job, deps);
  } catch (err) {
    if (claimedComment) await forgetDelivery(deps.db, "plane", `content:${commentIdentity}`);
    await forgetDelivery(deps.db, job.source, job.deliveryId); // let BullMQ's retry process it
    const isFinal = attemptInfo ? (attemptInfo.attemptsMade >= attemptInfo.maxAttempts || attemptInfo.attemptsMade + 1 >= attemptInfo.maxAttempts) : true;
    if (isFinal && classifyGithubError(err).kind !== "rate_limited" && !(job as any)._auditedFinal) {
      (job as any)._auditedFinal = true;
      await auditDelivery(auditJob, deps, "failed", err instanceof Error ? err.message : String(err));
    }
    throw err;
  }
  // When an attempt succeeds, mark any previous failed audit row for this delivery as superseded (F14)
  try {
    await deps.db.query(
      `UPDATE audit_log SET outcome = 'superseded' WHERE kind = 'inbound_delivery' AND source = $1 AND delivery_id = $2 AND outcome = 'failed'`,
      [job.source, job.deliveryId]
    );
  } catch {
    // best-effort cleanup
  }
  await auditDelivery(auditJob, deps, outcome);
  return outcome;
}

const ttlOf = async (deps: InboundDeps): Promise<number> => (typeof deps.opTtlMinutes === "function" ? deps.opTtlMinutes() : deps.opTtlMinutes);

/** Is this a creation event whose id our own in-flight create may not have recorded yet? */
async function createInFlight(job: InboundJob, db: Db): Promise<boolean> {
  const p: any = job.payload;
  if (job.source === "plane") {
    if ((p?.activity?.field ?? null) !== null) return false;
    const ref = (v: any) => (typeof v === "string" ? v : v?.id);
    const projectId = ref(p?.data?.project);
    if (job.event === "issue" && projectId) {
      const name = typeof p?.data?.name === "string" ? p.data.name : "";
      return createPending(db, pendingCreateHash(projectId, name));
    }
    if (job.event === "issue_comment" && ref(p?.data?.issue)) {
      return createPending(db, pendingCommentHash(ref(p.data.issue)));
    }
    return false;
  }
  if (job.event === "issues" && ["opened", "labeled", "assigned"].includes(p?.action) && Number.isSafeInteger(Number(p?.repository?.id))) {
    const title = typeof p?.issue?.title === "string" ? p.issue.title : "";
    return createPending(db, pendingGithubCreateHash(Number(p.repository.id), title));
  }
  return false;
}

/** Polls briefly (up to timeoutMs) for a narrow create-in-flight marker to resolve inline. */
export async function waitForCreateInFlight(job: InboundJob, db: Db, timeoutMs = 2000, pollIntervalMs = 200): Promise<boolean> {
  const start = Date.now();
  while (await createInFlight(job, db)) {
    if (Date.now() - start >= timeoutMs) return true;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return false;
}

async function classifyAndHandle(job: InboundJob, deps: InboundDeps): Promise<InboundOutcome> {
  const ttl = await ttlOf(deps);
  let hashes: string[];
  if (job.source === "plane") {
    const h = planeHash(job.payload);
    hashes = h ? [h] : [];
    const actor = (job.payload as any)?.activity?.actor?.id;
    if (deps.serviceUserId && actor === deps.serviceUserId) {
      // Our own write: drop it, and consume its op so the row cannot swallow a later human edit.
      for (const x of hashes) await consumeRecentOp(deps.db, x, ttl);
      return "echo";
    }
  } else {
    hashes = githubFieldChanges(job.event, job.payload).map((c) => opHash("github", c.targetId, c.field, c.value));
  }
  if (hashes.length > 0) {
    let all = true;
    for (const h of hashes) if (!(await consumeRecentOp(deps.db, h, ttl))) all = false;
    if (all) return "echo";
  }
  if (await createInFlight(job, deps.db)) {
    const stillInFlight = await waitForCreateInFlight(job, deps.db);
    if (stillInFlight) throw new CreateInFlightError();
  }
  await (job.source === "plane" ? deps.onPlaneEvent(job) : deps.onGithubEvent(job));
  return "handled";
}

/** Failures a retry cannot cure: bad input, missing permission, the triage ban. Everything else is retried for hours. */
export function isPermanentWriteError(err: unknown, attemptsMade = 0): boolean {
  if (err instanceof TriageWriteRejected || (err instanceof Error && err.name === "TriageWriteRejected")) return true;
  if (err instanceof UnknownPlaneState || (err instanceof Error && err.name === "UnknownPlaneState")) return true;
  if (err instanceof Error && /unknown Plane state id/.test(err.message)) return true;
  const status = err instanceof PlaneApiError ? err.status : githubErrorStatus(err);
  if (typeof status !== "number" || status < 400 || status >= 500 || status === 408 || status === 429) return false;
  // 401 (e.g. credential rotation) is retriable for bounded attempts (up to 5 attempts) to ride out rotation (F13)
  if (status === 401) {
    return attemptsMade >= 5;
  }
  return classifyGithubError(err).kind !== "rate_limited";
}

/** 5 s doubling to a 10 minute ceiling: with 30 attempts an outage of several hours is ridden out (§4, F9). */
export const outboundBackoff = (attemptsMade: number): number => Math.min(10 * 60_000, 5000 * 2 ** Math.max(0, attemptsMade - 1));

export function startWorkers(opts: {
  connectionUrl: string;
  prefix: string;
  inbound: InboundDeps;
  plane: PlaneWritePath;
  github: GithubWritePath;
  planeWritesPerMinute?: number;
  ordered?: OrderedOutbox;
}): { close(): Promise<void> } {
  const base = { connection: { url: opts.connectionUrl }, prefix: opts.prefix };
  const audit = async (queue: string, job: Job<any> | undefined, err: Error) => {
    try {
      const d = job?.data;
      const g = (d as any)?._gitsync;
      const workspaceSlug = g?.workspaceSlug ?? d?.workspaceSlug ?? d?.slug ?? undefined;
      const deliveryId = g?.deliveryId ?? d?.deliveryId ?? undefined;
      const target = g?.targetKey ?? d?.target ?? (d?.issueId ? `issue:${d.issueId}` : d?.number ? `github:#${d.number}` : undefined);
      const outboxId = g?.id ?? g?.outboxId ?? undefined;
      await appendAudit(opts.inbound.db, {
        kind: "outbound_write_failed",
        outcome: "failed",
        source: queue.includes("plane") ? "plane" : "github",
        ...(deliveryId ? { deliveryId } : {}),
        ...(workspaceSlug ? { workspaceSlug } : {}),
        detail: {
          queue,
          jobId: job?.id ?? null,
          write: d?.kind ?? null,
          ...(outboxId ? { outboxId } : {}),
          ...(target ? { target } : {}),
          ...(deliveryId ? { deliveryId } : {}),
          ...(workspaceSlug ? { workspaceSlug } : {}),
        },
        error: err.message.slice(0, 500)
      });
    } catch (e) {
      console.error(`could not audit a failed ${queue} job: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  };
  const make = <T>(name: string, fn: (job: Job<T>, token?: string) => Promise<unknown>, extra: Record<string, unknown> = {}, outbound = false) => {
    const process = (job: Job<T>, token?: string) => processQueueJob(job, () => fn(job, token), { outbound, token, db: opts.inbound.db });
    const w = new Worker<T>(name, process, { ...base, concurrency: 1, ...extra });
    w.on("error", (err) => console.error(`worker ${name} error: ${err.message}`));
    w.on("failed", (job, err) => {
      if (err instanceof DelayedError || err.name === "DelayedError") return;
      console.error(`worker ${name} job ${job?.id ?? "?"} failed: ${err.message}`);
      const final = err instanceof UnrecoverableError || err.name === "UnrecoverableError" || (job ? job.attemptsMade >= (job.opts.attempts ?? 1) : true);
      if (outbound && final) {
        const d = job?.data as any;
        const alreadyAuditedByOutbox = Boolean(d?._gitsync) || err.name === "QueuedWriteFailedError" || (err instanceof Error && err.name === "QueuedWriteFailedError");
        if (!alreadyAuditedByOutbox) {
          void audit(name, job, err);
        }
      }
      if (!outbound && final && job?.data) {
        if (!(job.data as any)._auditedFinal) {
          (job.data as any)._auditedFinal = true;
          void auditDelivery(job.data as unknown as InboundJob, opts.inbound, "failed", err.message);
        }
      }
    });
    return w;
  };
  const outboundSettings = { settings: { backoffStrategy: (attemptsMade: number) => outboundBackoff(attemptsMade) } };
  const workers = [
    make<InboundJob>(QUEUE_NAMES.inboundPlane, (job) => processInbound(job.data, opts.inbound, { attemptsMade: job.attemptsMade, maxAttempts: job.opts.attempts ?? 10 })),
    make<InboundJob>(QUEUE_NAMES.inboundGithub, (job) => processInbound(job.data, opts.inbound, { attemptsMade: job.attemptsMade, maxAttempts: job.opts.attempts ?? 10 })),
    // Outbound Plane worker (F11: rate-limit HTTP calls via token bucket rather than starving BullMQ delayed jobs)
    make<PlaneWrite>(
      QUEUE_NAMES.outboundPlane,
      async (job) => {
        if (opts.ordered) return opts.ordered.executePlane(job as any);
        if ((job.data as any)?._gitsync) throw new UnrecoverableError("ordered outbox hook is required for _gitsync jobs");
        return opts.plane.apply(job.data);
      },
      outboundSettings,
      true
    ),
    make<GithubWrite>(
      QUEUE_NAMES.outboundGithub,
      async (job) => {
        if (opts.ordered) return opts.ordered.executeGithub(job as any);
        if ((job.data as any)?._gitsync) throw new UnrecoverableError("ordered outbox hook is required for _gitsync jobs");
        return opts.github.apply(job.data);
      },
      outboundSettings,
      true
    ),
  ];

  let recovering = false;
  let recoverTimer: NodeJS.Timeout | undefined;
  let closed = false;

  const runRecover = async () => {
    if (recovering || closed || !opts.ordered) return;
    recovering = true;
    try {
      await opts.ordered.recover();
    } catch (err) {
      console.error(`ordered recovery failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      recovering = false;
    }
  };

  if (opts.ordered) {
    void runRecover();
    recoverTimer = setInterval(() => { void runRecover(); }, 15_000);
    if (recoverTimer.unref) recoverTimer.unref();
  }

  return {
    close: async () => {
      closed = true;
      if (recoverTimer) clearInterval(recoverTimer);
      while (recovering) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await Promise.all(workers.map((w) => w.close()));
    },
  };
}
