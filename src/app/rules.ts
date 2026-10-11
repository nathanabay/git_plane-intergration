// Runs the mapping's lifecycle rules (spec §7.1, §7.5) over the work items an event touches. The engine
// in src/rules decides; this file only supplies its inputs and its executor, and audits the outcome.
import type { SecretString } from "../auth/identity.ts";
import { appendAudit } from "../db/ledgers.ts";
import { QLL_DEFAULTS, compileLifecycleRules, createRuleExecutor } from "../github/pr-automation.ts";
import type { ExecutorDeps, LinkedIssue } from "../github/pr-automation.ts";
import { evaluate, parseRules, run } from "../rules/engine.ts";
import type { RuleEvent } from "../rules/types.ts";
import { parseReferences, resolveReferences } from "../parse/references.ts";
import { tierRank } from "../parse/magicWords.ts";
import type { InboundJob } from "../queue/index.ts";
import { PlaneApiError } from "../sync/plane.ts";
import { actorTokenFor, installationFor, loadMagicWords, projectOf, usersFor } from "./context.ts";
import type { AppContext } from "./context.ts";
import type { Mapping } from "./mappings.ts";
import { ruleEventsFor } from "./rule-events.ts";

/** The mapping's newest compiled rule set, or the shipping defaults when none was saved yet. */
export async function rulesYamlFor(ctx: AppContext, mapping: Mapping): Promise<string> {
  const { rows } = await ctx.db.query<{ yaml_source: string }>("SELECT yaml_source FROM rule_sets WHERE mapping_id = $1 ORDER BY version DESC LIMIT 1", [mapping.id]);
  return rows[0]?.yaml_source ?? compileLifecycleRules(QLL_DEFAULTS);
}

/** A configuration problem will fail the same way on every retry; a network or 5xx problem may not. */
export function isPermanent(err: unknown): boolean {
  if (err instanceof PlaneApiError) return err.status >= 400 && err.status < 500 && err.status !== 429;
  const name = (err as { name?: string } | null)?.name;
  if (name === "TriageWriteRejected") return true;
  return err instanceof Error && /does not exist|is ambiguous|unknown Plane state|must be|rule|YAML/i.test(err.message);
}

const idsOf = (v: unknown): string[] => (Array.isArray(v) ? v.map((x: any) => (typeof x === "string" ? x : x?.id)).filter((x: unknown): x is string => typeof x === "string") : []);

/** One target per work item, retaining the strongest reference tier. */
function uniqueIssues(issues: LinkedIssue[]): LinkedIssue[] {
  const unique = new Map<string, LinkedIssue>();
  for (const issue of issues) {
    const key = `${issue.slug}/${issue.projectId}/${issue.issueId}`;
    const previous = unique.get(key);
    if (!previous || tierRank(issue.tier ?? "closing") > tierRank(previous.tier ?? "closing")) unique.set(key, issue);
  }
  return [...unique.values()];
}

export async function runRules(ctx: AppContext, mapping: Mapping, event: RuleEvent, issues: LinkedIssue[], opts: {
  actor: () => Promise<SecretString | undefined>;
  deliveryId: string;
  source?: "github" | "plane";
}): Promise<void> {
  issues = uniqueIssues(issues.filter((issue) => issue.slug === mapping.workspaceSlug));
  if (issues.length === 0) return;
  event = { ...event, repo: event.repo ?? mapping.ghRepoFullName, project: event.project ?? mapping.planeProjectId };
  const rules = parseRules(await rulesYamlFor(ctx, mapping));
  const evaluation = evaluate(rules, event);
  if (!evaluation.matched) return;

  const slug = mapping.workspaceSlug;
  const users = usersFor(ctx.db, slug);
  const actorToken = await opts.actor();
  // A rule whose executor skipped every target (relation tier, non-closing merge, unmapped assignee) wrote nothing: audit it `ignored`, not `applied`.
  let writes = 0;
  const writer: ExecutorDeps["writer"] = {
    apply: (...args: Parameters<typeof ctx.plane.apply>) => { writes++; return ctx.plane.apply(...args); },
    ...(ctx.plane.mutateIssue ? { mutateIssue: (...args: Parameters<NonNullable<typeof ctx.plane.mutateIssue>>) => { writes++; return ctx.plane.mutateIssue!(...args); } } : {}),
  };
  const executor = createRuleExecutor({
    writer,
    listStates: (projectId) => ctx.planeClient.listStates(slug, projectId),
    issues,
    slug,
    ...(actorToken ? { actorToken } : {}),
    getIssueFields: async (issue) => {
      const current: any = await ctx.planeClient.getIssue(issue.slug, issue.projectId, issue.issueId);
      return { labels: idsOf(current?.labels ?? current?.label_ids), assignees: idsOf(current?.assignees ?? current?.assignee_ids) };
    },
    resolveAssignee: async (who) => users.planeUserIdForGithubLogin(who),
  });
  const detail = { trigger: event.trigger, rule: evaluation.matched.rule.name ?? null, index: evaluation.matched.index, actions: evaluation.actions, issues: issues.map((i) => i.issueId) };
  try {
    await run(rules, event, executor, { dryRun: false });
  } catch (err) {
    await appendAudit(ctx.db, { kind: "rule_match", source: opts.source ?? "github", deliveryId: opts.deliveryId, workspaceSlug: slug, detail, outcome: "failed", error: err instanceof Error ? err.message : String(err) });
    if (isPermanent(err)) return; // recorded; retrying cannot change the outcome
    throw err;
  }
  await appendAudit(ctx.db, { kind: "rule_match", source: opts.source ?? "github", deliveryId: opts.deliveryId, workspaceSlug: slug, detail, outcome: writes === 0 && evaluation.actions.length > 0 ? "ignored" : "applied" });
}

/**
 * The work items linked to a GitHub object (a PR or an issue), as rule targets. A link made by the `plane` label
 * is an explicit two-way opt-in, so for rule purposes it counts as closing; other links keep their §6 tier.
 */
export async function linkedIssuesFor(ctx: AppContext, mapping: Mapping, kind: "pr" | "issue", number: number): Promise<LinkedIssue[]> {
  const { rows } = await ctx.db.query<{ plane_workspace_slug: string; plane_project_id: string; plane_issue_id: string; tier: LinkedIssue["tier"]; created_by: string }>(
    "SELECT plane_workspace_slug, plane_project_id, plane_issue_id, tier, created_by FROM sync_links WHERE gh_repo_id = $1 AND gh_number = $2 AND gh_kind = $3 AND status = 'active' AND plane_workspace_slug = $4 AND plane_project_id = $5",
    [mapping.ghRepoId, number, kind, mapping.workspaceSlug, mapping.planeProjectId]);
  return uniqueIssues(rows.map((r) => ({ slug: r.plane_workspace_slug, projectId: r.plane_project_id, issueId: r.plane_issue_id, tier: r.created_by === "label_sync" ? "closing" : r.tier })));
}

/** Branch lifecycle targets its own active work; general push rules retain commit/PR references. */
export async function runPushRules(ctx: AppContext, mapping: Mapping, job: InboundJob): Promise<void> {
  const p: any = job.payload;
  const events = ruleEventsFor("github", "push", p);
  if (!events.length) return;
  const defaultPush = events.some((event) => event.trigger === "commit.pushed_to_default");
  // Avoid asking GitHub for associated PRs when this mapping has no applicable push rule.
  const rules = parseRules(await rulesYamlFor(ctx, mapping));
  const applicable = events.filter((event) => evaluate(rules, { ...event, project: mapping.planeProjectId }).matched);
  if (!applicable.length) return;
  const lifecycle = applicable.some((event) => event.trigger === "branch.created");
  const generalPush = applicable.some((event) => event.trigger !== "branch.created");
  const branch = defaultPush ? undefined : events[0]?.head_branch;
  const ownBranch = typeof branch === "string" && !/^revert-/i.test(branch);
  const commits: any[] = Array.isArray(p?.commits) ? p.commits : [];
  const messages = commits.map((c) => typeof c?.message === "string" ? c.message : "").filter(Boolean);
  const parsed = parseReferences({ ...(generalPush || (lifecycle && ownBranch) ? { branch } : {}),
    ...(generalPush ? { commits: messages } : {}),
  }, await loadMagicWords(ctx.db));
  const { found, unknown, statuses } = await resolveReferences(ctx.planeClient, mapping.workspaceSlug, parsed.refs);
  if (unknown.length) await appendAudit(ctx.db, { kind: "reference_unresolved", source: "github", deliveryId: job.deliveryId, workspaceSlug: mapping.workspaceSlug,
    detail: { repoId: mapping.ghRepoId, identifiers: unknown.map((r) => r.identifier), statuses }, outcome: "ignored" });
  const issues: LinkedIssue[] = [];
  const branchIssues: LinkedIssue[] = [];
  let stateGroups: Map<string, string> | undefined;
  for (const { issue, ref } of found) {
    const projectId = projectOf(issue);
    if (typeof issue?.id !== "string" || projectId !== mapping.planeProjectId) continue;
    const target = { slug: mapping.workspaceSlug, projectId, issueId: issue.id, tier: ref.tier };
    issues.push(target);
    if (!lifecycle || !ownBranch || ref.source !== "branch") continue;
    stateGroups ??= new Map((await ctx.planeClient.listStates(mapping.workspaceSlug, projectId)).map((s) => [s.id, s.group.toLowerCase()]));
    const state = issue.state ?? issue.state_id;
    const group = stateGroups.get(typeof state === "string" ? state : state?.id);
    // Branch creation starts active work; it cannot reopen terminal work or guess a missing state.
    if (group && group !== "completed" && group !== "cancelled") branchIssues.push(target);
  }
  const firstPush = p?.created === true || (typeof p?.before === "string" && /^0{40}$/.test(p.before));
  // A branch creation's tips can belong to merged PRs in its base history. Even on later pushes,
  // only the supplied introduced commits are association candidates, never an unrelated head tip.
  const needsAssociations = !firstPush && !defaultPush && generalPush;
  const shas = new Set<string>((needsAssociations ? commits.map((c) => c?.id) : []).filter((s): s is string => typeof s === "string" && /^[a-f0-9]{40}$/i.test(s) && !/^0+$/.test(s)));
  const numbers = new Set<number>();
  if (shas.size) {
    const octokit = await ctx.ghClient.installationOctokit(await installationFor(ctx, mapping, p));
    for (const sha of shas) {
      for (let page = 1; ; page++) {
        const res = await octokit.request("GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls", { owner: mapping.owner, repo: mapping.repo, commit_sha: sha, per_page: 100, page });
        const prs: any[] = Array.isArray(res.data) ? res.data : [];
        for (const pr of prs) {
          const headRepo = pr?.head?.repo;
          const headRepoId = Number(headRepo?.id);
          const sameRepo = Number.isSafeInteger(headRepoId) ? headRepoId === mapping.ghRepoId
            : typeof headRepo?.full_name === "string" && headRepo.full_name.toLowerCase() === mapping.ghRepoFullName.toLowerCase();
          if (Number.isSafeInteger(pr?.number) && pr?.head?.ref === events[0]?.head_branch && sameRepo) numbers.add(pr.number);
        }
        if (prs.length < 100) break;
        if (page >= 50) throw new Error("associated pull request pagination limit reached");
      }
    }
  }
  for (const number of numbers) issues.push(...await linkedIssuesFor(ctx, mapping, "pr", number));
  let actor: Promise<SecretString | undefined> | undefined;
  for (const event of events) await runRules(ctx, mapping, event, event.trigger === "branch.created" ? branchIssues : issues, { deliveryId: job.deliveryId,
    actor: () => actor ??= actorTokenFor(ctx, mapping, p?.sender, event.trigger, p) });
}
