import { problemReportsEnabled, reportGithubProblem, reportPlaneProblem } from "../github/problems.ts";
// Pushes (spec §7.1, §7.2, §7.4): Smart Commits, the "branch pushed" lifecycle rule, and the branch link.
import { appendAudit } from "../db/ledgers.ts";
import { MAX_RANGE_COMMITS, processPush } from "../github/smart-commits.ts";
import type { GithubCollection } from "../github/pr-automation.ts";
import type { PushCommit } from "../github/smart-commits.ts";
import { githubRepositoryWebUrl, pushToRuleEvent, readGithubCollection } from "../github/pr-automation.ts";
import type { LinkedIssue } from "../github/pr-automation.ts";
import { parseReferences, resolveReferences } from "../parse/references.ts";
import { categorisedTitle, upsertRollupLink } from "../sync/dev-info.ts";
import type { InboundJob } from "../queue/index.ts";
import { ensureLinkedByEmail } from "./identity.ts";
import { actorTokenFor, installationFor, issueResolver, loadMagicWords, projectOf, usersByGithubId } from "./context.ts";
import type { AppContext } from "./context.ts";
import { assertInstallationAllowed, freezeMappingAuthority, mappingsForRepo } from "./mappings.ts";
import type { Mapping } from "./mappings.ts";
import { findLinkId } from "./pr.ts";
import { runPushRules } from "./rules.ts";
import { deliveryScope } from "./writers.ts";

const ZERO_SHA = /^0+$/;

export async function handlePush(ctx: AppContext, job: InboundJob): Promise<void> {
  const p: any = job.payload;
  const repoId = Number(p?.repository?.id);
  const mappings = Number.isSafeInteger(repoId) ? await mappingsForRepo(ctx.db, repoId) : [];
  if (mappings.length === 0) {
    await appendAudit(ctx.db, { kind: "push", source: "github", deliveryId: job.deliveryId, detail: { repoId: p?.repository?.id ?? null }, outcome: "unmapped_repo" });
    return;
  }
  for (const mapping of mappings) {
    // Refresh and authorize before identity lookup can mutate the installation used by this delivery.
    await assertInstallationAllowed(ctx.db, await installationFor(ctx, mapping, p), mapping.workspaceSlug);
    const scope = deliveryScope.getStore();
    await deliveryScope.run({ ...scope, deliveryId: scope?.deliveryId ?? `github-${job.writeDeliveryId ?? job.deliveryId}`, workspaceSlug: mapping.workspaceSlug,
      authority: freezeMappingAuthority(mapping) }, async () => {
      await ensureLinkedByEmail(ctx, mapping, p.sender, p); // §9: an unmapped pusher may match a member by email
      await smartCommits(ctx, mapping, p);
      await branchPushed(ctx, mapping, job);
      await runPushRules(ctx, mapping, job);
    });
  }
}

async function smartCommits(ctx: AppContext, mapping: Mapping, payload: any): Promise<void> {
  const slug = mapping.workspaceSlug;
  if (!mapping.smartCommitsEnabled) return;
  const authority = freezeMappingAuthority(mapping);
  const reportProblems = await problemReportsEnabled(ctx.db, authority);
  await processPush(payload, {
    db: ctx.db,
    writer: ctx.plane,
    users: usersByGithubId(ctx.db, slug, payload?.sender), // F5: by the sender's id, never by a login someone else may hold now
    vault: ctx.vault,
    requireVerified: ctx.config.REQUIRE_VERIFIED_COMMITS,
    mapping: { workspaceSlug: slug, smartCommitsEnabled: mapping.smartCommitsEnabled, reportProblems },
    authority,
    reportProblem: async (problem) => {
      if (!ctx.github.plan) throw new Error("problem reports require the durable GitHub outbox");
      await reportGithubProblem({ enabled: reportProblems, authority, plan: ctx.github.plan }, { owner: mapping.owner, repo: mapping.repo,
        key: `smart-commit:${problem.sha}`, target: { kind: "commit", sha: problem.sha }, messages: problem.messages });
      if (problem.target) {
        if (!ctx.plane.plan) throw new Error("problem reports require the durable Plane outbox");
        await reportPlaneProblem({ enabled: reportProblems, authority, plan: ctx.plane.plan },
          { slug, ...problem.target }, { key: problem.key, messages: problem.targetMessages ?? problem.messages });
      }
    },
    listStates: (projectId) => ctx.planeClient.listStates(slug, projectId),
    resolveIssue: issueResolver(ctx, slug),
    listCommitRange: (before, after) => listCommitRange(ctx, mapping, payload, before, after),
    getCommitVerified: async (sha) => {
      const octokit = await ctx.ghClient.installationOctokit(await installationFor(ctx, mapping, payload));
      const res = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", { owner: mapping.owner, repo: mapping.repo, ref: sha });
      return res.data?.commit?.verification?.verified === true;
    },
  });
}

/** Webhooks carry at most 2,048 commits; paginated compare returns at most 100 per page, chronologically. */
export async function listCommitRange(ctx: AppContext, mapping: Mapping, payload: unknown, before: string, after: string): Promise<GithubCollection<PushCommit>> {
  const octokit = await ctx.ghClient.installationOctokit(await installationFor(ctx, mapping, payload));
  const result = await readGithubCollection<any>(octokit, "GET /repos/{owner}/{repo}/compare/{basehead}",
    { owner: mapping.owner, repo: mapping.repo, basehead: `${before}...${after}` }, (data) => data?.commits,
    { maxPages: MAX_RANGE_COMMITS / 100, total: (data) => data?.total_commits });
  const seen = new Set<string>();
  const items: PushCommit[] = [];
  for (const c of result.items) {
    if (typeof c?.sha !== "string" || seen.has(c.sha)) continue;
    seen.add(c.sha);
    items.push({ id: c.sha, message: String(c.commit?.message ?? ""), ...(typeof c.html_url === "string" ? { url: c.html_url } : {}) });
  }
  return { ...result, items };
}

/** A newly created branch whose name carries a key: the "branch pushed" rule, and a branch link on the item. */
async function branchPushed(ctx: AppContext, mapping: Mapping, job: InboundJob): Promise<void> {
  const p: any = job.payload;
  const event = pushToRuleEvent(p);
  if (!event || !event.head_branch) return;
  if (p.created !== true && !(typeof p.before === "string" && ZERO_SHA.test(p.before))) return;
  const slug = mapping.workspaceSlug;
  const parsed = parseReferences({ branch: event.head_branch }, await loadMagicWords(ctx.db));
  const { found } = await resolveReferences(ctx.planeClient, slug, parsed.refs);
  const issues: LinkedIssue[] = [];
  for (const { ref, issue } of found) {
    const projectId = projectOf(issue);
    if (issue?.id && projectId) issues.push({ slug, projectId, issueId: String(issue.id), tier: ref.tier });
  }
  if (issues.length === 0) return;
  const octokit = await ctx.ghClient.installationOctokit(await installationFor(ctx, mapping, p));
  const repoUrl = await githubRepositoryWebUrl(octokit, { owner: mapping.owner, repo: mapping.repo, id: mapping.ghRepoId }, p.repository, ctx.config.GITHUB_API_BASE_URL);
  const url = `${repoUrl}/tree/${encodeURIComponent(event.head_branch).replace(/%2F/g, "/")}`;
  for (const i of issues) {
    const target = { slug, projectId: i.projectId, issueId: i.issueId };
    try {
      await upsertRollupLink({ db: ctx.db, writer: ctx.plane, findLinkId: (t, u) => findLinkId(ctx, t, u) }, target, `branch:${mapping.ghRepoId}:${event.head_branch}`, { title: categorisedTitle("Branch", event.head_branch), url });
    } catch (err) {
      await appendAudit(ctx.db, { kind: "rollup_link", source: "github", deliveryId: job.deliveryId, workspaceSlug: slug, detail: { issueId: i.issueId, branch: event.head_branch }, outcome: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  }
}
