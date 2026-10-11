// Two-way issue mirroring (spec §7.3) as the running service uses it.
import { appendAudit } from "../db/ledgers.ts";
import { onGithubIssue, onPlaneIssue } from "../sync/mirror.ts";
import type { MirrorDeps, MirrorMapping } from "../sync/mirror.ts";
import type { GithubWrite } from "../sync/github.ts";
import type { InboundJob } from "../queue/index.ts";
import { actorTokenFor, installationFor, mappedLogins, payloadBelongsToMapping, planeIssueUrl, usersFor, withObjectLock } from "./context.ts";
import type { AppContext } from "./context.ts";
import { mappingsForProject, mappingsForRepo } from "./mappings.ts";
import type { Mapping } from "./mappings.ts";
import { githubRuleEvent, planeRuleEvent } from "./rule-events.ts";
import { linkedIssuesFor, runRules } from "./rules.ts";
import type { ReducerContinuation } from "./writers.ts";

/**
 * The mirror asks for assignees to be added or removed; Plane→GitHub sync must make GitHub's list match Plane's
 * (§7.3). The difference is computed only over logins in the workspace user map: a GitHub assignee Plane cannot
 * represent is left alone (F5). An empty request therefore removes every mapped assignee and nothing else.
 */
export function assigneeSyncWriter(ctx: AppContext, workspaceSlug: string): MirrorDeps["github"] {
  return {
    // Optional writer methods this wrapper does not override (`plan`, ...) pass through unchanged: hiding `plan`
    // made Plane→GitHub mirror creates fall back to the inline path in production.
    ...(ctx.github.plan ? { plan: ctx.github.plan.bind(ctx.github) } : {}),
    async apply(write: GithubWrite) {
      if (write.kind === "remove_assignees") {
        const mapped = await mappedLogins(ctx.db, workspaceSlug);
        const assignees = write.assignees.filter((a) => mapped.has(a.toLowerCase()));
        return assignees.length ? ctx.github.apply({ ...write, assignees }) : { ok: true as const };
      }
      if (write.kind !== "add_assignees") return ctx.github.apply(write);
      // The ordered outbox takes the desired set (even []) before any read, so an earlier pending addition cannot
      // survive a later empty set; it diffs over mapped logins at execution time. Raw writers keep the diff below.
      if (ctx.github.setAssignees) return ctx.github.setAssignees(write, workspaceSlug);
      const octokit = await ctx.ghClient.installationOctokit(write.installationId);
      const res = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", { owner: write.owner, repo: write.repo, issue_number: write.number });
      const mapped = await mappedLogins(ctx.db, workspaceSlug);
      const current: string[] = (Array.isArray(res.data?.assignees) ? res.data.assignees : []).map((a: any) => String(a?.login));
      const wanted = new Set(write.assignees.map((a) => a.toLowerCase()));
      const have = new Set(current.map((a) => a.toLowerCase()));
      const remove = current.filter((a) => mapped.has(a.toLowerCase()) && !wanted.has(a.toLowerCase()));
      const add = write.assignees.filter((a) => !have.has(a.toLowerCase()));
      const { kind: _kind, assignees: _assignees, ...target } = write;
      if (remove.length) await ctx.github.apply({ ...target, kind: "remove_assignees", assignees: remove });
      if (add.length) await ctx.github.apply({ ...target, kind: "add_assignees", assignees: add });
      return { ok: true as const };
    },
  };
}

function mirrorDeps(ctx: AppContext, mapping: Mapping, installationId: number, createContinuation?: { job: InboundJob }): MirrorDeps {
  const m: MirrorMapping = { id: mapping.id, workspaceSlug: mapping.workspaceSlug, planeProjectId: mapping.planeProjectId, ghRepoId: mapping.ghRepoId, syncDirection: mapping.syncDirection, installationId, owner: mapping.owner, repo: mapping.repo };
  return {
    db: ctx.db,
    plane: ctx.plane,
    github: assigneeSyncWriter(ctx, mapping.workspaceSlug),
    mapping: m,
    users: usersFor(ctx.db, mapping.workspaceSlug),
    listStates: (projectId) => ctx.planeClient.listStates(mapping.workspaceSlug, projectId),
    labelNames: async (slug, projectId) => (await ctx.planeClient.listAll<any>(`/workspaces/${slug}/projects/${projectId}/labels/`))
      .filter((l) => typeof l?.id === "string" && typeof l?.name === "string").map((l) => ({ id: l.id as string, name: l.name as string })),
    planeIssueUrl: planeIssueUrl(ctx.config.PUBLIC_ORIGIN),
    // A mirror create finishes asynchronously: the issue.* rules for the new item run from a durable resume once its link exists.
    ...(createContinuation ? { createContinuation } : {}),
  };
}

/**
 * Continuation of a Plane item created by mirroring a GitHub issue (the plan's last step): the original delivery's
 * `issue.*` / `comment.*` rules for the new item only. They cannot run in the reducer, which returns before the item and
 * its link exist.
 */
export async function handleMirroredIssue(ctx: AppContext, request: ReducerContinuation): Promise<void> {
  const p: any = request.job.payload;
  const mapping = (await mappingsForRepo(ctx.db, Number(p?.repository?.id))).find((m) => m.id === request.mappingId);
  const event = githubRuleEvent(request.job.event, p);
  if (!mapping || !event) return;
  await runRules(ctx, mapping, event, [{ slug: mapping.workspaceSlug, projectId: request.projectId, issueId: request.issueId, tier: "closing" }], {
    deliveryId: request.job.deliveryId,
    actor: () => actorTokenFor(ctx, mapping, p.sender, event.trigger, p),
  });
}

/**
 * An issue event that arrived while its Plane partner was still being created was registered as a deferred action in the
 * create's own ordering group; now the partner exists. It replays through the normal reducer: the mirror's field sync (no
 * `createContinuation` — the partner already exists), then the event's rules for that one item.
 */
export async function handlePendingMirroredIssue(ctx: AppContext, request: ReducerContinuation): Promise<void> {
  if (request.job.source === "plane") return handlePendingPlaneEvent(ctx, request);
  const p: any = request.job.payload;
  const mapping = (await mappingsForRepo(ctx.db, Number(p?.repository?.id))).find((m) => m.id === request.mappingId);
  if (!mapping) return;
  const deps = mirrorDeps(ctx, mapping, await installationFor(ctx, mapping, p));
  await withObjectLock(ctx.db, `gh:${mapping.ghRepoId}#${p?.issue?.number}`, () => onGithubIssue(p, deps));
  const event = githubRuleEvent(request.job.event, p);
  if (!event) return;
  await runRules(ctx, mapping, event, [{ slug: mapping.workspaceSlug, projectId: request.projectId, issueId: request.issueId, tier: "closing" }], {
    deliveryId: request.job.deliveryId,
    actor: () => actorTokenFor(ctx, mapping, p.sender, event.trigger, p),
  });
}

/**
 * The Plane-origin counterpart (`issue` edit or `issue_comment`): the mapping is the one named by the continuation, and the delivery
 * must still come from that mapping's own workspace (F2). Plane's own rules already ran on the original delivery, so they are not
 * run again; only the mirror's GitHub-side write is replayed, without `createContinuation` (the partner exists now).
 */
async function handlePendingPlaneEvent(ctx: AppContext, request: ReducerContinuation): Promise<void> {
  const p: any = request.job.payload;
  const mapping = (await mappingsForProject(ctx.db, request.projectId)).find((m) => m.id === request.mappingId);
  if (!mapping || !(await payloadBelongsToMapping(ctx, mapping, p))) return;
  const deps = mirrorDeps(ctx, mapping, await planeInstallation(ctx, mapping));
  await withObjectLock(ctx.db, `plane:${request.issueId}`, () => onPlaneIssue({ event: request.job.event, payload: p }, deps));
}

const isUniqueViolation = (e: unknown) => (e as { code?: string } | null)?.code === "23505";

export async function handleGithubIssue(ctx: AppContext, job: InboundJob): Promise<void> {
  const p: any = job.payload;
  const repoId = Number(p?.repository?.id);
  const mappings = Number.isSafeInteger(repoId) ? await mappingsForRepo(ctx.db, repoId) : [];
  if (mappings.length === 0) {
    await appendAudit(ctx.db, { kind: job.event, source: "github", deliveryId: job.deliveryId, detail: { repoId: p?.repository?.id ?? null }, outcome: "unmapped_repo" });
    return;
  }
  for (const mapping of mappings) {
    const deps = mirrorDeps(ctx, mapping, await installationFor(ctx, mapping, p), { job });
    try {
      // One GitHub issue at a time, across replicas: the lock is what stops two `labeled` events creating two items.
      const mirrored = await withObjectLock(ctx.db, `gh:${repoId}#${p?.issue?.number}`, () => onGithubIssue(p, deps));
      // §7.5 `issue.*` / `comment.*` rules over the items this issue is linked to (F7). A create that went through the plan
      // finishes asynchronously and its `mirror_created` resume owns these rules for the new item (a `deferred` event, received while the partner was still being created, replays through `mirror_pending`); a fast worker may already have
      // linked it, so looking the links up here would run them a second time.
      const event = githubRuleEvent(job.event, p);
      const resumeOwnsRules = (mirrored.action === "created" && ctx.plane.plan !== undefined) || mirrored.action === "deferred";
      if (event && !resumeOwnsRules && Number.isSafeInteger(p?.issue?.number)) {
        await runRules(ctx, mapping, event, await linkedIssuesFor(ctx, mapping, p.issue.pull_request ? "pr" : "issue", p.issue.number), { deliveryId: job.deliveryId, actor: () => actorTokenFor(ctx, mapping, p.sender, event.trigger, p) });
      }
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      await appendAudit(ctx.db, { kind: "mirror_conflict", source: "github", deliveryId: job.deliveryId, workspaceSlug: mapping.workspaceSlug, detail: { repoId, number: p?.issue?.number }, outcome: "ignored", error: "another delivery already mirrored this issue" });
    }
  }
}

/** Plane events mirror nothing for an unmapped App, so "not installed" (404/403) is installation 0; anything else is transient and fails the delivery (F7). */
async function planeInstallation(ctx: AppContext, mapping: Mapping): Promise<number> {
  try {
    return await installationFor(ctx, mapping);
  } catch (err) {
    const status = (err as { status?: number } | null)?.status;
    if (status === 404 || status === 403) return 0;
    throw err;
  }
}

export async function handlePlaneIssue(ctx: AppContext, job: InboundJob): Promise<void> {
  const p: any = job.payload;
  const data = p?.data;
  const projectRef = job.event === "issue_comment" ? data?.project ?? data?.issue?.project : data?.project;
  const projectId = typeof projectRef === "string" ? projectRef : projectRef?.id;
  const candidates = typeof projectId === "string" ? await mappingsForProject(ctx.db, projectId) : [];
  // F2: the project id alone is not an authority — the delivery must come from the mapping's own workspace.
  const mappings: Mapping[] = [];
  for (const m of candidates) if (await payloadBelongsToMapping(ctx, m, p)) mappings.push(m);
  if (mappings.length === 0) {
    await appendAudit(ctx.db, { kind: job.event, source: "plane", deliveryId: job.deliveryId, detail: { projectId: projectId ?? null, candidates: candidates.length }, outcome: candidates.length ? "workspace_mismatch" : "unmapped_project" });
    return;
  }
  for (const mapping of mappings) {
    // Most Plane events mirror nothing, so an App that is simply not installed (404/403) must not fail them; a write that
    // needs it will say so. Any other failure (GitHub 5xx, network) is transient and fails the delivery so it retries (F7):
    // registering writes with installation 0 made them fail permanently on the first attempt.
    // `createContinuation` lets the mirror register this event behind a create that is still in flight (`mirror_pending`).
    const deps = mirrorDeps(ctx, mapping, await planeInstallation(ctx, mapping), { job });
    // A comment event's `data.id` is the comment's; the work item it belongs to is `data.issue`.
    const issueRef = typeof data?.issue === "string" ? data.issue : data?.issue?.id;
    const planeIssueId = job.event === "issue_comment" ? issueRef : typeof data?.id === "string" ? data.id : issueRef;
    try {
      await withObjectLock(ctx.db, `plane:${planeIssueId}`, () => onPlaneIssue({ event: job.event, payload: p }, deps));
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      await appendAudit(ctx.db, { kind: "mirror_conflict", source: "plane", deliveryId: job.deliveryId, workspaceSlug: mapping.workspaceSlug, detail: { projectId }, outcome: "ignored", error: "another delivery already mirrored this item" });
    }
    // §7.5 `issue.*` / `comment.*` rules on the Plane item itself (F7).
    const event = planeRuleEvent(job.event, p, mapping.planeProjectId, mapping.ghRepoFullName);
    if (event && typeof planeIssueId === "string") {
      await runRules(ctx, mapping, event, [{ slug: mapping.workspaceSlug, projectId: mapping.planeProjectId, issueId: planeIssueId, tier: "closing" }], { deliveryId: job.deliveryId, actor: async () => undefined, source: "plane" });
    }
  }
}
