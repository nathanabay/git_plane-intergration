// Operational features (spec §7.6): dry-run, audit replay and backfill on connect.
import type { Db } from "../db/migrate.ts";
import { appendAudit } from "../db/ledgers.ts";
import { ruleEventsFor } from "../app/rule-events.ts";
import { DEFAULT_MAGIC_WORDS } from "../parse/magicWords.ts";
import type { MagicWords } from "../parse/magicWords.ts";
import { parseReferences } from "../parse/references.ts";
import { parseRules, run } from "../rules/engine.ts";
import type { Action, ActionExecutor, RuleEvent } from "../rules/types.ts";

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
