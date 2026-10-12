// Pushes (spec §7.1, §7.2, §7.4): Smart Commits, the "branch pushed" lifecycle rule, and the branch link.
import { appendAudit } from "../db/ledgers.ts";
import { processPush } from "../github/smart-commits.ts";
import type { PushCommit } from "../github/smart-commits.ts";
import { pushToRuleEvent } from "../github/pr-automation.ts";
import type { LinkedIssue } from "../github/pr-automation.ts";
import { parseReferences, resolveReferences } from "../parse/references.ts";
import { categorisedTitle, upsertRollupLink } from "../sync/dev-info.ts";
import type { InboundJob } from "../queue/index.ts";
import { ensureLinkedByEmail } from "./identity.ts";
import { actorTokenFor, installationFor, issueResolver, loadMagicWords, projectOf, usersByGithubId } from "./context.ts";
import type { AppContext } from "./context.ts";
import { freezeMappingAuthority, mappingsForRepo } from "./mappings.ts";
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
    // Every intent this mapping's push registers carries its frozen authority (review-6 F2): the mapping's own
    // verified installation, never the payload's, so a later edit or revocation cannot be bypassed.
    const scope = deliveryScope.getStore();
    await deliveryScope.run({ ...scope, deliveryId: scope?.deliveryId ?? `github-${job.deliveryId}`, workspaceSlug: mapping.workspaceSlug,
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
  await processPush(payload, {
    db: ctx.db,
    writer: ctx.plane,
    users: usersByGithubId(ctx.db, slug, payload?.sender), // F5: by the sender's id, never by a login someone else may hold now
    vault: ctx.vault,
    requireVerified: ctx.config.REQUIRE_VERIFIED_COMMITS,
    mapping: { workspaceSlug: slug, smartCommitsEnabled: mapping.smartCommitsEnabled },
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

/** F14: every commit of a push of more than 20 (GitHub truncates `commits`), from the compare API, oldest first. */
async function listCommitRange(ctx: AppContext, mapping: Mapping, payload: unknown, before: string, after: string): Promise<PushCommit[]> {
  const octokit = await ctx.ghClient.installationOctokit(await installationFor(ctx, mapping, payload));
  const out: PushCommit[] = [];
  for (let page = 1; page <= 30; page++) { // compare returns at most 250 commits per page
    const res = await octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", { owner: mapping.owner, repo: mapping.repo, basehead: `${before}...${after}`, per_page: 100, page });
    const commits: any[] = Array.isArray(res.data?.commits) ? res.data.commits : [];
    for (const c of commits) if (typeof c?.sha === "string") out.push({ id: c.sha, message: String(c.commit?.message ?? ""), ...(typeof c.html_url === "string" ? { url: c.html_url } : {}) });
    if (commits.length < 100) break;
  }
  return out;
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
  const url = `https://github.com/${mapping.ghRepoFullName}/tree/${encodeURIComponent(event.head_branch).replace(/%2F/g, "/")}`;
  for (const i of issues) {
    const target = { slug, projectId: i.projectId, issueId: i.issueId };
    try {
      await upsertRollupLink({ db: ctx.db, writer: ctx.plane, findLinkId: (t, u) => findLinkId(ctx, t, u) }, target, `branch:${mapping.ghRepoId}:${event.head_branch}`, { title: categorisedTitle("Branch", event.head_branch), url });
    } catch (err) {
      await appendAudit(ctx.db, { kind: "rollup_link", source: "github", deliveryId: job.deliveryId, workspaceSlug: slug, detail: { issueId: i.issueId, branch: event.head_branch }, outcome: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  }
}
