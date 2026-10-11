// Durable FIFO per target. Redis jobs wake the executor; the database preserves intent and completion.
import { createHash, randomUUID } from "node:crypto";
import { resolvePlanValue } from "./plans.ts";
import { OperationError } from "./tooling.ts";
import type { OutboxPlanStep, OutboxPlanOptions, PlanMetadata, ReducerContinuation } from "./plans.ts";
import type { Queue } from "bullmq";
import type { SecretString } from "../auth/identity.ts";
import type { Db } from "../db/migrate.ts";
import { appendAudit, upsertSyncLink, upsertDevInfoLink, getDevInfoLink } from "../db/ledgers.ts";
import { normalizeValue } from "../sync/ophash.ts";
import { PlaneApiError } from "../sync/plane.ts";
import type { PlaneWrite, PlaneWritePath, PlaneWriteResult } from "../sync/plane.ts";
import type { GithubWrite, GithubWritePath } from "../sync/github.ts";
import { isPermanentWriteError, outboundBackoff } from "../queue/workers.ts";

type Side = "plane" | "github";
type IssueTarget = { slug: string; projectId: string; issueId: string };
export type IssueMutation = { kind: "add_label" | "remove_label" | "assign"; id: string }
  | { kind: "add_label" | "remove_label"; name: string };
type PlaneMutationWrite = IssueTarget & { kind: "mutate_issue"; mutation: IssueMutation };
type GithubAssigneeWrite = Omit<Extract<GithubWrite, { kind: "add_assignees" }>, "kind"> &
  { kind: "set_assignees"; workspaceSlug: string };
type RollupWrite = IssueTarget & { kind: "upsert_rollup"; key: string; url: string; title: string };
type ResumeWrite = { kind: "resume_reducer"; continuation: ReducerContinuation };
type Write = (ResumeWrite | RollupWrite | PlaneWrite | GithubWrite | PlaneMutationWrite | GithubAssigneeWrite) & { _plan?: PlanMetadata };
type Result = PlaneWriteResult | { ok: true; id?: number; number?: number };
type Enqueue = Pick<Queue, "add" | "getJob">;
export interface DeliveryContext { deliveryId: string; writeDeliveryId?: string; transportDeliveryId?: string; seq?: number; workspaceSlug?: string; occurrences?: Map<string, number>; operationId?: string }

export interface OutboxMeta {
  id: string;
  side: Side;
  targetKey: string;
  deliveryId?: string;
  workspaceSlug?: string;
  actorUserId?: string;
}
export type OutboxJob = { id?: string; data: Write & { _gitsync?: OutboxMeta } };

export interface OrderedOutboxDeps {
  db: Db;
  plane: Pick<PlaneWritePath, "apply" | "preflight">;
  github: Pick<GithubWritePath, "apply">;
  queues: { plane: Enqueue; github: Enqueue };
  loadActorToken(planeUserId: string): Promise<SecretString | null>;
  actorUserIdForToken?(token: SecretString): string | null | Promise<string | null>;
  readPlaneIssueFields?(target: IssueTarget): Promise<{ labels: string[]; assignees: string[] }>;
  listGithubAssignees?(target: GithubAssigneeWrite): Promise<string[]>;
  findPlaneLinkId?(target: IssueTarget, url: string): Promise<string | null>;
  resumeReducer?(continuation: ReducerContinuation): Promise<void>;
  scope?(): DeliveryContext | undefined;
  maxAttempts?: number;
  maxTargetBlockDurationMs?: number;
  now?(): number;
}

interface Row {
  id: string; sequence: string | number; side: Side; target_key: string; delivery_id: string | null;
  workspace_slug: string | null; actor_user_id: string | null; write: Write;
  status: "pending" | "applied" | "failed"; attempts: number;
  retry_at: string | Date | null; result: Result | null; error: { message: string; retryStartedAt?: number } | null;
}

export class QueuedWriteFailedError extends PlaneApiError {
  constructor(id: string, reason: string) {
    super(422, { jobId: id }, `outbound write ${id} failed: ${reason}`);
    this.name = "QueuedWriteFailedError";
  }
}
/** The worker should move this wake-up to delayed without spending its BullMQ failure budget. */
export class OrderedWriteDeferredError extends Error {
  retryAfterMs: number;
  constructor(ms: number) {
    super("an earlier outbound intent must finish first");
    this.name = "OrderedWriteDeferredError";
    this.retryAfterMs = Math.max(1, Math.ceil(ms));
  }
}

export function writeJobId(side: Side, write: unknown, deliveryId?: string, actorUserId?: string, ordinal: string | number = 0): string {
  const wire = JSON.parse(JSON.stringify(write));
  const identity = JSON.stringify([deliveryId ?? randomUUID(), side, actorUserId ?? null, normalizeValue(wire), ordinal]);
  return `write-${createHash("sha256").update(identity).digest("hex")}`;
}

/** Counts equal-content occurrences, rather than positions shared with different writes. */
export function nextWriteJobId(side: Side, write: unknown, scope?: DeliveryContext, actorUserId?: string): string {
  if (!scope) return writeJobId(side, write, undefined, actorUserId);
  const content = writeJobId(side, write, "content", actorUserId, scope.operationId ?? 0);
  const counts = scope.occurrences ??= new Map();
  const ordinal = counts.get(content) ?? 0;
  counts.set(content, ordinal + 1);
  return writeJobId(side, write, scope.deliveryId, actorUserId, scope.operationId ? `${scope.operationId}:${ordinal}` : ordinal);
}

function targetKey(side: Side, write: Write, id?: string): string {
  if (write.kind === "resume_reducer") return JSON.stringify([side, "continuation", write.continuation.mappingId, write.continuation.job.deliveryId]);
  if (side === "plane") {
    const w = write as PlaneWrite | PlaneMutationWrite;
    return JSON.stringify([side, w.slug, w.projectId,
      "issueId" in w ? ["issue", w.issueId] : w.kind === "upsert_label" ? "labels" : ["create", id]]);
  }
  const w = write as GithubWrite;
  return JSON.stringify([side, w.repoId, "number" in w ? ["issue", w.number] : ["create", id]]);
}

function resultOf(row: Pick<Row, "id" | "status" | "result" | "error">): Result | undefined {
  if (row.status === "failed") throw new QueuedWriteFailedError(row.id, row.error?.message ?? "worker failed");
  if (row.status === "applied") {
    if (!row.result || row.result.ok !== true) throw new Error(`outbound write ${row.id} has no valid completion result`);
    return row.result;
  }
  return undefined;
}

function jobData(row: Row): OutboxJob["data"] {
  return { ...row.write, _gitsync: { id: row.id, side: row.side, targetKey: row.target_key,
    ...(row.delivery_id ? { deliveryId: row.delivery_id } : {}),
    ...(row.workspace_slug ? { workspaceSlug: row.workspace_slug } : {}),
    ...(row.actor_user_id ? { actorUserId: row.actor_user_id } : {}) } };
}

const held = new WeakMap<Db, Set<string>>();

export function makeOrderedOutbox(deps: OrderedOutboxDeps) {
  const now = deps.now ?? Date.now;
  const maxAttempts = deps.maxAttempts ?? 30;
  const maxBlockMs = deps.maxTargetBlockDurationMs ?? 6 * 60 * 60_000;
  if (!Number.isFinite(maxBlockMs) || maxBlockMs <= 0) throw new Error("outbox maximum target blocking duration must be positive");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("outbox maxAttempts must be a positive integer");
  const find = async (id: string, db: Db = deps.db): Promise<Row> => {
    const r = await db.query<Row>("SELECT * FROM outbound_writes WHERE id = $1", [id]);
    if (!r.rows[0]) throw new Error(`outbound intent ${id} does not exist`);
    return r.rows[0];
  };

  const completion = async (id: string, db: Db = deps.db) => {
    const row = (await db.query<Pick<Row, "id" | "status" | "result" | "error">>(
      "SELECT id, status, result, error FROM outbound_writes WHERE id = $1", [id])).rows[0];
    if (!row) throw new Error(`outbound intent ${id} does not exist`);
    return row;
  };

  const wake = async (row: Row): Promise<void> => {
    if (row.status !== "pending") return;
    if ((await deps.db.query("SELECT 1 FROM outbound_writes WHERE target_key = $1 AND status = 'pending' AND sequence < $2 LIMIT 1", [row.target_key, row.sequence])).rows.length) return;
    const predecessor = row.write._plan?.predecessor;
    if (predecessor && (await completion(predecessor)).status === "pending") return;
    const queue = deps.queues[row.side];
    const existing = await queue.getJob(row.id);
    if (existing) {
      const state = await existing.getState();
      if (state === "failed") { await existing.retry(); return; }
      // Older workers may have parked a non-head as completed. Wake it once it becomes eligible.
      if (state !== "completed") return;
      await existing.remove();
    }
    await queue.add("write", jobData(row), { jobId: row.id });
  };
  const wakeFollowing = async (row: Pick<Row, "id" | "target_key">): Promise<void> => {
    const candidates = (await deps.db.query<{ id: string }>(`SELECT id FROM outbound_writes WHERE status = 'pending'
      AND (target_key = $1 OR write->'_plan'->>'predecessor' = $2) ORDER BY sequence LIMIT 100`, [row.target_key, row.id])).rows;
    for (const candidate of candidates) await wake(await find(candidate.id)).catch(() => {});
  };

  const isReplay = (scope: DeliveryContext | undefined) => Boolean(scope?.writeDeliveryId && scope.transportDeliveryId
    && scope.writeDeliveryId !== scope.transportDeliveryId);

  /** An explicit retry preserves completed steps and API checkpoints, restarting only failed work. */
  const resetFailed = async (conn: Db, row: Row): Promise<boolean> => {
    const root = row.write._plan?.root;
    if (!(await conn.query("SELECT 1 FROM outbound_writes WHERE status = 'failed' AND (id = $1 OR write->'_plan'->>'root' = $2) LIMIT 1", [row.id, root ?? null])).rows.length) return false;
    let marker: PlanMetadata["marker"];
    if (root) {
      const first = await find(root, conn);
      marker = first.write._plan?.marker;
      // Existing round-3 plans predate the marker metadata; recover their serialized link/key.
      if (!marker) {
        const actions = (await conn.query<{ step: any }>(`SELECT step FROM outbound_writes w,
          LATERAL jsonb_array_elements(COALESCE(w.write->'_plan'->'after', '[]'::jsonb)) step
          WHERE w.write->'_plan'->>'root' = $1 AND step->>'kind' IN ('sync_link','clear_pending_link')
          ORDER BY w.sequence LIMIT 2`, [root])).rows.map((r) => r.step);
        const key = actions.find((a) => a.kind === "clear_pending_link")?.key;
        const link = actions.find((a) => a.kind === "sync_link")?.link;
        if (key && link) marker = { key, root, link };
      }
      if (deps.db.withConnection) for (const target of [...new Set([first.target_key,
        ...(marker ? [JSON.stringify([first.side, "create", marker.key])] : [])])].sort())
        await conn.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`gitsync:outbound-register:${target}`]);
      if (marker) {
        const live = (await conn.query<{ outbox_id: string }>("SELECT outbox_id FROM pending_sync_links WHERE key = $1", [marker.key])).rows[0];
        if (live && live.outbox_id !== root) throw new PlaneApiError(409, {}, "a newer create workflow already owns this object");
        // A later generation may already have installed its partner and removed its marker.
        const failedCreate = (await conn.query("SELECT 1 FROM outbound_writes WHERE write->'_plan'->>'root' = $1 AND status = 'failed' AND write->>'kind' = 'create_issue' AND result IS NULL LIMIT 1", [root])).rows.length;
        const link = marker.link;
        if (failedCreate && typeof link.planeWorkspaceSlug === "string" && typeof link.planeProjectId === "string"
          && (typeof link.ghNumber === "number" || typeof link.planeIssueId === "string")) {
          const active = await conn.query(`SELECT 1 FROM sync_links WHERE status = 'active' AND plane_workspace_slug = $1
            AND plane_project_id = $2 AND gh_repo_id = $3 AND gh_kind = $4
            AND (($5::int IS NOT NULL AND gh_number = $5) OR ($6::text IS NOT NULL AND plane_issue_id = $6)) LIMIT 1`,
          [link.planeWorkspaceSlug, link.planeProjectId, link.ghRepoId, link.ghKind ?? "issue",
            typeof link.ghNumber === "number" ? link.ghNumber : null, typeof link.planeIssueId === "string" ? link.planeIssueId : null]);
          if (active.rows.length) throw new PlaneApiError(409, {}, "this object already has an active partner");
        }
      }
    }
    await conn.query(`UPDATE outbound_writes SET status = 'pending', attempts = 0,
      error = NULL, retry_at = NULL, updated_at = now()
      WHERE status = 'failed' AND (id = $1 OR ($2::text IS NOT NULL AND write->'_plan'->>'root' = $2))`, [row.id, root ?? null]);
    if (marker) await conn.query(`INSERT INTO pending_sync_links (key,outbox_id,link) VALUES ($1,$2,$3::jsonb)
      ON CONFLICT (key) DO NOTHING`, [marker.key, root, JSON.stringify(marker.link)]);
    return true;
  };

  const enqueue = async (side: Side, write: Write, actorToken?: SecretString): Promise<Result> => {
    // Persist the same immutable content used by the identity, even if a caller later mutates its object.
    write = JSON.parse(JSON.stringify(write)) as Write;
    let actorUserId: string | undefined;
    if (actorToken) {
      const id = deps.actorUserIdForToken ? await deps.actorUserIdForToken(actorToken)
        : actorToken.planeUserId;
      if (typeof id !== "string" || !id.trim()) throw new PlaneApiError(422, {}, "actor token has no owning Plane user ID");
      actorUserId = id;
    }
    const scope = deps.scope?.();
    const id = nextWriteJobId(side, write, scope, actorUserId);
    const workspaceSlug = side === "plane" ? (write as PlaneWrite).slug
      : write.kind === "set_assignees" ? write.workspaceSlug : scope?.workspaceSlug;
    // Reserve ordering before any remote guard/read. The real Plane write path still validates states
    // immediately before recording echo ops and applying the API write, including on every retry.
    const target = targetKey(side, write, id);
    const insert = async (db: Db) => {
      await db.query(`INSERT INTO outbound_writes
      (id, side, target_key, delivery_id, workspace_slug, actor_user_id, write)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (id) DO NOTHING`,
    [id, side, target, scope?.deliveryId ?? null, workspaceSlug ?? null, actorUserId ?? null, JSON.stringify(write)]);
      if (isReplay(scope)) await resetFailed(db, await find(id, db));
    };
    if (deps.db.withConnection) {
      // Serialize registration commits, separately from execution. Otherwise an uncommitted lower
      // sequence can be invisible while another replica commits and executes a higher sequence.
      await deps.db.withConnection(async (conn) => {
        await conn.exec("BEGIN");
        try {
          if (isReplay(scope)) await conn.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`gitsync:outbound:${target}`]);
          await conn.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`gitsync:outbound-register:${target}`]);
          await insert(conn);
          await conn.exec("COMMIT");
        } catch (err) { await conn.exec("ROLLBACK").catch(() => {}); throw err; }
      });
    } else await insert(deps.db);
    const row = await find(id);
    if (row.status !== "pending") return { ok: true };
    // A committed intent is accepted even when Redis is unavailable; periodic recovery restores its wake-up.
    await wake(row).catch(() => {});
    // Acknowledges durable intent, not API completion. Outages belong to the outbound worker.
    return { ok: true };
  };

  const plan = async (key: string | undefined, steps: OutboxPlanStep[], opts: OutboxPlanOptions = {}): Promise<{ ok: true; inserted: boolean }> => {
    if (!steps.length || steps.length > 256 || steps[0]?.kind !== "write") throw new Error("outbox plans need 1–256 steps, starting with a write");
    // Copy before registration so templates cannot change after IDs have been chosen.
    steps = JSON.parse(JSON.stringify(steps));
    const scope = deps.scope?.();
    const actorUserId = opts.actorToken ? (deps.actorUserIdForToken ? await deps.actorUserIdForToken(opts.actorToken) : opts.actorToken.planeUserId) : undefined;
    if (opts.actorToken && !actorUserId) throw new PlaneApiError(422, {}, "actor token has no owning Plane user ID");
    const first = steps[0] as Extract<OutboxPlanStep, { kind: "write" }>;
    const group = opts.groupRoot ? await find(opts.groupRoot) : undefined;
    if (group && group.side !== first.side) throw new Error("pending mirror events must use their create's destination queue");
    const planWorkspace = group?.workspace_slug ?? opts.target?.slug ?? (typeof opts.pendingLink?.planeWorkspaceSlug === "string" ? opts.pendingLink.planeWorkspaceSlug : undefined)
      ?? (first.side === "plane" ? (first.write as PlaneWrite).slug : scope?.workspaceSlug);
    const root = key ? `plan-${createHash("sha256").update(key).digest("hex")}`
      : nextWriteJobId(first.side, { steps, target: opts.target, bindings: opts.bindings, predecessor: opts.predecessor }, scope, actorUserId ?? undefined);
    const bindings: Record<string, string> = { ...opts.bindings };
    const intents: { id: string; side: Side; write: Write; target: string; workspace: string | null }[] = [];
    for (const step of steps) {
      if (step.kind !== "write") {
        intents.at(-1)!.write._plan!.after.push(step);
        continue;
      }
      const id = intents.length ? `${root}-${intents.length}` : root;
      const predecessor = intents.at(-1)?.id ?? opts.predecessor;
      const metadata: PlanMetadata = { root: opts.groupRoot ?? root, bindings: { ...bindings }, after: [], ...(predecessor ? { predecessor } : {}), ...(step.bind ? { bind: step.bind } : {}) };
      const write = { ...step.write, _plan: metadata } as Write;
      const target = group ? group.target_key : opts.target && step.side === "plane" ? targetKey("plane", { ...opts.target, kind: "update_issue", fields: {} })
        : key && opts.pendingLink && step.side === first.side ? JSON.stringify([step.side, "create", key]) : targetKey(step.side, write, id);
      const workspace = step.side === "plane" ? (write as PlaneWrite).slug : scope?.workspaceSlug;
      intents.push({ id, side: step.side, write, target, workspace: workspace ?? planWorkspace ?? null });
      if (step.bind) {
        if (bindings[step.bind]) throw new Error(`duplicate outbox result binding ${step.bind}`);
        bindings[step.bind] = id;
      }
    }
    const marker = opts.pendingMarker ?? (key && opts.pendingLink ? { key, root, link: opts.pendingLink } : undefined);
    if (marker) {
      intents.at(-1)!.write._plan!.after.push({ kind: "clear_pending_link", key: marker.key });
      if (!group) intents[0]!.write._plan!.marker = marker;
    }
    let didInsert = false;
    const register = async (conn: Db) => {
      await conn.exec("BEGIN");
      try {
        if (deps.db.withConnection) for (const target of [...new Set([...intents.map((i) => i.target),
          ...(marker ? [JSON.stringify([first.side, "create", marker.key])] : [])])].sort())
          await conn.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`gitsync:outbound-register:${target}`]);
        if (group && (await conn.query("SELECT 1 FROM outbound_writes WHERE write->'_plan'->>'root' = $1 AND status = 'failed' LIMIT 1", [group.id])).rows.length) {
          await conn.exec("COMMIT");
          return;
        }
        if (marker) {
          const existingMarker = (await conn.query<{ outbox_id: string; failed: boolean }>(`SELECT p.outbox_id,
            EXISTS (SELECT 1 FROM outbound_writes w WHERE w.write->'_plan'->>'root' = p.outbox_id AND w.status = 'failed') AS failed
            FROM pending_sync_links p WHERE p.key = $1`, [marker.key])).rows[0];
          if (existingMarker?.failed) await conn.query("DELETE FROM pending_sync_links WHERE key = $1 AND outbox_id = $2", [marker.key, existingMarker.outbox_id]);
          else if (existingMarker && existingMarker.outbox_id !== marker.root) {
            await conn.exec("COMMIT");
            return;
          }
        }
        // The root's first registration fixes the whole plan, even if a later delivery has a changed title.
        const inserted = await conn.query(`INSERT INTO outbound_writes (id, side, target_key, delivery_id, workspace_slug, actor_user_id, write)
          VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (id) DO NOTHING RETURNING id`,
          [root, first.side, intents[0]!.target, scope?.deliveryId ?? null, intents[0]!.workspace, first.side === "plane" ? actorUserId ?? null : null, JSON.stringify(intents[0]!.write)]);
        didInsert = inserted.rows.length > 0;
        if (didInsert) {
          for (const intent of intents.slice(1)) await conn.query(`INSERT INTO outbound_writes (id, side, target_key, delivery_id, workspace_slug, actor_user_id, write)
            VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`, [intent.id, intent.side, intent.target, scope?.deliveryId ?? null,
            intent.workspace, intent.side === "plane" ? actorUserId ?? null : null, JSON.stringify(intent.write)]);
          // Re-establish the barrier if the previous head completed after this event read its marker.
          if (marker) await conn.query(`INSERT INTO pending_sync_links (key, outbox_id, link) VALUES ($1,$2,$3::jsonb)
            ON CONFLICT (key) DO NOTHING`, [marker.key, marker.root, JSON.stringify(marker.link)]);
        } else if (isReplay(scope)) await resetFailed(conn, await find(root, conn));
        await conn.exec("COMMIT");
      } catch (err) { await conn.exec("ROLLBACK").catch(() => {}); throw err; }
    };
    if (deps.db.withConnection) await deps.db.withConnection(register); else await register(deps.db);
    // Redis is only a wake-up channel. Recovery can restore every committed row independently.
    const registered = (await deps.db.query<{ id: string }>("SELECT id FROM outbound_writes WHERE id = $1 OR id LIKE $2 ORDER BY sequence", [root, `${root}-%`])).rows;
    for (const intent of registered) {
      const row = await find(intent.id);
      await wake(row).catch(() => {});
    }
    return { ok: true, inserted: didInsert };
  };

  const retryFailed = async (id: string, workspaceSlug: string): Promise<{ ok: true; retried: boolean }> => {
    const row = (await deps.db.query<Row>("SELECT * FROM outbound_writes WHERE id = $1 AND workspace_slug = $2", [id, workspaceSlug])).rows[0];
    if (!workspaceSlug || !row) throw new OperationError(404, "outbound write not found in this workspace");
    let retried = false;
    const reset = async (conn: Db) => {
      await conn.exec("BEGIN");
      try {
        if (deps.db.withConnection) await conn.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`gitsync:outbound:${row.target_key}`]);
        retried = await resetFailed(conn, await find(id, conn));
        if (retried) await appendAudit(conn, { kind: "outbound_write_retry", source: row.side, workspaceSlug,
          ...(row.delivery_id ? { deliveryId: row.delivery_id } : {}), outcome: "queued", detail: { outboxId: id } });
        await conn.exec("COMMIT");
      } catch (err) { await conn.exec("ROLLBACK").catch(() => {}); throw err; }
    };
    try {
      if (deps.db.withConnection) await deps.db.withConnection(reset); else await reset(deps.db);
    } catch (err) {
      if (err instanceof PlaneApiError && (err.status === 404 || err.status === 409)) throw new OperationError(err.status, err.message);
      throw err;
    }
    if (retried) {
      const root = row.write._plan?.root;
      const pending = (await deps.db.query<{ id: string }>("SELECT id FROM outbound_writes WHERE status = 'pending' AND (id = $1 OR write->'_plan'->>'root' = $2) ORDER BY sequence LIMIT 100", [id, root ?? null])).rows;
      for (const intent of pending) await wake(await find(intent.id)).catch(() => {});
    }
    return { ok: true, retried };
  };

  const failIntent = async (conn: Db, head: Row, id: string, err: unknown, actor?: SecretString): Promise<never> => {
    const attempts = head.attempts + 1;
    const retryStartedAt = head.error?.retryStartedAt ?? now();
    const expiresAt = retryStartedAt + maxBlockMs;
    const terminal = isPermanentWriteError(err, attempts - 1) || attempts >= maxAttempts || now() >= expiresAt;
    const retryAfter = Math.max(1, Math.min(outboundBackoff(attempts), expiresAt - now()));
    let message = err instanceof Error ? err.message : "outbound write failed";
    if (actor) message = message.replaceAll(actor.reveal(), "[redacted]");
    message = message.slice(0, 500);
    // Dedicated production connections keep the terminal record and audit atomic. A shared
    // single-connection test engine cannot open overlapping transactions for different targets.
    const transactional = Boolean(deps.db.withConnection);
    if (transactional) await conn.exec("BEGIN");
    try {
      await conn.query(`UPDATE outbound_writes SET attempts = $2, status = $3,
        retry_at = $4, error = $5::jsonb, updated_at = now() WHERE id = $1`,
      [head.id, attempts, terminal ? "failed" : "pending",
        terminal ? null : new Date(now() + retryAfter), JSON.stringify({ message, retryStartedAt })]);
      if (terminal && head.write._plan) {
        const root = head.write._plan.root;
        if (deps.db.withConnection) {
          const rootTarget = (await conn.query<{ target_key: string }>("SELECT target_key FROM outbound_writes WHERE id = $1", [root])).rows[0]?.target_key;
          if (rootTarget) await conn.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`gitsync:outbound-register:${rootTarget}`]);
        }
        await conn.query(`UPDATE outbound_writes SET status = 'failed', retry_at = NULL, error = $2::jsonb, updated_at = now()
          WHERE status = 'pending' AND write->'_plan'->>'root' = $1`, [root, JSON.stringify({ message: `plan failed at ${head.id}: ${message}` })]);
        const markers = await conn.query<{ key: string }>("DELETE FROM pending_sync_links WHERE outbox_id = $1 RETURNING key", [root]);
        if (markers.rows.length && !(await conn.query("SELECT 1 FROM audit_log WHERE kind = 'mirror_create_failed' AND detail->>'root' = $1", [root])).rows.length)
          await appendAudit(conn, { kind: "mirror_create_failed", source: head.side,
            ...(head.delivery_id ? { deliveryId: head.delivery_id } : {}),
            ...(head.workspace_slug ? { workspaceSlug: head.workspace_slug } : {}), outcome: "failed", error: message,
            detail: { root, outboxId: head.id, markerKey: markers.rows[0]!.key } });
      }
      if (terminal) await appendAudit(conn, { kind: "outbound_write_failed", source: head.side,
        ...(head.delivery_id ? { deliveryId: head.delivery_id } : {}),
        ...(head.workspace_slug ? { workspaceSlug: head.workspace_slug } : {}), outcome: "failed", error: message,
        detail: { outboxId: head.id, target: head.target_key, actorUserId: head.actor_user_id, write: head.write } });
      if (transactional) await conn.exec("COMMIT");
    } catch (err) { if (transactional) await conn.exec("ROLLBACK").catch(() => {}); throw err; }
    if (terminal) {
      await wakeFollowing(head);
      if (head.write._plan) {
        const siblings = (await conn.query<Pick<Row, "id" | "target_key">>("SELECT id, target_key FROM outbound_writes WHERE write->'_plan'->>'root' = $1 AND status = 'failed' ORDER BY sequence LIMIT 100", [head.write._plan.root])).rows;
        for (const sibling of siblings) await wakeFollowing(sibling);
      }
      if (head.id === id) throw new QueuedWriteFailedError(id, message);
    }
    throw new OrderedWriteDeferredError(terminal ? 1 : retryAfter);
  };

  const execute = async (side: Side, job: OutboxJob): Promise<Result> => {
    const id = job.data._gitsync?.id;
    if (!id || (job.id && job.id !== id)) throw new QueuedWriteFailedError(job.id ?? "unknown", "ordered job has no matching intent ID");
    const requested = await find(id);
    if (requested.side !== side) throw new QueuedWriteFailedError(id, "ordered job belongs to the other destination");
    const finished = resultOf(requested);
    if (finished) return finished;
    let local = held.get(deps.db);
    if (!local) held.set(deps.db, (local = new Set()));
    if (local.has(requested.target_key)) throw new OrderedWriteDeferredError(100);
    local.add(requested.target_key);
    const run = async (conn: Db): Promise<Result> => {
      let locked = false;
      if (deps.db.withConnection) {
        const r = await conn.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok",
          [`gitsync:outbound:${requested.target_key}`]);
        if (!r.rows[0]?.ok) throw new OrderedWriteDeferredError(100);
        locked = true;
      }
      try {
        const finished = resultOf(await completion(id, conn));
        if (finished) return finished;
        const head = (await conn.query<Row>(`SELECT * FROM outbound_writes
          WHERE target_key = $1 AND status = 'pending' ORDER BY sequence LIMIT 1`, [requested.target_key])).rows[0];
        if (!head) throw new Error(`outbound intent ${id} has no pending target head`);
        if (head.error?.retryStartedAt !== undefined && now() >= head.error.retryStartedAt + maxBlockMs)
          return failIntent(conn, head, id, new PlaneApiError(422, {}, "outbound target retry window expired"));
        const due = head.retry_at ? new Date(head.retry_at).getTime() : 0;
        if (due > now()) throw new OrderedWriteDeferredError(due - now());
        let actor: SecretString | undefined;
        let result: Result;
        try {
          const plan = head.write._plan;
          const results: Record<string, unknown> = {};
          if (plan?.predecessor && !resultOf(await completion(plan.predecessor, conn))) throw new OrderedWriteDeferredError(1000);
          if (plan) for (const [name, dependencyId] of Object.entries(plan.bindings)) {
            const dependency = await completion(dependencyId, conn);
            const value = resultOf(dependency);
            if (!value) throw new OrderedWriteDeferredError(1000);
            results[name] = value;
          }
          const { _plan: _metadata, ...template } = head.write;
          const actualWrite = resolvePlanValue(template, results) as Write;
          let tokenSnapshot: string | undefined;
          if (head.actor_user_id && !head.result) {
            const rejected = (await conn.query("SELECT 1 FROM audit_log WHERE kind = 'identity_fallback' AND detail->>'outboxId' = $1 AND detail->>'reason' = 'token_rejected'", [head.id])).rows.length > 0;
            if (!rejected) {
              tokenSnapshot = (await conn.query<{ ciphertext: string }>("SELECT ciphertext FROM user_tokens WHERE plane_user_id = $1 AND kind = 'plane_pat'", [head.actor_user_id])).rows[0]?.ciphertext;
              actor = await deps.loadActorToken(head.actor_user_id) ?? undefined;
            }
            if (!actor && !(await conn.query("SELECT 1 FROM audit_log WHERE kind = 'identity_fallback' AND detail->>'outboxId' = $1", [head.id])).rows.length) {
              await appendAudit(conn, { kind: "identity_fallback", source: head.side,
                ...(head.delivery_id ? { deliveryId: head.delivery_id } : {}),
                ...(head.workspace_slug ? { workspaceSlug: head.workspace_slug } : {}), outcome: "service_fallback",
                detail: { outboxId: head.id, actorUserId: head.actor_user_id, reason: "token_revoked", identity: "service" } });
            }
          }
          const applyPlane = async (write: PlaneWrite): Promise<PlaneWriteResult> => {
            // The immutable intent ID lets the Plane create path recover ambiguous POST outcomes.
            const options = { intentId: head.id, ...(actor ? { actorToken: actor } : {}) };
            try { return await deps.plane.apply(write, options); }
            catch (err) {
              const e = err as { status?: number; response?: { status?: number; headers?: Record<string, unknown> } } | null;
              const status = e?.status ?? e?.response?.status;
              const headers = e?.response?.headers ?? {};
              const rateLimited = headers["retry-after"] !== undefined || String(headers["x-ratelimit-remaining"]) === "0";
              if (!actor || !(status === 401 || (status === 403 && !rateLimited))) throw err;
              const transactional = Boolean(deps.db.withConnection);
              if (transactional) await conn.exec("BEGIN");
              try {
                // Compare the ciphertext snapshot so an independently rotated PAT is not deleted.
                if (tokenSnapshot) await conn.query("DELETE FROM user_tokens WHERE plane_user_id = $1 AND kind = 'plane_pat' AND ciphertext = $2", [head.actor_user_id, tokenSnapshot]);
                if (!(await conn.query("SELECT 1 FROM audit_log WHERE kind = 'identity_fallback' AND detail->>'outboxId' = $1 AND detail->>'reason' = 'token_rejected'", [head.id])).rows.length)
                  await appendAudit(conn, { kind: "identity_fallback", source: head.side,
                    ...(head.delivery_id ? { deliveryId: head.delivery_id } : {}),
                    ...(head.workspace_slug ? { workspaceSlug: head.workspace_slug } : {}), outcome: "service_fallback",
                    detail: { outboxId: head.id, actorUserId: head.actor_user_id, reason: "token_rejected", identity: "service" } });
                if (transactional) await conn.exec("COMMIT");
              } catch (dbError) { if (transactional) await conn.exec("ROLLBACK").catch(() => {}); throw dbError; }
              actor = undefined;
              return deps.plane.apply(write, { intentId: head.id });
            }
          };
          if (head.result?.ok === true) result = head.result;
          else if (actualWrite.kind === "resume_reducer") {
            if (!deps.resumeReducer) throw new PlaneApiError(503, {}, "outbox reducer continuation handler is required");
            await deps.resumeReducer({ ...actualWrite.continuation, ...(head.workspace_slug ? { workspaceSlug: head.workspace_slug } : {}) });
            result = { ok: true };
          } else if (actualWrite.kind === "upsert_rollup") {
            const w = actualWrite;
            const stored = await getDevInfoLink(conn, w.issueId, w.key);
            const add = async (): Promise<PlaneWriteResult> => {
              const created = await applyPlane({ kind: "add_link", slug: w.slug, projectId: w.projectId, issueId: w.issueId, url: w.url, title: w.title });
              if (created.id) return created;
              const found = await deps.findPlaneLinkId?.(w, w.url);
              if (!found) throw new PlaneApiError(503, {}, "cannot recover the existing rollup link ID");
              await applyPlane({ kind: "update_link", slug: w.slug, projectId: w.projectId, issueId: w.issueId, linkId: found, url: w.url, title: w.title });
              return { ok: true, id: found };
            };
            if (!stored) result = await add();
            else try {
              await applyPlane({ kind: "update_link", slug: w.slug, projectId: w.projectId, issueId: w.issueId, linkId: stored, url: w.url, title: w.title });
              result = { ok: true, id: stored };
            } catch (err) { if (!(err instanceof PlaneApiError) || err.status !== 404) throw err; result = await add(); }
          } else if (actualWrite.kind === "mutate_issue") {
            const w = actualWrite;
            if (!deps.readPlaneIssueFields) throw new PlaneApiError(503, {}, "ordered Plane mutations need a current-field reader");
            const current = await deps.readPlaneIssueFields(w);
            if (!("id" in w.mutation)) throw new Error("outbox label mutation has no resolved ID");
            const mutation = w.mutation;
            const field = mutation.kind === "assign" ? "assignees" : "labels";
            const previous = current[field];
            const wanted = mutation.kind === "remove_label" ? previous.filter((id) => id !== mutation.id)
              : [...new Set([...previous, mutation.id])];
            result = normalizeValue(previous) === normalizeValue(wanted) ? { ok: true, id: w.issueId }
              : await applyPlane({ kind: "update_issue", slug: w.slug, projectId: w.projectId,
                issueId: w.issueId, fields: { [field]: wanted } });
          } else if (actualWrite.kind === "set_assignees") {
            const w = actualWrite;
            if (!deps.listGithubAssignees) throw new PlaneApiError(503, {}, "ordered GitHub assignee sync needs a current-assignee reader");
            const current = await deps.listGithubAssignees(w);
            const mapped = new Set((await conn.query<{ gh_login: string }>(
              "SELECT gh_login FROM user_map WHERE workspace_slug = $1", [w.workspaceSlug])).rows.map((r) => r.gh_login.toLowerCase()));
            const wanted = new Set(w.assignees.map((login) => login.toLowerCase()));
            const have = new Set(current.map((login) => login.toLowerCase()));
            const remove = current.filter((login) => mapped.has(login.toLowerCase()) && !wanted.has(login.toLowerCase()));
            const add = w.assignees.filter((login) => mapped.has(login.toLowerCase()) && !have.has(login.toLowerCase()));
            const target = { installationId: w.installationId, owner: w.owner, repo: w.repo, repoId: w.repoId, number: w.number };
            if (remove.length) await deps.github.apply({ ...target, kind: "remove_assignees", assignees: remove });
            if (add.length) await deps.github.apply({ ...target, kind: "add_assignees", assignees: add });
            result = { ok: true };
          } else result = head.side === "plane" ? await applyPlane(actualWrite as PlaneWrite)
            : await deps.github.apply(actualWrite as GithubWrite);
          if (!result || result.ok !== true) throw new Error("outbound executor returned no successful result");
        } catch (err) {
          if (err instanceof OrderedWriteDeferredError) throw err;
          return failIntent(conn, head, id, err, actor);
        }
        // Save the API result before database follow-ups. Retrying a failed link/audit transaction
        // reuses this result instead of creating the item again.
        if (!head.result) await conn.query("UPDATE outbound_writes SET result = $2::jsonb WHERE id = $1", [head.id, JSON.stringify(result)]);
        const transactional = Boolean(deps.db.withConnection);
        if (transactional) await conn.exec("BEGIN");
        try {
          if (head.write.kind === "upsert_rollup" && typeof result.id === "string")
            await upsertDevInfoLink(conn, { planeIssueId: head.write.issueId, key: head.write.key, planeLinkId: result.id });
          const plan = head.write._plan;
          if (plan) {
            const results: Record<string, unknown> = { current: result, ...(plan.bind ? { [plan.bind]: result } : {}) };
            for (const [name, dependencyId] of Object.entries(plan.bindings)) results[name] = resultOf(await completion(dependencyId, conn));
            for (const step of plan.after) {
              const action = resolvePlanValue(step, results);
              if (action.kind === "sync_link") {
                await upsertSyncLink(conn, action.link);
              } else if (action.kind === "clear_pending_link") {
                // Registration uses the same lock, so a committed later event keeps the barrier alive.
                if (deps.db.withConnection) {
                  const rootTarget = (await conn.query<{ target_key: string }>("SELECT target_key FROM outbound_writes WHERE id = $1", [plan.root])).rows[0]?.target_key;
                  if (!rootTarget) throw new Error("pending mirror group root is missing");
                  await conn.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`gitsync:outbound-register:${rootTarget}`]);
                }
                await conn.query(`DELETE FROM pending_sync_links WHERE key = $1 AND NOT EXISTS (
                  SELECT 1 FROM outbound_writes sibling WHERE sibling.status = 'pending' AND sibling.id <> $2
                    AND sibling.write->'_plan'->>'root' = $3)`, [action.key, head.id, plan.root]);
              } else if (action.kind === "audit") await appendAudit(conn, action.entry);
              else await upsertDevInfoLink(conn, { planeIssueId: action.issueId, key: action.key, planeLinkId: action.linkId });
            }
          }
          await conn.query(`UPDATE outbound_writes SET status = 'applied', result = $2::jsonb,
            retry_at = NULL, error = NULL, updated_at = now() WHERE id = $1`, [head.id, JSON.stringify(result)]);
          if (transactional) await conn.exec("COMMIT");
        } catch (err) {
          if (transactional) await conn.exec("ROLLBACK").catch(() => {});
          return failIntent(conn, head, id, err, actor);
        }
        await wakeFollowing(head);
        // One intent per invocation; real HTTP request budgeting lives in the write-path client.
        // Compound GitHub reconciliation retains the same target lock across its additive endpoints.
        if (head.id !== id) throw new OrderedWriteDeferredError(1);
        return result;
      } finally {
        if (locked) await conn.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`gitsync:outbound:${requested.target_key}`]);
      }
    };
    try {
      const outcome = deps.db.withConnection ? await deps.db.withConnection(async (conn) => {
        try { return await run(conn); }
        catch (err) {
          // A normal scheduling wait leaves no transaction/lock open. Return it until the pool
          // releases the healthy connection, rather than destroying a connection on every wait.
          if (err instanceof OrderedWriteDeferredError) return err;
          throw err;
        }
      }) : await run(deps.db);
      if (outcome instanceof OrderedWriteDeferredError) throw outcome;
      return outcome;
    }
    finally { local.delete(requested.target_key); }
  };

  let recoveryCursor = "0";
  const recover = async (): Promise<void> => {
    // Bound live payload memory too: do not fetch 100 large descriptions/comments in one result.
    const rows = (await deps.db.query<Pick<Row, "id" | "sequence" | "side">>(`SELECT id, sequence, side FROM outbound_writes WHERE status = 'pending'
      AND sequence > $1 ORDER BY sequence LIMIT 100`, [recoveryCursor])).rows;
    recoveryCursor = rows.length === 100 ? String(rows.at(-1)!.sequence) : "0";
    for (const row of rows) await wake(await find(row.id));
  };

  return {
    plane: {
      plan,
      upsertRollup: (target: IssueTarget, key: string, link: { url: string; title: string }) =>
        enqueue("plane", { ...target, ...link, kind: "upsert_rollup", key }) as Promise<PlaneWriteResult>,
      apply: (write: PlaneWrite, opts: { actorToken?: SecretString } = {}) =>
        enqueue("plane", write, opts.actorToken) as Promise<PlaneWriteResult>,
      mutateIssue: (target: IssueTarget, mutation: IssueMutation, opts: { actorToken?: SecretString } = {}) =>
        "name" in mutation ? plan(undefined, [
          { kind: "write", side: "plane", write: { kind: "upsert_label", slug: target.slug, projectId: target.projectId, name: mutation.name }, bind: "label" },
          { kind: "write", side: "plane", write: { ...target, kind: "mutate_issue", mutation: { kind: mutation.kind, id: { $result: "label.id" } } } },
        ], { ...opts, target }) : enqueue("plane", { ...target, kind: "mutate_issue", mutation }, opts.actorToken) as Promise<PlaneWriteResult>,
    },
    github: {
      plan,
      apply: (write: GithubWrite) => enqueue("github", write) as Promise<{ ok: true; id?: number; number?: number }>,
      setAssignees: (write: Extract<GithubWrite, { kind: "add_assignees" }>, workspaceSlug: string) =>
        enqueue("github", { ...write, kind: "set_assignees", workspaceSlug }) as Promise<{ ok: true }>,
    },
    executePlane: (job: OutboxJob) => execute("plane", job),
    executeGithub: (job: OutboxJob) => execute("github", job),
    recover,
    retryFailed,
  };
}

export type OrderedOutbox = ReturnType<typeof makeOrderedOutbox>;
