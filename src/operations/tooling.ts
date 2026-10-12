// Operational features (spec §7.6): dry-run, audit replay and backfill on connect.
import type { Db } from "../db/migrate.ts";
import { appendAudit } from "../db/ledgers.ts";
import { ruleEventsFor } from "../app/rule-events.ts";
import { DEFAULT_MAGIC_WORDS } from "../parse/magicWords.ts";
import type { MagicWords } from "../parse/magicWords.ts";
import { parseReferences } from "../parse/references.ts";
import { parseRules, run } from "../rules/engine.ts";
import type { Action, ActionExecutor, RuleEvent } from "../rules/types.ts";
import type { OutboxPlanStep, PlanMetadata } from "./plans.ts";

/** Failure with an HTTP-ish status so the config API can answer precisely. */
export class OperationError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "OperationError";
    this.status = status;
  }
}

export function toRuleEvent(event: string, payload: unknown): RuleEvent | null {
  return toRuleEvents(event, payload)[0] ?? null;
}

/** A default-branch push fires both `push` and `commit.pushed_to_default`, in runtime order. */
export function toRuleEvents(event: string, payload: unknown): RuleEvent[] {
  return ruleEventsFor("github", event, payload);
}

const refusingExecutor: ActionExecutor = {
  async execute(): Promise<never> {
    throw new Error("dry-run must not execute actions");
  },
};

export interface DryRunEventResult {
  /** The trigger the delivery maps to, or null when it is not an automation event. */
  trigger: string | null;
  matched: { index: number; name: string | null } | null;
  actions: Action[];
}

export interface DryRunResult extends DryRunEventResult {
  dryRun: true;
  /** Per-trigger evaluations when a delivery fires multiple rule events. */
  events?: DryRunEventResult[];
}

/** Evaluates the rules against a delivery and reports what would happen. Nothing is written or executed. */
export async function dryRun(input: { rulesYaml: string; event: string; payload: unknown }): Promise<DryRunResult> {
  const rules = parseRules(input.rulesYaml);
  const events: DryRunEventResult[] = [];
  for (const ruleEvent of toRuleEvents(input.event, input.payload)) {
    const result = await run(rules, ruleEvent, refusingExecutor, { dryRun: true });
    const m = result.evaluation.matched;
    events.push({ trigger: ruleEvent.trigger, matched: m ? { index: m.index, name: m.rule.name ?? null } : null,
      actions: result.evaluation.actions });
  }
  const first = events[0];
  return {
    dryRun: true,
    trigger: first?.trigger ?? null,
    matched: first?.matched ?? null,
    actions: events.flatMap((e) => e.actions),
    ...(events.length > 1 ? { events } : {}),
  };
}

export interface ReplayJob {
  /** Stable original identity for outbound write deduplication; transport deliveryId stays fresh. */
  writeDeliveryId?: string;
  source: "github" | "plane";
  deliveryId: string;
  event: string;
  receivedAt: string;
  payload: unknown;
}

/** Restore the registered workflow, never replace its immutable writes or saved API results.
 * Recovery's regular pending-row scan supplies wake-ups even when Redis is unavailable here.
 */
export async function restoreCreateWorkflow(db: Db, root: string): Promise<boolean> {
  const restore = async (conn: Db): Promise<boolean> => {
    await conn.exec("BEGIN");
    try {
      const first = (await conn.query<{ id: string; side: string; target_key: string; write: { _plan?: PlanMetadata } }>(
        "SELECT id, side, target_key, write FROM outbound_writes WHERE id = $1", [root])).rows[0];
      if (!first) throw new OperationError(409, "The original create workflow is no longer retained");
      let marker = first.write._plan?.marker;
      if (!marker) {
        const actions = (await conn.query<{ step: OutboxPlanStep }>(`SELECT step FROM outbound_writes w,
          LATERAL jsonb_array_elements(COALESCE(w.write->'_plan'->'after','[]'::jsonb)) step
          WHERE w.write->'_plan'->>'root' = $1 AND step->>'kind' IN ('sync_link','clear_pending_link')
          ORDER BY w.sequence`, [root])).rows.map((r) => r.step);
        const clear = actions.find((a) => a.kind === "clear_pending_link");
        const link = actions.find((a) => a.kind === "sync_link");
        if (clear?.kind === "clear_pending_link" && link?.kind === "sync_link") {
          marker = { key: clear.key, root, link: link.link };
        }
      }
      // Match the executor/retry lock order, then the registration barrier for this object.
      if (db.withConnection) {
        // Fetch target keys rather than retaining every queued event's payload in memory.
        const targets = (await conn.query<{ target_key: string }>("SELECT DISTINCT target_key FROM outbound_writes WHERE id = $1 OR write->'_plan'->>'root' = $1 ORDER BY target_key", [root])).rows;
        for (const { target_key } of targets) {
          await conn.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`gitsync:outbound:${target_key}`]);
        }
        for (const target of [...new Set([first.target_key,
          ...(marker ? [JSON.stringify([first.side, "create", marker.key])] : [])])].sort()) {
          await conn.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`gitsync:outbound-register:${target}`]);
        }
      }
      const failed = await conn.query("SELECT 1 FROM outbound_writes WHERE status = 'failed' AND (id = $1 OR write->'_plan'->>'root' = $1) LIMIT 1", [root]);
      if (!failed.rows.length) { await conn.exec("COMMIT"); return false; }
      if (!marker) throw new OperationError(409, "The original create workflow has no retained object identity");
      const live = (await conn.query<{ outbox_id: string }>("SELECT outbox_id FROM pending_sync_links WHERE key = $1", [marker.key])).rows[0];
      if (live && live.outbox_id !== root) throw new OperationError(409, "A newer create workflow already owns this object");
      const link = marker.link;
      const unresolved = await conn.query("SELECT 1 FROM outbound_writes WHERE write->'_plan'->>'root' = $1 AND status = 'failed' AND write->>'kind' = 'create_issue' AND result IS NULL LIMIT 1", [root]);
      if (unresolved.rows.length) {
        const active = await conn.query(`SELECT 1 FROM sync_links WHERE status = 'active' AND plane_workspace_slug = $1
          AND plane_project_id = $2 AND gh_repo_id = $3 AND gh_kind = $4
          AND (($5::int IS NOT NULL AND gh_number = $5) OR ($6::text IS NOT NULL AND plane_issue_id = $6)) LIMIT 1`,
        [link.planeWorkspaceSlug, link.planeProjectId, link.ghRepoId, link.ghKind ?? "issue",
          typeof link.ghNumber === "number" ? link.ghNumber : null, typeof link.planeIssueId === "string" ? link.planeIssueId : null]);
        if (active.rows.length) throw new OperationError(409, "This object already has an active partner");
      }
      await conn.query(`UPDATE outbound_writes SET status = 'pending', attempts = 0,
        error = NULL, retry_at = NULL, updated_at = now()
        WHERE status = 'failed' AND (id = $1 OR write->'_plan'->>'root' = $1)`, [root]);
      await conn.query(`INSERT INTO pending_sync_links (key,outbox_id,link) VALUES ($1,$2,$3::jsonb)
        ON CONFLICT (key) DO NOTHING`, [marker.key, root, JSON.stringify(marker.link)]);
      await conn.exec("COMMIT");
      return true;
    } catch (error) { await conn.exec("ROLLBACK").catch(() => {}); throw error; }
  };
  return db.withConnection ? db.withConnection(restore) : restore(db);
}

/** delivery_id binds the original inbound identity to its durable create workflow roots.
 * It is registered in the same transaction as the steps, and survives removal of the pending marker.
 */
async function restoreDeliveryWorkflows(db: Db, source: string, deliveryId: string, workspaceSlug: string | null): Promise<void> {
  const roots = (await db.query<{ root: string }>(`SELECT DISTINCT w.write->'_plan'->>'root' AS root
    FROM outbound_writes w WHERE w.delivery_id = $1 AND ($2::text IS NULL OR w.workspace_slug = $2)
      AND w.write->'_plan'->>'root' IS NOT NULL
      AND (EXISTS (SELECT 1 FROM outbound_writes r WHERE r.id = w.write->'_plan'->>'root'
        AND r.write->'_plan'->'marker' IS NOT NULL) OR EXISTS (
          SELECT 1 FROM outbound_writes c, LATERAL jsonb_array_elements(COALESCE(c.write->'_plan'->'after','[]'::jsonb)) a
          WHERE c.write->'_plan'->>'root' = w.write->'_plan'->>'root' AND a->>'kind' = 'clear_pending_link'))
      AND EXISTS (SELECT 1 FROM outbound_writes f WHERE f.write->'_plan'->>'root' = w.write->'_plan'->>'root' AND f.status = 'failed')
    ORDER BY root`, [`${source}-${deliveryId}`, workspaceSlug])).rows;
  for (const { root } of roots) await restoreCreateWorkflow(db, root);
}

/**
 * Re-enqueues an audited inbound delivery. The fresh delivery id matters: the duplicate ledger would
 * drop a replay that reused the original's, which is the whole point of the ledger.
 */
export async function replayDelivery(
  deps: { db: Db; enqueue(job: ReplayJob): Promise<void>; now?: () => Date },
  auditId: number | string,
): Promise<{ auditId: number | string; deliveryId: string }> {
  const { rows } = await deps.db.query<any>(
    `SELECT id, kind, source, delivery_id, workspace_slug, detail FROM audit_log WHERE id = $1`, [auditId]);
  const row = rows[0];
  if (!row) throw new OperationError(404, "No such audit entry");
  if (row.kind !== "inbound_delivery") throw new OperationError(422, "Only inbound deliveries can be replayed");
  if (row.source !== "github" && row.source !== "plane") throw new OperationError(422, "The audit entry has no source");
  const detail = typeof row.detail === "string" ? JSON.parse(row.detail) : row.detail;
  if (!detail || typeof detail.event !== "string" || detail.payload === undefined) {
    throw new OperationError(422, "That delivery has no payload on file (duplicates keep only the event)");
  }
  const now = (deps.now ?? (() => new Date()))();
  const deliveryId = `replay-${row.id}-${now.getTime()}`;
  const writeDeliveryId = typeof detail.writeDeliveryId === "string" && detail.writeDeliveryId ? detail.writeDeliveryId : row.delivery_id;
  if (typeof writeDeliveryId !== "string" || !writeDeliveryId) throw new OperationError(422, "That delivery has no original identity on file");
  // Repair registered tails before either reducer can short-circuit on a link/created audit.
  await restoreDeliveryWorkflows(deps.db, row.source, writeDeliveryId, row.workspace_slug ?? null);
  await deps.enqueue({ source: row.source, deliveryId, writeDeliveryId, event: detail.event, receivedAt: now.toISOString(), payload: detail.payload });
  const newId = await appendAudit(deps.db, {
    kind: "replay",
    source: row.source,
    deliveryId,
    ...(row.workspace_slug ? { workspaceSlug: row.workspace_slug } : {}),
    detail: { event: detail.event, originalDeliveryId: writeDeliveryId },
    outcome: "queued",
    replayOf: row.id,
  });
  return { auditId: newId, deliveryId };
}

export interface GithubRequester { request(route: string, params?: Record<string, unknown>): Promise<{ data: any }> }
export interface BackfillMapping { id: number; workspaceSlug: string; planeProjectId: string; ghRepoId: number; owner: string; repo: string }
export interface BackfillResult { linked: number; unresolved: number; pullRequests: number; issues: number }

const PAGE = 100;
const MAX_PAGES = 50;

async function listOpen(github: GithubRequester, route: string, owner: string, repo: string): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await github.request(route, { owner, repo, state: "open", per_page: PAGE, page });
    const items: any[] = Array.isArray(res?.data) ? res.data : [];
    out.push(...items);
    if (items.length < PAGE) break;
  }
  return out;
}

/** On connect: link the repository's open PRs and issues to the work items they reference (§6, §7.6). */
export async function backfill(deps: {
  db: Db;
  github: GithubRequester;
  mapping: BackfillMapping;
  resolveIssue(key: string): Promise<{ projectId: string; issueId: string } | null | undefined>;
  words?: MagicWords;
}): Promise<BackfillResult> {
  const { db, github, mapping } = deps;
  const words = deps.words ?? DEFAULT_MAGIC_WORDS;
  const result: BackfillResult = { linked: 0, unresolved: 0, pullRequests: 0, issues: 0 };
  const resolved = new Map<string, { projectId: string; issueId: string } | null>();

  const link = async (item: any, kind: "pr" | "issue", branch?: string) => {
    if (!Number.isSafeInteger(item?.number)) return;
    const parsed = parseReferences({
      ...(branch ? { branch } : {}),
      ...(typeof item.title === "string" ? { title: item.title } : {}),
      ...(typeof item.body === "string" ? { body: item.body } : {}),
    }, words);
    for (const ref of parsed.refs) {
      if (!resolved.has(ref.identifier)) resolved.set(ref.identifier, (await deps.resolveIssue(ref.identifier)) ?? null);
      const target = resolved.get(ref.identifier);
      if (!target) { result.unresolved++; continue; }
      // Backfill establishes references; it cannot revoke an existing mirror opt-in. The guard
      // belongs in the upsert so a concurrent label-sync insert is protected at conflict time too.
      await db.query(`
        INSERT INTO sync_links (plane_workspace_slug, plane_project_id, plane_issue_id,
          gh_repo_id, gh_number, gh_kind, tier, created_by, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
        ON CONFLICT (plane_issue_id, gh_repo_id, gh_number)
        DO UPDATE SET status = 'active', orphaned_at = NULL, tier = EXCLUDED.tier,
          created_by = EXCLUDED.created_by
        WHERE sync_links.created_by <> 'label_sync'
      `, [mapping.workspaceSlug, target.projectId, target.issueId, mapping.ghRepoId,
        item.number, kind, ref.tier, ref.source === "branch" ? "branch" : "magic_word"]);
      result.linked++;
    }
  };

  const prs = await listOpen(github, "GET /repos/{owner}/{repo}/pulls", mapping.owner, mapping.repo);
  for (const pr of prs) { result.pullRequests++; await link(pr, "pr", typeof pr?.head?.ref === "string" ? pr.head.ref : undefined); }
  // GitHub's issues endpoint also lists pull requests; those were handled above.
  const issues = (await listOpen(github, "GET /repos/{owner}/{repo}/issues", mapping.owner, mapping.repo)).filter((i) => !i?.pull_request);
  for (const issue of issues) { result.issues++; await link(issue, "issue"); }

  await appendAudit(db, { kind: "backfill", workspaceSlug: mapping.workspaceSlug, outcome: "done", detail: { mappingId: mapping.id, ...result } });
  return result;
}
