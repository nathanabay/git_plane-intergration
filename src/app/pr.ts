// Pull requests (spec §6, §7.1, §7.4): parse references, link the work items, run the lifecycle rules,
// keep the PR rollup link on every linked item, and say so on the GitHub side if linkback is on.
import { appendAudit, upsertSyncLink } from "../db/ledgers.ts";
import { classifyGithubError } from "../github/errors.ts";
import { problemReportsEnabled, reportGithubProblem } from "../github/problems.ts";
import { checkPrReadiness, readPrReviews, resolveStateTarget, prEventToRuleEvent, shouldReevaluatePrReadiness } from "../github/pr-automation.ts";
import type { LinkedIssue, OctokitRequest } from "../github/pr-automation.ts";
import { parseReferences, resolveReferences } from "../parse/references.ts";
import type { IssueRef } from "../parse/references.ts";
import { createPlanRoot, freshest, nextCreateGeneration } from "../sync/mirror.ts";
import { planeItemsPath, planeWorkspacePath } from "../sync/plane.ts";
import { prRollupKey, prRollupTitle, upsertRollupLink } from "../sync/dev-info.ts";
import type { RollupTarget } from "../sync/dev-info.ts";
import type { InboundJob } from "../queue/index.ts";
import { actorTokenFor, installationFor, loadMagicWords, planeIssueUrl, projectOf, withObjectLock } from "./context.ts";
import type { AppContext } from "./context.ts";
import { assertInstallationAllowed, freezeMappingAuthority, mappingsForRepo } from "./mappings.ts";
import type { Mapping } from "./mappings.ts";
import { mappingWriterContext } from "./issues.ts";
import { linkedIssuesFor, runRules } from "./rules.ts";
import { deliveryScope, resultRef } from "./writers.ts";
import type { ReducerContinuation } from "./writers.ts";

export interface LinkedItem { ref: IssueRef; issueId: string; projectId: string; identifier: string }

type PrState = "open" | "merged" | "closed_unmerged";
const prStateOf = (pr: any): PrState => (pr?.merged ? "merged" : String(pr?.state).toLowerCase() === "open" ? "open" : "closed_unmerged");

/** Every other PR linked to the item, as GitHub reports it now. Unknown counts as open: never advance on a guess (§6). */
async function otherPrStates(ctx: AppContext, issueId: string, thisRepoId: number, thisNumber: number): Promise<{ state: PrState }[]> {
  const { rows } = await ctx.db.query<{ gh_repo_id: string | number; gh_number: number }>(
    "SELECT gh_repo_id, gh_number FROM sync_links WHERE plane_issue_id = $1 AND gh_kind = 'pr' AND status = 'active' AND NOT (gh_repo_id = $2 AND gh_number = $3)",
    [issueId, thisRepoId, thisNumber]);
  const out: { state: PrState }[] = [];
  for (const r of rows) {
    try {
      const [m] = await mappingsForRepo(ctx.db, Number(r.gh_repo_id));
      if (!m) throw new Error("repository not mapped");
      const octokit = await ctx.ghClient.installationOctokit(await installationFor(ctx, m));
      const res = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner: m.owner, repo: m.repo, pull_number: r.gh_number });
      out.push({ state: prStateOf(res.data) });
    } catch {
      out.push({ state: "open" });
    }
  }
  return out;
}

type Review = { state: string; user?: { login?: string } | null };

/**
 * Every review of a PR, in GitHub's chronological order (audit G6/G16), through the same complete reader readiness
 * uses (`readPrReviews`). The latest decisions are on the last page, so a partial read stays `complete: false`; a
 * malformed page throws. Callers must not treat either as the whole set.
 */
export async function listPrReviews(octokit: OctokitRequest, repo: { owner: string; repo: string }, number: number): Promise<{ items: Review[]; complete: boolean }> {
  const read = await readPrReviews(octokit, repo, number);
  return { items: read.items.map((r) => ({ state: String(r.state ?? ""), user: r.user ?? null })), complete: read.complete };
}

/** The review list for the rollup, or undefined when it cannot be read completely: the rollup then reads REVIEW, not a stale decision. */
async function reviewsOf(ctx: AppContext, mapping: Mapping, payload: any, number: number): Promise<Review[] | undefined> {
  try {
    const octokit = await ctx.ghClient.installationOctokit(await installationFor(ctx, mapping, payload));
    const read = await listPrReviews(octokit, { owner: mapping.owner, repo: mapping.repo }, number);
    return read.complete ? read.items : undefined;
  } catch {
    return undefined; // the rollup is refreshed by the PR's next delivery; it never fails this one after its rules ran
  }
}

/**
 * The PR as GitHub reports it now, when that read is at least as new as the delivery (audit G10: GitHub may deliver
 * webhooks out of order). Read before the delivery changes anything, so a throttled or failed read retries it whole.
 * A PR the App can no longer see keeps the delivered snapshot.
 */
async function currentPrOf(ctx: AppContext, mapping: Mapping, payload: any): Promise<{ pr: any; fresh: boolean }> {
  const delivered = payload.pull_request;
  let read: unknown = null;
  try {
    const octokit = await ctx.ghClient.installationOctokit(await installationFor(ctx, mapping, payload));
    read = (await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner: mapping.owner, repo: mapping.repo, pull_number: delivered.number })).data;
  } catch (err) {
    const kind = classifyGithubError(err).kind;
    if (kind !== "not_found" && kind !== "permission") throw err;
  }
  const pr = freshest(delivered, read);
  return { pr, fresh: pr !== delivered };
}

/**
 * A lifecycle trigger the PR's current state contradicts is an older delivery arriving late (a `closed` after the
 * reopen, an `opened` after the merge): applying it would move the work item backwards. A merge is final.
 */
export function staleLifecycle(trigger: string, now: any): boolean {
  const state = prStateOf(now);
  switch (trigger) {
    case "pull_request.merged": return false;
    case "pull_request.closed_unmerged": return state !== "closed_unmerged";
    case "pull_request.drafted": return state !== "open" || now?.draft !== true;
    case "pull_request.opened": return state !== "open" || now?.draft === true;
    default: return state !== "open"; // reopened, review requested, approved, changes requested
  }
}

/** Approvals and stage changes after which an already-approved, green PR can become ready (audit G15); shared with G2's callers. */
const readinessEvent = (job: InboundJob): boolean => shouldReevaluatePrReadiness(job.event, job.payload);

/** `{ID}-NEW` in a PR body (§6): a new work item in that project, linked, in the started group. */
async function createRequested(ctx: AppContext, mapping: Mapping, job: InboundJob, identifiers: string[]): Promise<LinkedItem[]> {
  const p: any = job.payload;
  const pr = p.pull_request;
  const out: LinkedItem[] = [];
  if (identifiers.length === 0) return out;
  const projects = await ctx.planeClient.listAll<{ id: string; identifier: string }>(planeWorkspacePath(mapping.workspaceSlug, "projects"));
  for (const identifier of identifiers) {
    const project = projects.find((x) => x.identifier?.toUpperCase() === identifier);
    if (!project) {
      await appendAudit(ctx.db, { kind: "pr_create_request", source: "github", deliveryId: job.deliveryId, workspaceSlug: mapping.workspaceSlug, detail: { repoId: mapping.ghRepoId, number: pr.number, identifier }, outcome: "failed", error: `no Plane project has the identifier ${identifier}` });
      continue;
    }
    // A historical success is a guard only while its partner is active. An orphan confirmed by
    // reconciliation permits a replacement; a missing local link does not prove the partner absent.
    const previous = (await ctx.db.query<{ id: string | number; status: string | null; same_request: boolean }>(`SELECT a.id, l.status,
      bool_or(a.delivery_id = $6) OVER () AS same_request
      FROM audit_log a LEFT JOIN sync_links l ON l.plane_issue_id = a.detail->>'planeIssueId'
        AND l.gh_repo_id = $1::bigint AND l.gh_number = $2::integer AND l.gh_kind = 'pr'
        AND l.plane_workspace_slug = $4 AND l.plane_project_id = $5
      WHERE a.kind = 'pr_create_request' AND a.detail->>'repoId' = $1::text
        AND a.detail->>'number' = $2::text AND a.detail->>'identifier' = $3
        AND a.workspace_slug = $4 AND a.outcome = 'created' ORDER BY a.id DESC LIMIT 1`,
      [String(mapping.ghRepoId), String(pr.number), identifier, mapping.workspaceSlug, project.id, job.writeDeliveryId ?? job.deliveryId])).rows[0];
    if (previous && (previous.same_request || previous.status !== "orphaned")) continue;
    const states = await ctx.planeClient.listStates(mapping.workspaceSlug, project.id);
    const started = resolveStateTarget(states, "started");
    if (ctx.plane.plan && ctx.github.plan) {
      // The created id is never read here: the create, its sync link, the audit and the resume of the remaining PR work for
      // this one target are a single durable plan (CB's outbox), keyed by object so a redelivery reuses it.
      const link = { planeWorkspaceSlug: mapping.workspaceSlug, planeProjectId: project.id, planeIssueId: resultRef("created.id"), ghRepoId: mapping.ghRepoId, ghNumber: pr.number, ghKind: "pr" as const, tier: "closing" as const, createdBy: "magic_word" as const };
      // Keep failed/ambiguous creates on their original identity; only a confirmed orphan gets a replacement.
      const objectKey = `create:pr:${mapping.workspaceSlug}:${mapping.ghRepoId}#${pr.number}:${project.id}`;
      let generation = await nextCreateGeneration(ctx.db, objectKey);
      if (generation === null) {
        await appendAudit(ctx.db, { kind: "pr_create_request", source: "github", deliveryId: job.deliveryId, workspaceSlug: mapping.workspaceSlug, detail: { repoId: mapping.ghRepoId, number: pr.number, identifier }, outcome: "ignored", error: "a create for this pull request is already in progress" });
        continue;
      }
      // Retention can prune the original outbox rows, but the orphan's audit still identifies a
      // distinct replacement intent. Never recover a deleted partner using its old external id.
      if (previous?.status === "orphaned" && generation === objectKey) generation = `${objectKey}:replacement:${previous.id}`;
      const registered = await ctx.plane.plan(generation, [
        { kind: "write", side: "plane", bind: "created", write: { kind: "create_issue", slug: mapping.workspaceSlug, projectId: project.id, fields: { name: String(pr.title ?? ""), ...(started.ok ? { state: started.stateId } : {}) } } },
        { kind: "sync_link", link },
        { kind: "audit", entry: { kind: "pr_create_request", source: "github", deliveryId: job.deliveryId, workspaceSlug: mapping.workspaceSlug, detail: { repoId: mapping.ghRepoId, number: pr.number, identifier, planeIssueId: resultRef("created.id") }, outcome: "created" } },
        { kind: "write", side: "github", write: { kind: "resume_reducer", continuation: { kind: "pr_created", job, mappingId: mapping.id, projectId: project.id, identifier, issueId: resultRef("created.id") } } },
      ], { pendingLink: link, pendingMarker: { key: objectKey, root: createPlanRoot(generation), link } });
      // Only a newly registered plan owns the created item's rules (its `pr_created` resume). A duplicate plan
      // (`inserted === false`) resumes nothing, so this delivery's own rules cover the item once it is linked; audit the duplicate.
      if ((registered as { inserted?: boolean }).inserted === false) {
        await appendAudit(ctx.db, { kind: "pr_create_request", source: "github", deliveryId: job.deliveryId, workspaceSlug: mapping.workspaceSlug, detail: { repoId: mapping.ghRepoId, number: pr.number, identifier }, outcome: "ignored", error: "create plan already registered for this pull request" });
      }
      continue;
    }
    const created = await ctx.plane.apply({ kind: "create_issue", slug: mapping.workspaceSlug, projectId: project.id, fields: { name: String(pr.title ?? ""), ...(started.ok ? { state: started.stateId } : {}) } });
    if (!created.id) throw new Error("Plane returned no id for the new work item");
    await upsertSyncLink(ctx.db, { planeWorkspaceSlug: mapping.workspaceSlug, planeProjectId: project.id, planeIssueId: created.id, ghRepoId: mapping.ghRepoId, ghNumber: pr.number, ghKind: "pr", tier: "closing", createdBy: "magic_word" });
    await appendAudit(ctx.db, { kind: "pr_create_request", source: "github", deliveryId: job.deliveryId, workspaceSlug: mapping.workspaceSlug, detail: { repoId: mapping.ghRepoId, number: pr.number, identifier, planeIssueId: created.id }, outcome: "created" });
    out.push({ ref: { identifier: `${identifier}-NEW`, project: identifier, sequence: 0, tier: "closing", source: "body" }, issueId: created.id, projectId: project.id, identifier });
  }
  return out;
}

/**
 * F7: `pull_request.ready_for_merge` for one open, non-draft PR. Readiness is read from GitHub (an approving review
 * and every check suite green, `checkPrReadiness`). The rule runs once per head commit: the audit row written after
 * it is the guard, so redeliveries and the several events that arrive together (approval, each check suite, the
 * commit status) cannot fire it twice. A new push is a new head commit and can become ready again.
 */
export async function fireReadyForMerge(ctx: AppContext, mapping: Mapping, job: InboundJob, octokit: any, pr: any): Promise<boolean> {
  const scope = deliveryScope.getStore();
  let authority = scope?.authority?.mappingId === String(mapping.id) ? scope.authority : undefined;
  if (!authority) {
    await assertInstallationAllowed(ctx.db, await installationFor(ctx, mapping, job.payload), mapping.workspaceSlug);
    authority = freezeMappingAuthority(mapping);
  }
  return deliveryScope.run({ ...scope, deliveryId: scope?.deliveryId ?? `github-${job.writeDeliveryId ?? job.deliveryId}`,
    workspaceSlug: mapping.workspaceSlug, authority }, () => readyForMapping(mappingWriterContext(ctx, mapping, authority), mapping, job, octokit, pr));
}

async function readyForMapping(ctx: AppContext, mapping: Mapping, job: InboundJob, octokit: any, pr: any): Promise<boolean> {
  if (!pr || !Number.isSafeInteger(pr.number) || pr.draft === true || pr.merged === true || String(pr.state ?? "open").toLowerCase() !== "open") return false;
  const headSha: unknown = pr.head?.sha;
  if (typeof headSha !== "string" || !headSha) return false;
  const issues = await linkedIssuesFor(ctx, mapping, "pr", pr.number); // no linked item: no API call at all
  if (issues.length === 0) return false;
  const p: any = job.payload;
  const fired = async () => (await ctx.db.query("SELECT 1 FROM audit_log WHERE kind = 'ready_for_merge' AND workspace_slug = $1 AND detail->>'repoId' = $2 AND detail->>'number' = $3 AND detail->>'sha' = $4", [mapping.workspaceSlug, String(mapping.ghRepoId), String(pr.number), headSha])).rows.length > 0;
  if (await fired()) return false;
  const ready = await checkPrReadiness(octokit, { owner: mapping.owner, repo: mapping.repo }, pr.number, headSha, {
    onUnavailable: async (info) => { await appendAudit(ctx.db, { kind: "readiness_unavailable", source: "github", deliveryId: job.deliveryId, workspaceSlug: mapping.workspaceSlug, detail: { repoId: mapping.ghRepoId, number: pr.number, sha: headSha, ...info }, outcome: "ignored", error: `GitHub answered ${info.status} for the commit status; grant the App "Commit statuses: Read"` }); },
  });
  if (!ready) return false;
  return withObjectLock(ctx.db, `ready:${mapping.ghRepoId}#${pr.number}`, async () => {
    if (await fired()) return false;
    const event = prEventToRuleEvent("pull_request", { action: "ready_for_merge", pull_request: pr, repository: p?.repository }, { isReadyForMerge: true });
    if (!event) return false;
    await runRules(ctx, mapping, event, issues, { deliveryId: job.deliveryId, actor: () => actorTokenFor(ctx, mapping, p?.sender, event.trigger, p) });
    await appendAudit(ctx.db, { kind: "ready_for_merge", source: "github", deliveryId: job.deliveryId, workspaceSlug: mapping.workspaceSlug, detail: { repoId: mapping.ghRepoId, number: pr.number, sha: headSha }, outcome: "fired" });
    return true;
  });
}

export async function handlePullRequest(ctx: AppContext, job: InboundJob): Promise<void> {
  const p: any = job.payload;
  const pr = p?.pull_request;
  const repoId = Number(p?.repository?.id);
  if (!pr || !Number.isSafeInteger(pr.number) || !Number.isSafeInteger(repoId)) {
    await appendAudit(ctx.db, { kind: "pull_request", source: "github", deliveryId: job.deliveryId, outcome: "ignored", error: "payload has no pull request" });
    return;
  }
  const mappings = await mappingsForRepo(ctx.db, repoId);
  if (mappings.length === 0) {
    await appendAudit(ctx.db, { kind: "pull_request", source: "github", deliveryId: job.deliveryId, detail: { repoId, number: pr.number }, outcome: "unmapped_repo" });
    return;
  }
  for (const mapping of mappings) {
    await assertInstallationAllowed(ctx.db, await installationFor(ctx, mapping, p), mapping.workspaceSlug);
    const scope = deliveryScope.getStore();
    const authority = freezeMappingAuthority(mapping);
    await deliveryScope.run({ ...scope, deliveryId: scope?.deliveryId ?? `github-${job.writeDeliveryId ?? job.deliveryId}`,
      workspaceSlug: mapping.workspaceSlug, authority }, () => withObjectLock(ctx.db, `pr:${mapping.workspaceSlug}:${repoId}#${pr.number}`,
      () => handleForMapping(mappingWriterContext(ctx, mapping, authority), mapping, job)));
  }
}

/** Retain later deliveries on live or failed creates; only explicit repair revives failed remote work. */
async function deferPendingPr(ctx: AppContext, mapping: Mapping, job: InboundJob): Promise<{ owned: Set<string>; pending: boolean; identifiers: Set<string> }> {
  const owned = new Set<string>();
  const identifiers = new Set<string>();
  if (!ctx.plane.plan) return { owned, pending: false, identifiers };
  const pr: any = (job.payload as any).pull_request;
  const pending = await ctx.db.query<{ key: string; outbox_id: string; link: Record<string, unknown>; created_id: string; fence_id: string; identifier: string; owns_event: boolean; result: { id?: string } | null }>(`WITH candidates AS (
    SELECT p.key, p.outbox_id, p.link, r.sequence FROM pending_sync_links p JOIN outbound_writes r ON r.id = p.outbox_id
    UNION ALL
    SELECT r.write->'_plan'->'marker'->>'key', r.id, r.write->'_plan'->'marker'->'link', r.sequence
    FROM outbound_writes r WHERE r.write->'_plan'->'marker' IS NOT NULL AND EXISTS (
      SELECT 1 FROM outbound_writes f WHERE f.write->'_plan'->>'root' = r.id AND f.status = 'failed')
    ), workflows AS (SELECT DISTINCT ON (key) key, outbox_id, link FROM candidates ORDER BY key, sequence DESC)
    SELECT p.key, p.outbox_id, p.link,
    (SELECT w.id FROM outbound_writes w WHERE w.write->'_plan'->>'root' = p.outbox_id
      AND w.write->>'kind' = 'create_issue' AND w.side = 'plane' ORDER BY sequence LIMIT 1) AS created_id,
    (SELECT w.id FROM outbound_writes w WHERE w.write->'_plan'->>'root' = p.outbox_id ORDER BY sequence DESC LIMIT 1) AS fence_id,
    (SELECT w.result FROM outbound_writes w WHERE w.id = p.outbox_id) AS result,
    (SELECT w.write->'continuation'->>'identifier' FROM outbound_writes w WHERE w.write->'_plan'->>'root' = p.outbox_id
      AND w.write->'continuation'->>'kind' = 'pr_created' AND w.write->'continuation'->>'identifier' <> '' ORDER BY sequence LIMIT 1) AS identifier,
    EXISTS (SELECT 1 FROM outbound_writes w WHERE w.write->'_plan'->>'root' = p.outbox_id
      AND w.write->>'kind' = 'resume_reducer' AND w.write->'continuation'->'job'->>'source' = $4
      AND COALESCE(w.write->'continuation'->'job'->>'writeDeliveryId', w.write->'continuation'->'job'->>'deliveryId') = $5) AS owns_event
    FROM workflows p WHERE p.link->>'ghKind' = 'pr' AND p.link->>'ghRepoId' = $1
      AND p.link->>'ghNumber' = $2 AND p.link->>'planeWorkspaceSlug' = $3
      AND NOT EXISTS (SELECT 1 FROM outbound_writes c JOIN sync_links l
        ON l.status = 'orphaned' AND l.gh_kind = 'pr' AND l.plane_issue_id = c.result->>'id'
          AND l.plane_workspace_slug = c.write->>'slug' AND l.plane_project_id = c.write->>'projectId'
          AND l.gh_repo_id = (p.link->>'ghRepoId')::bigint AND l.gh_number = (p.link->>'ghNumber')::integer
        WHERE c.write->'_plan'->>'root' = p.outbox_id AND c.side = 'plane'
          AND c.write->>'kind' = 'create_issue' AND c.result->>'ok' = 'true'
          AND EXISTS (SELECT 1 FROM outbound_writes f WHERE f.write->'_plan'->>'root' = p.outbox_id AND f.status = 'failed'))`,
    [String(mapping.ghRepoId), String(pr.number), mapping.workspaceSlug, job.source, job.writeDeliveryId ?? job.deliveryId]);
  for (const p of pending.rows) {
    if (!p.created_id || !p.fence_id || !p.identifier || typeof p.link.planeProjectId !== "string") throw new Error("retained PR create has no continuation fence");
    identifiers.add(p.identifier);
    if (p.result?.id) owned.add(p.result.id);
    // Replay restores the saved workflow before reducing the event. Its existing continuation owns
    // this event's rules, including a saved original create continuation after terminal failure.
    if (p.owns_event) continue;
    const opts = { groupRoot: p.outbox_id, bindings: { created: p.created_id }, predecessor: p.fence_id,
      pendingMarker: { key: p.key, root: p.outbox_id, link: p.link }, holdOnFailure: true };
    await ctx.plane.plan(`pr-event:${p.key}:${job.source}:${job.writeDeliveryId ?? job.deliveryId}`, [
      { kind: "write", side: "plane", write: { kind: "resume_reducer", continuation: { kind: "pr_created", job,
        mappingId: mapping.id, projectId: p.link.planeProjectId, issueId: resultRef("created.id"), identifier: "" } } },
    ], opts);
  }
  return { owned, pending: pending.rows.length > 0, identifiers };
}

/**
 * N2: keys in the PR that name no work item are reported on the PR itself, behind the mapping's "Report problems" toggle,
 * and only when the delivery's sender is a GitHub account linked in this workspace.
 * Only a 404 is reported: Plane's identifier endpoint answers 404 when the project exists but the sequence does not, and
 * 403 for an unknown project (or one the service cannot see), which is how stray tokens such as `UTF-8` resolve.
 * G2's helper keeps one comment per PR (stable key `pr-unresolved:<number>`, marked and found by the App bot), registers
 * a new intent only when the message set changes, and edits that comment in place; it runs under the PR's frozen authority.
 */
async function reportUnresolvedKeys(ctx: AppContext, mapping: Mapping, prNumber: number, unknown: IssueRef[], statuses: Record<string, number>, sender: any): Promise<void> {
  const missing = [...new Set(unknown.filter((u) => statuses[u.identifier] === 404).map((u) => u.identifier))];
  if (!missing.length) return;
  // Only for someone linked in this workspace (by stable GitHub id). The 404-only report would otherwise let anyone who
  // can open a PR on a public repository learn which Plane project keys and item numbers exist (security-audit
  // ATTACK-CLASSES "Feature abuse and data leakage": enumeration through side effects).
  if (!Number.isSafeInteger(sender?.id)) return;
  const linked = await ctx.db.query("SELECT 1 FROM user_map WHERE workspace_slug = $1 AND gh_id = $2", [mapping.workspaceSlug, sender.id]);
  if (!linked.rows.length) return;
  const scoped = deliveryScope.getStore()?.authority;
  const authority = scoped?.mappingId === String(mapping.id) ? scoped : freezeMappingAuthority(mapping);
  if (!(await problemReportsEnabled(ctx.db, authority))) return;
  if (!ctx.github.plan) throw new Error("problem reports require the durable GitHub outbox");
  await reportGithubProblem({ enabled: true, authority, plan: ctx.github.plan }, {
    owner: mapping.owner, repo: mapping.repo, key: `pr-unresolved:${prNumber}`, target: { kind: "issue", number: prNumber },
    messages: missing.map((id) => `${id} does not match a work item in the linked Plane workspace, so this pull request is not linked to it.`),
  });
}

async function handleForMapping(ctx: AppContext, mapping: Mapping, job: InboundJob): Promise<void> {
  const p: any = job.payload;
  const pr = p.pull_request;
  const slug = mapping.workspaceSlug;
  const now = await currentPrOf(ctx, mapping, p);
  const deferred = await deferPendingPr(ctx, mapping, job);
  const parsed = parseReferences({
    ...(typeof pr.head?.ref === "string" ? { branch: pr.head.ref } : {}),
    ...(typeof pr.title === "string" ? { title: pr.title } : {}),
    ...(typeof pr.body === "string" ? { body: pr.body } : {}),
  }, await loadMagicWords(ctx.db));

  const { found, unknown, statuses } = await resolveReferences(ctx.planeClient, slug, parsed.refs);
  if (unknown.length) {
    await appendAudit(ctx.db, { kind: "reference_unresolved", source: "github", deliveryId: job.deliveryId, workspaceSlug: slug, detail: { repoId: mapping.ghRepoId, number: pr.number, identifiers: unknown.map((u) => u.identifier), statuses }, outcome: "ignored" });
    await reportUnresolvedKeys(ctx, mapping, pr.number, unknown, statuses, p.sender);
  }

  const items: LinkedItem[] = [];
  const fresh: LinkedItem[] = [];
  for (const { ref, issue } of found) {
    const projectId = projectOf(issue);
    if (!issue?.id || !projectId) continue;
    const item: LinkedItem = { ref, issueId: String(issue.id), projectId, identifier: ref.identifier };
    const had = await ctx.db.query("SELECT 1 FROM sync_links WHERE plane_issue_id = $1 AND gh_repo_id = $2 AND gh_number = $3", [item.issueId, mapping.ghRepoId, pr.number]);
    await upsertSyncLink(ctx.db, { planeWorkspaceSlug: slug, planeProjectId: projectId, planeIssueId: item.issueId, ghRepoId: mapping.ghRepoId, ghNumber: pr.number, ghKind: "pr", tier: ref.tier, createdBy: ref.source === "branch" ? "branch" : "magic_word" });
    items.push(item);
    if (had.rows.length === 0) fresh.push(item);
  }
  // R4 F7: an item made by `{ID}-NEW` is a stored `pr` link, not a reference in the text, so later deliveries (merge, review,
  // close) find it among the PR's active links.
  const stored = await ctx.db.query<{ plane_project_id: string; plane_issue_id: string; tier: IssueRef["tier"] }>(
    "SELECT plane_project_id, plane_issue_id, tier FROM sync_links WHERE gh_repo_id = $1 AND gh_number = $2 AND gh_kind = 'pr' AND status = 'active' AND plane_workspace_slug = $3",
    [mapping.ghRepoId, pr.number, slug]);
  for (const r of stored.rows) {
    if (items.some((i) => i.issueId === r.plane_issue_id)) continue;
    items.push({ ref: { identifier: `${r.plane_issue_id}`, project: "", sequence: 0, tier: r.tier, source: "body" }, issueId: r.plane_issue_id, projectId: r.plane_project_id, identifier: r.plane_issue_id });
  }
  if (["opened", "edited", "reopened"].includes(p.action)) {
    const created = await createRequested(ctx, mapping, job, parsed.createRequests.filter((id) => !deferred.identifiers.has(id)));
    items.push(...created);
    fresh.push(...created);
  }
  // F7/F8: readiness is judged from GitHub and targets the PR's stored links, so it does not depend on this delivery naming
  // an item. It runs after the delivery's own lifecycle rules (`pull_request.approved` included): when both points are in
  // the table the ready state must be the one the item ends in.
  // An approval, or a stage change (ready for review, reopened) of a PR that may already be approved and green; judged
  // on the PR as it is now, so a late `ready_for_review` after the PR went back to draft does not fire.
  const readyAfter = async () => {
    if (readinessEvent(job) && !deferred.pending) await fireReadyForMerge(ctx, mapping, job, await ctx.ghClient.installationOctokit(await installationFor(ctx, mapping, p)), now.pr);
  };
  if (items.length === 0) { await readyAfter(); return; }

  await completeItems(ctx, mapping, job, now, items.filter((it) => !deferred.owned.has(it.issueId)), fresh.filter((it) => !deferred.owned.has(it.issueId)), readyAfter);
}

/** Lifecycle rules for the given items, then (optionally) readiness, the PR rollup link and the linkback comment (§7.1, §7.4). */
async function completeItems(ctx: AppContext, mapping: Mapping, job: InboundJob, now: { pr: any; fresh: boolean }, items: LinkedItem[], fresh: LinkedItem[], afterRules?: () => Promise<void>): Promise<void> {
  const p: any = job.payload;
  const pr = p.pull_request;
  const slug = mapping.workspaceSlug;
  // ---- lifecycle rules ---------------------------------------------------------------------------
  const ruleEvent = prEventToRuleEvent(job.event, p);
  const stale = ruleEvent !== null && now.fresh && staleLifecycle(ruleEvent.trigger, now.pr);
  if (ruleEvent && stale) {
    await appendAudit(ctx.db, { kind: "rule_match", source: "github", deliveryId: job.deliveryId, workspaceSlug: slug,
      detail: { trigger: ruleEvent.trigger, number: pr.number, current: prStateOf(now.pr), draft: now.pr?.draft === true }, outcome: "ignored",
      error: "the pull request has changed since this delivery; an older lifecycle event does not move the work item back" });
  }
  if (ruleEvent && !stale) {
    const merged = ruleEvent.trigger === "pull_request.merged";
    const issues: LinkedIssue[] = [];
    for (const it of items) {
      const linkedPrs = merged ? [{ state: "merged" as const }, ...(await otherPrStates(ctx, it.issueId, mapping.ghRepoId, pr.number))] : undefined;
      issues.push({ slug, projectId: it.projectId, issueId: it.issueId, tier: it.ref.tier, ...(linkedPrs ? { linkedPrs } : {}) });
    }
    await runRules(ctx, mapping, ruleEvent, issues, { deliveryId: job.deliveryId, actor: () => actorTokenFor(ctx, mapping, p.sender, ruleEvent.trigger, p) });
  }
  await afterRules?.();

  // ---- development information (§7.4) ------------------------------------------------------------
  // The rollup shows the PR as it is now, not the delivered snapshot, which may be older than the last one applied.
  const cur = now.pr;
  const reviews = prStateOf(cur) === "open" ? await reviewsOf(ctx, mapping, p, pr.number) : undefined;
  const title = prRollupTitle({ number: pr.number, title: String(cur.title ?? ""), state: String(cur.state ?? "open"), merged: cur.merged === true, ...(reviews ? { reviews } : {}) });
  for (const it of items) {
    const target: RollupTarget = { slug, projectId: it.projectId, issueId: it.issueId };
    try {
      await upsertRollupLink({ db: ctx.db, writer: ctx.plane, findLinkId: (t, url) => findLinkId(ctx, t, url) }, target, prRollupKey(mapping.ghRepoId, pr.number), { title, url: String(cur.html_url ?? pr.html_url ?? "") });
    } catch (err) {
      await appendAudit(ctx.db, { kind: "rollup_link", source: "github", deliveryId: job.deliveryId, workspaceSlug: slug, detail: { issueId: it.issueId, number: pr.number }, outcome: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ---- linkback comment (§7.4), once per newly created link ----------------------------------------
  if (mapping.linkbackEnabled && fresh.length) {
    const url = planeIssueUrl(ctx.config.PUBLIC_ORIGIN);
    const lines = fresh.map((f) => `- ${f.identifier}: ${url(slug, f.projectId, f.issueId)}`);
    await ctx.github.apply({ kind: "comment", installationId: await installationFor(ctx, mapping, p), owner: mapping.owner, repo: mapping.repo, repoId: mapping.ghRepoId, number: pr.number,
      body: `Linked Plane work ${fresh.length === 1 ? "item" : "items"}:\n${lines.join("\n")}` });
  }
}

/**
 * Continuation of a `{ID}-NEW` create or a later fenced event: process only this created target.
 * An empty identifier marks a later event, which updates rules and rollup without another linkback.
 */
export async function handleCreatedPr(ctx: AppContext, request: ReducerContinuation): Promise<void> {
  const p: any = request.job.payload;
  const repoId = Number(p?.repository?.id);
  const mapping = (await mappingsForRepo(ctx.db, repoId)).find((m) => m.id === request.mappingId);
  if (!mapping || !p?.pull_request) {
    await appendAudit(ctx.db, { kind: "pr_create_request", source: "github", deliveryId: request.job.deliveryId, detail: { mappingId: request.mappingId, issueId: request.issueId }, outcome: "failed", error: "the mapping or pull request for a created work item is gone" });
    return;
  }
  const authority = request.authority ?? freezeMappingAuthority(mapping);
  const scope = deliveryScope.getStore();
  await deliveryScope.run({ ...scope, deliveryId: scope?.deliveryId ?? `github-${request.job.writeDeliveryId ?? request.job.deliveryId}`,
    workspaceSlug: mapping.workspaceSlug, authority }, () => completeCreatedPr(mappingWriterContext(ctx, mapping, authority), mapping, request));
}

async function completeCreatedPr(ctx: AppContext, mapping: Mapping, request: ReducerContinuation): Promise<void> {
  const p: any = request.job.payload;
  const item: LinkedItem = { ref: { identifier: `${request.identifier}-NEW`, project: request.identifier, sequence: 0, tier: "closing", source: "body" }, issueId: request.issueId, projectId: request.projectId, identifier: request.identifier };
  // Empty identifier denotes a later event fenced behind the create, rather than a new linkback.
  const now = await currentPrOf(ctx, mapping, p);
  await completeItems(ctx, mapping, request.job, now, [item], request.identifier ? [item] : [], async () => {
    if (readinessEvent(request.job)) await fireReadyForMerge(ctx, mapping, request.job, await ctx.ghClient.installationOctokit(await installationFor(ctx, mapping, p)), now.pr);
  });
}

export async function findLinkId(ctx: AppContext, t: RollupTarget, url: string): Promise<string | null> {
  const links = await ctx.planeClient.listAll<{ id: string; url: string }>(`${planeItemsPath(t.slug, t.projectId, t.issueId)}links/`);
  return links.find((l) => l.url === url)?.id ?? null;
}
