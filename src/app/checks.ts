import { problemReportsEnabled, reportPlaneProblem } from "../github/problems.ts";
// Build and deployment rollups (spec §7.4): check runs and deployments reach the work items of the PRs they belong to.
import { classifyGithubError } from "../github/errors.ts";
import { githubRepositoryWebUrl, readGithubCollection } from "../github/pr-automation.ts";
import { appendAudit } from "../db/ledgers.ts";
import { buildStatus, categorisedTitle, detectPreviews, upsertRollupLink } from "../sync/dev-info.ts";
import type { RollupTarget } from "../sync/dev-info.ts";
import type { InboundJob } from "../queue/index.ts";
import { actorTokenFor, installationFor, withObjectLock } from "./context.ts";
import type { AppContext } from "./context.ts";
import { freezeMappingAuthority, mappingsForRepo } from "./mappings.ts";
import type { Mapping } from "./mappings.ts";
import { findLinkId, fireReadyForMerge } from "./pr.ts";
import { githubRuleEvent } from "./rule-events.ts";
import { linkedIssuesFor, runRules } from "./rules.ts";
import { deliveryScope } from "./writers.ts";

function mappingScope(mapping: Mapping, job: InboundJob) {
  const current = deliveryScope.getStore();
  return { ...current, deliveryId: current?.deliveryId ?? `github-${job.writeDeliveryId ?? job.deliveryId}`,
    workspaceSlug: mapping.workspaceSlug, authority: freezeMappingAuthority(mapping) };
}

async function linkedTargets(ctx: AppContext, mapping: Mapping, number: number): Promise<RollupTarget[]> {
  const { rows } = await ctx.db.query<{ plane_workspace_slug: string; plane_project_id: string; plane_issue_id: string }>(
    "SELECT DISTINCT plane_workspace_slug, plane_project_id, plane_issue_id FROM sync_links WHERE gh_repo_id = $1 AND gh_number = $2 AND gh_kind = 'pr' AND status = 'active' AND plane_workspace_slug = $3", [mapping.ghRepoId, number, mapping.workspaceSlug]);
  const authority = freezeMappingAuthority(mapping);
  return rows.map((r) => ({ slug: r.plane_workspace_slug, projectId: r.plane_project_id, issueId: r.plane_issue_id, _authority: authority }));
}

async function putLink(ctx: AppContext, job: InboundJob, targets: RollupTarget[], key: string, link: { title: string; url: string }, strict = false): Promise<void> {
  for (const t of targets) {
    try {
      await upsertRollupLink({ db: ctx.db, writer: ctx.plane, findLinkId: (x, url) => findLinkId(ctx, x, url) }, t, key, link);
    } catch (err) {
      await appendAudit(ctx.db, { kind: "rollup_link", source: "github", deliveryId: job.deliveryId, workspaceSlug: t.slug, detail: { issueId: t.issueId, key }, outcome: "failed", error: err instanceof Error ? err.message : String(err) });
      if (strict) throw err;
    }
  }
}

export async function handleChecks(ctx: AppContext, job: InboundJob): Promise<void> {
  const p: any = job.payload;
  const repoId = Number(p?.repository?.id);
  const mappings = Number.isSafeInteger(repoId) ? await mappingsForRepo(ctx.db, repoId) : [];
  if (mappings.length === 0) {
    await appendAudit(ctx.db, { kind: job.event, source: "github", deliveryId: job.deliveryId, detail: { repoId: p?.repository?.id ?? null }, outcome: "unmapped_repo" });
    return;
  }
  for (const mapping of mappings) {
    const installationId = await installationFor(ctx, mapping, p);
    await deliveryScope.run(mappingScope(mapping, job), async () => {
      const octokit = await ctx.ghClient.installationOctokit(installationId);
      const base = { owner: mapping.owner, repo: mapping.repo };
      if (job.event === "deployment_status") await deployment(ctx, job, mapping, octokit, base);
      else {
        await build(ctx, job, mapping, octokit, base);
        await readiness(ctx, job, mapping, octokit, (job.payload as any)?.check_run?.head_sha ?? (job.payload as any)?.check_suite?.head_sha, job.event === "check_suite" && (job.payload as any)?.action === "completed"); // not check_run: one suite completion is the readiness signal (F18)
      }
    });
  }
}

/** A commit status changed (GitHub `status` event): CI can have just made an approved PR ready (F7). */
export async function handleCommitStatus(ctx: AppContext, job: InboundJob): Promise<void> {
  const p: any = job.payload;
  const repoId = Number(p?.repository?.id);
  const mappings = Number.isSafeInteger(repoId) ? await mappingsForRepo(ctx.db, repoId) : [];
  if (mappings.length === 0) {
    await appendAudit(ctx.db, { kind: "status", source: "github", deliveryId: job.deliveryId, detail: { repoId: p?.repository?.id ?? null }, outcome: "unmapped_repo" });
    return;
  }
  for (const mapping of mappings) {
    const installationId = await installationFor(ctx, mapping, p);
    await deliveryScope.run(mappingScope(mapping, job), async () => {
      const octokit = await ctx.ghClient.installationOctokit(installationId);
      await readiness(ctx, job, mapping, octokit, p?.sha, p?.state === "success");
    });
  }
}

/** The association endpoint returns introducing PRs, not every open PR at this head. */
async function associatedPulls(octokit: any, base: { owner: string; repo: string }, sha: string): Promise<any[]> {
  const result = await readGithubCollection<any>(octokit, "GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls",
    { ...base, commit_sha: sha }, (data) => data);
  if (!result.complete) throw new Error("Incomplete GitHub commit/PR association read; retry the delivery");
  return result.items;
}

/** Resolve current PRs through the base repository's installation, verifying exact head and repository identity. */
async function currentPullsForSha(ctx: AppContext, mapping: Mapping, octokit: any, sha: string, delivered: any[] = [], headRepoId?: number): Promise<any[]> {
  const base = { owner: mapping.owner, repo: mapping.repo };
  const candidates = [...delivered, ...await associatedPulls(octokit, base, sha)];
  const linked = await ctx.db.query<{ gh_number: number }>(
    "SELECT DISTINCT gh_number FROM sync_links WHERE gh_repo_id = $1 AND gh_kind = 'pr' AND status = 'active' AND plane_workspace_slug = $2",
    [mapping.ghRepoId, mapping.workspaceSlug]);
  candidates.push(...linked.rows.map((row) => ({ number: row.gh_number })));
  const out: any[] = [];
  const seen = new Set<number>();
  for (const candidate of candidates) {
    if (!Number.isSafeInteger(candidate?.number) || seen.has(candidate.number)) continue;
    seen.add(candidate.number);
    let pr: any;
    try {
      pr = (await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { ...base, pull_number: candidate.number })).data;
    } catch (err) {
      const kind = classifyGithubError(err).kind;
      if (kind !== "permission" && kind !== "not_found") throw err;
      await appendAudit(ctx.db, { kind: "pr_association_unavailable", source: "github", workspaceSlug: mapping.workspaceSlug,
        detail: { repoId: mapping.ghRepoId, number: candidate.number, sha }, outcome: "ignored" });
      continue;
    }
    if (pr?.number !== candidate.number || pr?.head?.sha !== sha) continue;
    if (pr?.base?.repo?.id !== undefined && Number(pr.base.repo.id) !== mapping.ghRepoId) continue;
    if (pr?.base?.repo?.full_name !== undefined && String(pr.base.repo.full_name).toLowerCase() !== mapping.ghRepoFullName.toLowerCase()) continue;
    if (headRepoId !== undefined && Number(pr?.head?.repo?.id) !== headRepoId) continue;
    out.push(pr);
  }
  return out;
}

function checkHeadRepository(payload: any): number | undefined {
  const id = (payload?.check_suite ?? payload?.check_run?.check_suite)?.head_repository?.id;
  return typeof id === "number" && Number.isSafeInteger(id) ? id : undefined;
}

/** Open linked PRs whose current head is this exact SHA can become ready after CI. */
async function readiness(ctx: AppContext, job: InboundJob, mapping: Mapping, octokit: any, sha: unknown, relevant: boolean): Promise<void> {
  if (!relevant || typeof sha !== "string" || !sha) return;
  for (const pr of await currentPullsForSha(ctx, mapping, octokit, sha, [], checkHeadRepository(job.payload))) {
    if (pr.state !== "open" || pr.draft === true || pr.merged === true) continue;
    await fireReadyForMerge(ctx, mapping, job, octokit, pr);
  }
}

async function build(ctx: AppContext, job: InboundJob, mapping: Mapping, octokit: any, base: { owner: string; repo: string }): Promise<void> {
  const p: any = job.payload;
  const subject = p.check_run ?? p.check_suite;
  const sha: unknown = subject?.head_sha;
  if (typeof sha !== "string" || !sha) return;
  const prs = await currentPullsForSha(ctx, mapping, octokit, sha,
    Array.isArray(subject?.pull_requests) ? subject.pull_requests : [],
    checkHeadRepository(p));
  const withTargets: { pr: any; targets: RollupTarget[] }[] = [];
  for (const pr of prs) {
    const targets = await linkedTargets(ctx, mapping, pr.number);
    if (targets.length) withTargets.push({ pr, targets });
  }
  if (!withTargets.length) return;
  // GitHub's ref/check-runs endpoint hides suites older than the most recent 1,000.
  const suites = await readGithubCollection<any>(octokit, "GET /repos/{owner}/{repo}/commits/{ref}/check-suites",
    { ...base, ref: sha }, (data) => data?.check_suites, { maxPages: 11, total: (data) => data?.total_count });
  if (!suites.complete || suites.items.length > 1000) {
    await appendAudit(ctx.db, { kind: "build_incomplete", source: "github", deliveryId: job.deliveryId,
      workspaceSlug: mapping.workspaceSlug, detail: { repoId: mapping.ghRepoId, sha, reason: "check-suite limit" }, outcome: "partial" });
    throw new Error("Incomplete build aggregation: commit exceeds GitHub's 1,000-suite check-run limit");
  }
  const runs = await readGithubCollection<any>(octokit, "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
    { ...base, ref: sha, filter: "latest" }, (data) => data?.check_runs, { total: (data) => data?.total_count });
  if (!runs.complete) throw new Error("Incomplete GitHub check-run read; retry the delivery");
  const status = buildStatus(runs.items);
  const repoUrl = await githubRepositoryWebUrl(octokit, { ...base, id: mapping.ghRepoId }, p.repository, ctx.config.GITHUB_API_BASE_URL);
  for (const { pr, targets } of withTargets) {
    await ruleRun(ctx, job, mapping, pr.number, pr);
    await putLink(ctx, job, targets, `build:${mapping.ghRepoId}:${pr.number}`, {
      title: categorisedTitle("CI", `Build · ${status}`),
      url: `${repoUrl}/pull/${pr.number}/checks`,
    });
  }
}

interface DeploymentVersion {
  deploymentId: string | null; deploymentCreatedAt: number | null;
  statusId: string | null; statusCreatedAt: number | null;
}
const sourceId = (value: unknown): string | null => {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value <= 0)) return null;
  const text = String(value ?? "");
  return /^[1-9][0-9]*$/.test(text) ? text : null;
};
const createdAt = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

function deploymentVersion(payload: any): DeploymentVersion {
  const version = { deploymentId: sourceId(payload?.deployment?.id), deploymentCreatedAt: createdAt(payload?.deployment?.created_at),
    statusId: sourceId(payload?.deployment_status?.id), statusCreatedAt: createdAt(payload?.deployment_status?.created_at) };
  if ((version.deploymentId === null && version.deploymentCreatedAt === null) || (version.statusId === null && version.statusCreatedAt === null))
    throw new Error("Deployment status lacks immutable id/created_at ordering information");
  return version;
}

function compareSource(aId: string | null, aAt: number | null, bId: string | null, bAt: number | null): number | null {
  if (aId !== null && aId === bId) return 0;
  if (aAt !== null && bAt !== null && aAt !== bAt) return aAt > bAt ? 1 : -1;
  if (aId !== null && bId !== null) return BigInt(aId) > BigInt(bId) ? 1 : -1;
  if (aAt !== null && bAt !== null) return 0;
  return null; // Insufficient common ordering evidence fails closed.
}

/** A later status on an older deployment cannot displace a newer deployment for this environment. */
export function compareDeploymentVersions(a: DeploymentVersion, b: DeploymentVersion): number | null {
  const deployment = compareSource(a.deploymentId, a.deploymentCreatedAt, b.deploymentId, b.deploymentCreatedAt);
  if (deployment !== 0) return deployment;
  return compareSource(a.statusId, a.statusCreatedAt, b.statusId, b.statusCreatedAt);
}

const deploymentTails = new WeakMap<object, Map<string, Promise<void>>>();
async function withDeploymentLock<T>(ctx: AppContext, key: string, fn: () => Promise<T>): Promise<T> {
  let tails = deploymentTails.get(ctx.db);
  if (!tails) deploymentTails.set(ctx.db, tails = new Map());
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => turn);
  tails.set(key, tail);
  await previous;
  try { return await withObjectLock(ctx.db, key, fn); }
  finally { release(); if (tails.get(key) === tail) tails.delete(key); }
}

async function reserveDeploymentVersion(ctx: AppContext, job: InboundJob, mapping: Mapping, key: string, version: DeploymentVersion): Promise<boolean> {
  const previous = (await ctx.db.query<{ detail: { version: DeploymentVersion }; outcome: string }>(
    "SELECT detail, outcome FROM audit_log WHERE kind = 'deployment_rollup_version' AND workspace_slug = $1 AND detail->>'key' = $2 ORDER BY id DESC LIMIT 1",
    [mapping.workspaceSlug, key])).rows[0];
  const order = previous ? compareDeploymentVersions(version, previous.detail.version) : 1;
  if (previous && (order === null || order < 0 || (order === 0 && previous.outcome === "registered"))) {
    await appendAudit(ctx.db, { kind: "deployment_status_stale", source: "github", deliveryId: job.deliveryId,
      workspaceSlug: mapping.workspaceSlug, detail: { key, version, previous: previous.detail.version }, outcome: "ignored" });
    return false;
  }
  // Reserve before writes: partial registration/failure still fences older statuses.
  await appendAudit(ctx.db, { kind: "deployment_rollup_version", source: "github", deliveryId: job.deliveryId,
    workspaceSlug: mapping.workspaceSlug, detail: { key, version }, outcome: "pending" });
  return true;
}

async function deployment(ctx: AppContext, job: InboundJob, mapping: Mapping, octokit: any, base: { owner: string; repo: string }): Promise<void> {
  const p: any = job.payload;
  const status = p.deployment_status;
  const sha: unknown = p.deployment?.sha;
  if (!status || typeof sha !== "string") return;
  // Deployment association deliberately means the documented introducing/associated PRs, including merged PRs.
  const prs = await associatedPulls(octokit, base, sha);
  const repoUrl = await githubRepositoryWebUrl(octokit, { ...base, id: mapping.ghRepoId }, p.repository, ctx.config.GITHUB_API_BASE_URL);
  const env = String(status.environment ?? p.deployment?.environment ?? "deployment");
  const targetUrl = typeof status.environment_url === "string" && status.environment_url ? status.environment_url : status.target_url;
  const seen = new Set<number>();
  for (const pr of prs) {
    if (!Number.isSafeInteger(pr?.number) || seen.has(pr.number)) continue;
    seen.add(pr.number);
    const targets = await linkedTargets(ctx, mapping, pr.number);
    if (targets.length === 0) continue;
    const key = `deploy:${mapping.ghRepoId}:${pr.number}:${env}`;
    const version = deploymentVersion(p);
    // Preview keys span environments, so serialize all deployment rollups for this PR together.
    await withDeploymentLock(ctx, `deployment:${mapping.workspaceSlug}:${mapping.ghRepoId}:${pr.number}`, async () => {
      if (!await reserveDeploymentVersion(ctx, job, mapping, key, version)) return;
      // Status identity survives redelivery/replay; successful durable registration owns eventual execution.
      const scope = deliveryScope.getStore();
      await deliveryScope.run({ ...scope, deliveryId: `github-deployment:${mapping.workspaceSlug}:${key}:${version.deploymentId ?? version.deploymentCreatedAt}:${version.statusId ?? version.statusCreatedAt}`,
        occurrences: new Map(), seq: 0 }, async () => {
        await ruleRun(ctx, job, mapping, pr.number);
        await putLink(ctx, job, targets, key, {
          title: categorisedTitle("Deploy", `${env} · ${String(status.state)}`),
          url: typeof targetUrl === "string" && targetUrl ? targetUrl : `${repoUrl}/pull/${pr.number}`,
        }, true);
        if (status.state === "success") {
          const previews = detectPreviews({ environmentUrls: [status.environment_url, status.target_url].filter((u): u is string => typeof u === "string") });
          for (const pv of previews) {
            const previewKey = `preview:${mapping.ghRepoId}:${pr.number}:${pv.name}`;
            if (!await reserveDeploymentVersion(ctx, job, mapping, previewKey, version)) continue;
            await putLink(ctx, job, targets, previewKey, { title: categorisedTitle("Preview", pv.name), url: pv.url }, true);
            await appendAudit(ctx.db, { kind: "deployment_rollup_version", source: "github", deliveryId: job.deliveryId,
              workspaceSlug: mapping.workspaceSlug, detail: { key: previewKey, version }, outcome: "registered" });
          }
        }
        await appendAudit(ctx.db, { kind: "deployment_rollup_version", source: "github", deliveryId: job.deliveryId,
          workspaceSlug: mapping.workspaceSlug, detail: { key, version }, outcome: "registered" });
      });
    });
  }
}

/** §7.5: `check_suite.<conclusion>` and `deployment_status.<state>` rules over the items the PR links (F7). */
async function ruleRun(ctx: AppContext, job: InboundJob, mapping: Mapping, prNumber: number, pr?: any): Promise<void> {
  const event = githubRuleEvent(job.event, pr ? { ...(job.payload as any), pull_request: pr } : job.payload);
  if (!event) return;
  // Fork suite payloads omit head_branch and minimal PRs omit base/labels; use the verified current PR context.
  if (pr) {
    if (typeof pr.base?.ref === "string") event.base_branch = pr.base.ref;
    if (typeof pr.head?.ref === "string") event.head_branch = pr.head.ref;
    if (Array.isArray(pr.labels)) event.labels = pr.labels.map((label: any) => label?.name).filter((name: unknown): name is string => typeof name === "string");
    event.context = { ...event.context, pr: { number: pr.number, title: pr.title, url: pr.html_url, base: pr.base?.ref, branch: pr.head?.ref, author: pr.user?.login } };
  }
  const issues = await linkedIssuesFor(ctx, mapping, "pr", prNumber);
  const reportFailure = async () => {
    const failure = await ctx.db.query<{ detail: { issues?: unknown } }>("SELECT detail FROM audit_log WHERE kind = 'rule_match' AND outcome = 'failed' AND workspace_slug = $1 AND delivery_id = $2 AND detail->>'trigger' = $3",
      [mapping.workspaceSlug, job.deliveryId, event.trigger]);
    if (!failure.rows.length) return;
    const authority = freezeMappingAuthority(mapping);
    if (!await problemReportsEnabled(ctx.db, authority)) return;
    if (!ctx.plane.plan) throw new Error("problem reports require the durable Plane outbox");
    const failedIds = new Set(failure.rows.flatMap((row) => Array.isArray(row.detail?.issues) ? row.detail.issues.filter((id): id is string => typeof id === "string") : []));
    for (const issue of issues.filter((issue) => failedIds.has(issue.issueId))) await reportPlaneProblem({ enabled: true, authority, plan: ctx.plane.plan },
      { slug: issue.slug, projectId: issue.projectId, issueId: issue.issueId },
      { key: `${job.source}:${job.writeDeliveryId ?? job.deliveryId}:${event.trigger}:${prNumber}`,
        messages: [`Automation for ${event.trigger} could not complete. Check the sync audit log for details.`] });
  };
  try {
    await runRules(ctx, mapping, event, issues, { deliveryId: job.deliveryId, actor: () => actorTokenFor(ctx, mapping, (job.payload as any)?.sender, event.trigger, job.payload) });
  } catch (error) {
    try { await reportFailure(); }
    catch {
      // A notice failure must not erase the original retry classification/deadline.
      await appendAudit(ctx.db, { kind: "problem_report_registration", source: "github", deliveryId: job.deliveryId,
        workspaceSlug: mapping.workspaceSlug, detail: { trigger: event.trigger, number: prNumber }, outcome: "failed",
        error: "could not register the failure notice" }).catch(() => undefined);
    }
    throw error;
  }
  await reportFailure();
}
