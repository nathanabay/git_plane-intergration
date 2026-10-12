// Build and deployment rollups (spec §7.4): check runs and deployments reach the work items of the PRs they belong to.
import { appendAudit } from "../db/ledgers.ts";
import { buildStatus, categorisedTitle, detectPreviews, upsertRollupLink } from "../sync/dev-info.ts";
import type { RollupTarget } from "../sync/dev-info.ts";
import type { InboundJob } from "../queue/index.ts";
import { actorTokenFor, installationFor } from "./context.ts";
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

async function putLink(ctx: AppContext, job: InboundJob, targets: RollupTarget[], key: string, link: { title: string; url: string }): Promise<void> {
  for (const t of targets) {
    try {
      await upsertRollupLink({ db: ctx.db, writer: ctx.plane, findLinkId: (x, url) => findLinkId(ctx, x, url) }, t, key, link);
    } catch (err) {
      await appendAudit(ctx.db, { kind: "rollup_link", source: "github", deliveryId: job.deliveryId, workspaceSlug: t.slug, detail: { issueId: t.issueId, key }, outcome: "failed", error: err instanceof Error ? err.message : String(err) });
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

/** Open PRs headed by `sha`: if any is now approved with every check green, its `ready_for_merge` rules run (F7). */
async function readiness(ctx: AppContext, job: InboundJob, mapping: Mapping, octokit: any, sha: unknown, relevant: boolean): Promise<void> {
  if (!relevant || typeof sha !== "string" || !sha) return;
  const res = await octokit.request("GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls", { owner: mapping.owner, repo: mapping.repo, commit_sha: sha });
  const prs: any[] = Array.isArray(res.data) ? res.data : [];
  for (const pr of prs) {
    if (pr?.head?.sha !== sha) continue; // only a PR whose head is this commit; a base-branch commit is not its readiness
    await fireReadyForMerge(ctx, mapping, job, octokit, pr);
  }
}

async function build(ctx: AppContext, job: InboundJob, mapping: Mapping, octokit: any, base: { owner: string; repo: string }): Promise<void> {
  const p: any = job.payload;
  const subject = p.check_run ?? p.check_suite;
  const sha: unknown = subject?.head_sha;
  const prs: any[] = Array.isArray(subject?.pull_requests) ? subject.pull_requests : [];
  if (typeof sha !== "string" || prs.length === 0) return;
  const res = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", { ...base, ref: sha, per_page: 100 });
  const status = buildStatus(Array.isArray(res.data?.check_runs) ? res.data.check_runs : []);
  const seen = new Set<number>(); // one PR listed twice must not run rules or write links twice
  for (const pr of prs) {
    if (!Number.isSafeInteger(pr?.number) || seen.has(pr.number)) continue;
    seen.add(pr.number);
    const targets = await linkedTargets(ctx, mapping, pr.number);
    await ruleRun(ctx, job, mapping, pr.number);
    await putLink(ctx, job, targets, `build:${mapping.ghRepoId}:${pr.number}`, {
      title: categorisedTitle("CI", `Build · ${status}`),
      url: `https://github.com/${mapping.ghRepoFullName}/pull/${pr.number}/checks`,
    });
  }
}

async function deployment(ctx: AppContext, job: InboundJob, mapping: Mapping, octokit: any, base: { owner: string; repo: string }): Promise<void> {
  const p: any = job.payload;
  const status = p.deployment_status;
  const sha: unknown = p.deployment?.sha;
  if (!status || typeof sha !== "string") return;
  const res = await octokit.request("GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls", { ...base, commit_sha: sha });
  const prs: any[] = Array.isArray(res.data) ? res.data : [];
  const env = String(status.environment ?? p.deployment?.environment ?? "deployment");
  const targetUrl = typeof status.environment_url === "string" && status.environment_url ? status.environment_url : status.target_url;
  const seen = new Set<number>();
  for (const pr of prs) {
    if (!Number.isSafeInteger(pr?.number) || seen.has(pr.number)) continue;
    seen.add(pr.number);
    const targets = await linkedTargets(ctx, mapping, pr.number);
    if (targets.length === 0) continue;
    await ruleRun(ctx, job, mapping, pr.number);
    await putLink(ctx, job, targets, `deploy:${mapping.ghRepoId}:${pr.number}:${env}`, {
      title: categorisedTitle("Deploy", `${env} · ${String(status.state)}`),
      url: typeof targetUrl === "string" && targetUrl ? targetUrl : `https://github.com/${mapping.ghRepoFullName}/pull/${pr.number}`,
    });
    if (status.state === "success") {
      const previews = detectPreviews({ environmentUrls: [status.environment_url, status.target_url].filter((u): u is string => typeof u === "string") });
      for (const pv of previews) await putLink(ctx, job, targets, `preview:${mapping.ghRepoId}:${pr.number}:${pv.name}`, { title: categorisedTitle("Preview", pv.name), url: pv.url });
    }
  }
}

/** §7.5: `check_suite.<conclusion>` and `deployment_status.<state>` rules over the items the PR links (F7). */
async function ruleRun(ctx: AppContext, job: InboundJob, mapping: Mapping, prNumber: number): Promise<void> {
  const event = githubRuleEvent(job.event, job.payload);
  if (!event) return;
  const issues = await linkedIssuesFor(ctx, mapping, "pr", prNumber);
  await runRules(ctx, mapping, event, issues, { deliveryId: job.deliveryId, actor: () => actorTokenFor(ctx, mapping, (job.payload as any)?.sender, event.trigger, job.payload) });
}
