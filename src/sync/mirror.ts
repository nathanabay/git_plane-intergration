// Two-way issue mirroring (spec §7.3). Opt-in by label: `plane` on a GitHub issue creates a Plane
// work item, `github` on a Plane item creates a GitHub issue. Per field, the mapping's conflict
// policy and direction decide whether a change from one side is applied to the other. Every write
// goes through A4's write paths, which own echo suppression and the triage ban.
import { createHash } from "node:crypto";
import { resultRef, resultText } from "../operations/plans.ts";
import type { PlanWriter, OutboxPlanStep } from "../operations/plans.ts";
import type { InboundJob } from "../queue/index.ts";
import type { SecretString } from "../auth/identity.ts";
import type { Db } from "../db/migrate.ts";
import { appendAudit, upsertSyncLink } from "../db/ledgers.ts";
import { escapeHtml, htmlToText, safeUrl, textToHtml } from "../github/html.ts";
import { resolveStateTarget } from "../github/pr-automation.ts";
import type { StateRef } from "../github/pr-automation.ts";
import { CONFLICT_FIELDS, DEFAULT_CONFLICT_POLICIES } from "../ui/validate.ts";
import type { ConflictField, ConflictPolicy, SyncDirection } from "../ui/validate.ts";
import type { GithubWrite } from "./github.ts";
import type { PlaneWrite, PlaneWriteResult } from "./plane.ts";

export type Side = "github" | "plane";
export type MirrorField = ConflictField;

/** Label on a GitHub issue that opts it into Plane, and label on a Plane item that opts it into GitHub. */
export const GATE_LABELS = { onGithub: "plane", onPlane: "github" } as const;

export function defaultPolicy(field: MirrorField): ConflictPolicy {
  return DEFAULT_CONFLICT_POLICIES[field];
}

/** Whether a change to `field` that arrived from `from` may be written to the other side. */
export function shouldApply(input: { field: MirrorField; from: Side; policy: ConflictPolicy; direction: SyncDirection }): boolean {
  // github_to_plane: GitHub is authoritative, so nothing from Plane is ever applied.
  if (input.direction === "github_to_plane" && input.from === "plane") return false;
  switch (input.policy) {
    case "last_write_wins": return true; // events arrive in order, so the latest applied change wins
    case "source_of_truth:github": return input.from === "github";
    case "source_of_truth:plane": return input.from === "plane";
  }
}

export interface MirrorMapping {
  id: number;
  workspaceSlug: string;
  planeProjectId: string;
  ghRepoId: number;
  syncDirection: SyncDirection;
  installationId: number;
  owner: string;
  repo: string;
}

export interface MirrorDeps {
  /** Original source event for target-specific issue rules once the new partner exists. */
  createContinuation?: { job: InboundJob };
  db: Db;
  plane: { plan?: PlanWriter; apply(write: PlaneWrite, opts?: { actorToken?: SecretString }): Promise<PlaneWriteResult> };
  github: { plan?: PlanWriter; apply(write: GithubWrite): Promise<{ ok: true; id?: number; number?: number }> };
  mapping: MirrorMapping;
  users: {
    planeUserIdForGithubLogin(login: string): Promise<string | null>;
    githubLoginForPlaneUserId?(planeUserId: string): Promise<string | null>;
  };
  /** Needed to map open/closed onto Plane states; without it state changes are reported, not applied. */
  listStates?(projectId: string): Promise<StateRef[]>;
  planeIssueUrl?(slug: string, projectId: string, issueId: string): string;
  /**
   * The project's labels (`GET …/projects/{pid}/labels/`). Plane's label activity carries label UUIDs, and a
   * removed label is no longer in the webhook's expanded `data.labels`, so ids are resolved here when needed.
   */
  labelNames?(slug: string, projectId: string): Promise<{ id: string; name: string }[]>;
}

export interface MirrorResult { action: "created" | "updated" | "ignored" | "deferred"; reason?: string; fields?: MirrorField[] }
const ignored = (reason: string): MirrorResult => ({ action: "ignored", reason });

/** Keep later source events behind the create's reducer fence, including when its link already exists. */
async function deferPendingMirror(deps: MirrorDeps, key: string, side: "plane" | "github", issueId: string | ReturnType<typeof resultRef>): Promise<boolean> {
  const plan = side === "plane" ? deps.plane.plan : deps.github.plan;
  if (!plan || !deps.createContinuation) return false;
  const pending = (await deps.db.query<{ outbox_id: string; link: Record<string, unknown>; created_id: string; fence_id: string }>(`SELECT p.outbox_id, p.link,
    (SELECT w.id FROM outbound_writes w WHERE w.write->'_plan'->>'root' = p.outbox_id
      AND w.write->>'kind' = 'create_issue' AND w.side = $2 ORDER BY sequence LIMIT 1) AS created_id,
    (SELECT w.id FROM outbound_writes w WHERE w.write->'_plan'->>'root' = p.outbox_id ORDER BY sequence DESC LIMIT 1) AS fence_id
    FROM pending_sync_links p WHERE p.key = $1
      AND NOT EXISTS (SELECT 1 FROM outbound_writes w
        WHERE w.write->'_plan'->>'root' = p.outbox_id AND w.status = 'failed')`, [key, side])).rows[0];
  if (!pending) return false;
  if (!pending.created_id || !pending.fence_id) throw new Error("pending mirror has no create or continuation fence");
  const job = deps.createContinuation.job, m = deps.mapping;
  const registered = await plan(`mirror-event:${key}:${job.source}:${job.writeDeliveryId ?? job.deliveryId}`, [
    { kind: "write", side, write: { kind: "resume_reducer", continuation: { kind: "mirror_pending", job,
      mappingId: m.id, projectId: m.planeProjectId, issueId, identifier: "pending mirror event" } } },
  ], { groupRoot: pending.outbox_id, bindings: { partner: pending.created_id }, predecessor: pending.fence_id,
    pendingMarker: { key, root: pending.outbox_id, link: pending.link } });
  // Legacy plan adapters acknowledge insertion without returning the newer flag.
  return (registered.inserted ?? true) === true;
}

/** Shared with PR creates: a generation's root must match the outbox's deterministic key hash. */
export const createPlanRoot = (key: string): string => `plan-${createHash("sha256").update(key).digest("hex")}`;

/** Called after checking for an active link. Finished creates get a new identity, under one stable barrier. */
export async function nextCreateGeneration(db: Db, key: string): Promise<string | null> {
  const live = await db.query(`SELECT 1 FROM pending_sync_links p WHERE p.key = $1
    AND NOT EXISTS (SELECT 1 FROM outbound_writes w
      WHERE w.write->'_plan'->>'root' = p.outbox_id AND w.status = 'failed')`, [key]);
  if (live.rows.length) return null;
  const last = (await db.query<{ sequence: string | number; pending: boolean; failed: boolean }>(`SELECT r.sequence,
    EXISTS (SELECT 1 FROM outbound_writes w
      WHERE w.write->'_plan'->>'root' = COALESCE(r.write->'_plan'->>'root', r.id) AND w.status = 'pending') AS pending,
    EXISTS (SELECT 1 FROM outbound_writes w
      WHERE w.write->'_plan'->>'root' = COALESCE(r.write->'_plan'->>'root', r.id) AND w.status = 'failed') AS failed
    FROM outbound_writes r WHERE r.id = $1 OR r.write->'_plan'->'after' @> $2::jsonb
    ORDER BY r.sequence DESC LIMIT 1`, [createPlanRoot(key), JSON.stringify([{ kind: "clear_pending_link", key }])])).rows[0];
  if (!last) return key;
  if (last.pending && !last.failed) return null;
  // A later retained marker step also identifies the generation if retention pruned its root first.
  return `${key}:generation:${last.sequence}`;
}

async function loadPolicies(db: Db, mappingId: number): Promise<Record<ConflictField, ConflictPolicy>> {
  const out = { ...DEFAULT_CONFLICT_POLICIES };
  const { rows } = await db.query<{ field: string; policy: ConflictPolicy }>(`SELECT field, policy FROM conflict_policies WHERE mapping_id = $1`, [mappingId]);
  for (const r of rows) if ((CONFLICT_FIELDS as readonly string[]).includes(r.field)) out[r.field as ConflictField] = r.policy;
  return out;
}

// Only links made by the opt-in label (§7.3) are mirror partners. Links from magic words, branches or a
// backfill merely reference a work item; treating them as partners would rename and close it.
interface Link { plane_workspace_slug: string; plane_project_id: string; plane_issue_id: string; gh_number: number }

async function findLinkByGithub(db: Db, m: MirrorMapping, number: number): Promise<Link | null> {
  const { rows } = await db.query<Link>(
    `SELECT plane_workspace_slug, plane_project_id, plane_issue_id, gh_number FROM sync_links
      WHERE gh_repo_id = $1 AND gh_number = $2 AND gh_kind = 'issue' AND status = 'active' AND plane_project_id = $3
        AND created_by = 'label_sync' LIMIT 1`,
    [m.ghRepoId, number, m.planeProjectId]);
  return rows[0] ?? null;
}

async function findLinkByPlane(db: Db, m: MirrorMapping, planeIssueId: string): Promise<Link | null> {
  const { rows } = await db.query<Link>(
    `SELECT plane_workspace_slug, plane_project_id, plane_issue_id, gh_number FROM sync_links
      WHERE plane_issue_id = $1 AND gh_repo_id = $2 AND gh_kind = 'issue' AND status = 'active' AND created_by = 'label_sync' LIMIT 1`,
    [planeIssueId, m.ghRepoId]);
  return rows[0] ?? null;
}

const labelNames = (labels: unknown): string[] =>
  Array.isArray(labels) ? labels.map((l: any) => (typeof l === "string" ? l : l?.name)).filter((n: unknown): n is string => typeof n === "string") : [];

const lc = (s: string) => s.toLowerCase();

// ---- GitHub → Plane ----------------------------------------------------------------------------------
export async function onGithubIssue(payload: any, deps: MirrorDeps): Promise<MirrorResult> {
  const { db, mapping } = deps;
  const issue = payload?.issue;
  if (!issue || !Number.isSafeInteger(issue.number)) return ignored("no issue in payload");
  if (issue.pull_request) return ignored("pull requests are not mirrored");
  if (payload?.repository?.id !== undefined && Number(payload.repository.id) !== mapping.ghRepoId) return ignored("another repository");

  const key = `create:gh:${mapping.workspaceSlug}:${mapping.ghRepoId}#${issue.number}:${mapping.planeProjectId}`;
  if (await deferPendingMirror(deps, key, "plane", resultRef("partner.id"))) return { action: "deferred", reason: "creation in progress" };
  const link = await findLinkByGithub(db, mapping, issue.number);
  const action: string = payload.action;

  if (!link) {
    const gated = action === "labeled" ? lc(payload.label?.name ?? "") === GATE_LABELS.onGithub
      : action === "opened" && labelNames(issue.labels).some((n) => lc(n) === GATE_LABELS.onGithub);
    if (!gated) return ignored("not opted in");
    return createPlaneItem(payload, deps);
  }

  const policies = await loadPolicies(db, mapping.id);
  const allowed = (field: MirrorField) => shouldApply({ field, from: "github", policy: policies[field], direction: mapping.syncDirection });
  const target = { slug: link.plane_workspace_slug, projectId: link.plane_project_id, issueId: link.plane_issue_id };
  const update = async (field: MirrorField, fields: Record<string, unknown>): Promise<MirrorResult> => {
    if (!allowed(field)) return ignored(`${field} policy keeps GitHub changes out of Plane`);
    await deps.plane.apply({ kind: "update_issue", ...target, fields });
    return { action: "updated", fields: [field] };
  };

  if (payload.comment) {
    if (action !== "created") return ignored("only new comments are mirrored");
    if (!allowed("comments")) return ignored("comments policy keeps GitHub changes out of Plane");
    const who = escapeHtml(String(payload.comment.user?.login ?? payload.sender?.login ?? "someone"));
    const url = safeUrl(payload.comment.html_url);
    await deps.plane.apply({ kind: "add_comment", ...target,
      commentHtml: `<p><strong>${who}</strong> commented${url ? ` on <a href="${escapeHtml(url)}">GitHub</a>` : " on GitHub"}:</p>${textToHtml(String(payload.comment.body ?? ""))}` });
    return { action: "updated", fields: ["comments"] };
  }

  switch (action) {
    case "edited": {
      const changes = payload.changes ?? {};
      const results: MirrorField[] = [];
      if (changes.title !== undefined) {
        const r = await update("title", { name: String(issue.title ?? "") });
        if (r.action === "updated") results.push("title");
      }
      if (changes.body !== undefined) {
        const r = await update("description", { description_html: textToHtml(String(issue.body ?? "")) });
        if (r.action === "updated") results.push("description");
      }
      return results.length ? { action: "updated", fields: results } : ignored("nothing to mirror in this edit");
    }
    case "closed":
    case "reopened": {
      if (!allowed("state")) return ignored("state policy keeps GitHub changes out of Plane");
      if (!deps.listStates) return ignored("no state lookup configured");
      const r = resolveStateTarget(await deps.listStates(target.projectId), action === "closed" ? "completed" : "unstarted");
      if (!r.ok) return ignored(`no ${action === "closed" ? "completed" : "unstarted"} state in the Plane project`);
      return update("state", { state: r.stateId });
    }
    case "labeled":
    case "unlabeled": {
      if (lc(payload.label?.name ?? "") === GATE_LABELS.onGithub) return ignored("gate label");
      if (!allowed("labels")) return ignored("labels policy keeps GitHub changes out of Plane");
      if (deps.plane.plan) {
        const { steps, labels } = planeLabelPlan(target, labelNames(issue.labels));
        steps.push({ kind: "write", side: "plane", write: { kind: "update_issue", ...target, fields: { labels } } });
        await deps.plane.plan(undefined, steps, { target });
        return { action: "updated", fields: ["labels"] };
      }
      return update("labels", { labels: await planeLabelIds(deps, target, labelNames(issue.labels)) });
    }
    case "assigned":
    case "unassigned": {
      if (!allowed("assignees")) return ignored("assignees policy keeps GitHub changes out of Plane");
      return update("assignees", { assignees: await planeAssigneeIds(deps, issue.assignees) });
    }
    default:
      return ignored(`action ${String(action)} is not mirrored`);
  }
}

/** Label IDs arrive in outbound results, not in the inbound reducer. */
function planeLabelPlan(target: { slug: string; projectId: string }, names: string[]) {
  const steps: OutboxPlanStep[] = [];
  const labels: ReturnType<typeof resultRef>[] = [];
  for (const name of [...new Set(names.filter((n) => lc(n) !== GATE_LABELS.onGithub))]) {
    const bind = `label${labels.length}`;
    steps.push({ kind: "write", side: "plane", write: { kind: "upsert_label", ...target, name }, bind });
    labels.push(resultRef(`${bind}.id`));
  }
  return { steps, labels };
}

async function planeLabelIds(deps: MirrorDeps, t: { slug: string; projectId: string }, names: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const name of names) {
    if (lc(name) === GATE_LABELS.onGithub) continue;
    const r = await deps.plane.apply({ kind: "upsert_label", slug: t.slug, projectId: t.projectId, name });
    if (r.id) ids.push(r.id);
  }
  return ids;
}

/** Unmapped GitHub users leave the field empty (§7.3). */
async function planeAssigneeIds(deps: MirrorDeps, assignees: unknown): Promise<string[]> {
  const ids: string[] = [];
  for (const a of Array.isArray(assignees) ? assignees : []) {
    // Logins can be renamed and re-registered. Only the stable account ID authorises a mapping.
    if (!Number.isSafeInteger(a?.id) || a.id <= 0) continue;
    const row = (await deps.db.query<{ plane_user_id: string }>(
      "SELECT plane_user_id FROM user_map WHERE workspace_slug = $1 AND gh_id = $2",
      [deps.mapping.workspaceSlug, a.id])).rows[0];
    const id = row?.plane_user_id;
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

async function createPlaneItem(payload: any, deps: MirrorDeps): Promise<MirrorResult> {
  const { mapping, db } = deps;
  const issue = payload.issue;
  const slug = mapping.workspaceSlug;
  const projectId = mapping.planeProjectId;
  const fields: Record<string, unknown> = { name: String(issue.title ?? ""), description_html: textToHtml(String(issue.body ?? "")) };

  if (deps.plane.plan) return planPlaneCreate(payload, deps, fields);

  // The reverse gate label must exist on the Plane side for people to use it (§7.3).
  await deps.plane.apply({ kind: "upsert_label", slug, projectId, name: GATE_LABELS.onPlane });
  const labels = await planeLabelIds(deps, { slug, projectId }, labelNames(issue.labels));
  if (labels.length) fields.labels = labels;
  const assignees = await planeAssigneeIds(deps, issue.assignees);
  if (assignees.length) fields.assignees = assignees;
  if (issue.state === "closed" && deps.listStates) {
    const s = resolveStateTarget(await deps.listStates(projectId), "completed");
    if (s.ok) fields.state = s.stateId;
  }

  const created = await deps.plane.apply({ kind: "create_issue", slug, projectId, fields });
  if (!created.id) throw new Error("Plane returned no id for the new work item");
  await upsertSyncLink(db, {
    planeWorkspaceSlug: slug, planeProjectId: projectId, planeIssueId: created.id,
    ghRepoId: mapping.ghRepoId, ghNumber: issue.number, ghKind: "issue", tier: "relation", createdBy: "label_sync",
  });

  const ghUrl = safeUrl(issue.html_url);
  const planeUrl = safeUrl(deps.planeIssueUrl?.(slug, projectId, created.id));
  await deps.plane.apply({ kind: "add_comment", slug, projectId, issueId: created.id,
    commentHtml: `<p>Mirrored from GitHub issue ${ghUrl ? `<a href="${escapeHtml(ghUrl)}">${escapeHtml(`${mapping.owner}/${mapping.repo}#${issue.number}`)}</a>` : escapeHtml(`${mapping.owner}/${mapping.repo}#${issue.number}`)}.</p>` });
  await deps.github.apply({ kind: "comment", installationId: mapping.installationId, owner: mapping.owner, repo: mapping.repo,
    repoId: mapping.ghRepoId, number: issue.number,
    body: planeUrl ? `Linked to Plane work item: ${planeUrl}` : `Linked to a Plane work item (${created.id}).` });
  await appendAudit(db, { kind: "mirror_created", source: "github", workspaceSlug: slug, outcome: "applied",
    detail: { direction: "github_to_plane", ghNumber: issue.number, planeIssueId: created.id, mappingId: mapping.id } });
  return { action: "created" };
}

/** One durable plan per create generation; creation and its link survive an arbitrarily long outage. */
async function planPlaneCreate(payload: any, deps: MirrorDeps, fields: Record<string, unknown>): Promise<MirrorResult> {
  const { mapping } = deps, issue = payload.issue;
  const slug = mapping.workspaceSlug, projectId = mapping.planeProjectId;
  const key = `create:gh:${slug}:${mapping.ghRepoId}#${issue.number}:${projectId}`;
  const generation = await nextCreateGeneration(deps.db, key);
  if (!generation) return ignored("creation in progress");
  const assignees = await planeAssigneeIds(deps, issue.assignees);
  if (assignees.length) fields.assignees = assignees;
  if (issue.state === "closed" && deps.listStates) {
    const state = resolveStateTarget(await deps.listStates(projectId), "completed");
    if (state.ok) fields.state = state.stateId;
  }
  const target = { slug, projectId };
  const { steps, labels } = planeLabelPlan(target, labelNames(issue.labels));
  steps.unshift({ kind: "write", side: "plane", write: { kind: "upsert_label", ...target, name: GATE_LABELS.onPlane } });
  if (labels.length) fields.labels = labels;
  const id = resultRef("created.id");
  const link = { planeWorkspaceSlug: slug, planeProjectId: projectId, planeIssueId: id,
    ghRepoId: mapping.ghRepoId, ghNumber: issue.number, ghKind: "issue" as const, tier: "relation" as const, createdBy: "label_sync" as const };
  const ghUrl = safeUrl(issue.html_url);
  const reference = escapeHtml(`${mapping.owner}/${mapping.repo}#${issue.number}`);
  const marker = "__OUTBOX_CREATED_ID__";
  const url = safeUrl(deps.planeIssueUrl?.(slug, projectId, marker));
  const urlParts = url?.split(marker);
  const body = urlParts?.length === 2 ? resultText("Linked to Plane work item: ", urlParts[0]!, id, urlParts[1]!)
    : resultText("Linked to a Plane work item (", id, ").");
  steps.push(
    { kind: "write", side: "plane", write: { kind: "create_issue", ...target, fields }, bind: "created" },
    { kind: "sync_link", link },
    { kind: "write", side: "plane", write: { kind: "add_comment", ...target, issueId: id,
      commentHtml: `<p>Mirrored from GitHub issue ${ghUrl ? `<a href="${escapeHtml(ghUrl)}">${reference}</a>` : reference}.</p>` } },
    { kind: "write", side: "github", write: { kind: "comment", installationId: mapping.installationId, owner: mapping.owner,
      repo: mapping.repo, repoId: mapping.ghRepoId, number: issue.number, body } },
    { kind: "audit", entry: { kind: "mirror_created", source: "github", workspaceSlug: slug, outcome: "applied",
      detail: { direction: "github_to_plane", ghNumber: issue.number, planeIssueId: id, mappingId: mapping.id } } },
  );
  if (deps.createContinuation) steps.push({ kind: "write", side: "plane", write: { kind: "resume_reducer", continuation: {
    kind: "mirror_created", job: deps.createContinuation.job, mappingId: mapping.id, projectId,
    issueId: id, identifier: `${mapping.owner}/${mapping.repo}#${issue.number}`,
  } } });
  const registered = await deps.plane.plan!(generation, steps, {
    pendingLink: { direction: "github_to_plane", ...link },
    pendingMarker: { key, root: createPlanRoot(generation), link: { direction: "github_to_plane", ...link } },
  });
  return (registered.inserted ?? true) === true ? { action: "created" } : ignored("create plan already registered");
}

// ---- Plane → GitHub ----------------------------------------------------------------------------------
const planeAction = (a: unknown) => String(a ?? "").replace(/d$/, ""); // create/created, update/updated

/** UUID arrays as Plane sends them: strings, or expanded `{id, …}` objects. */
const idList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x: any) => (typeof x === "string" ? x : typeof x?.id === "string" ? x.id : null)).filter((x): x is string => !!x) : [];

/** Names of the item's current labels: expanded objects carry them, bare ids are looked up in the project. */
async function currentLabelNames(data: any, deps: MirrorDeps): Promise<string[]> {
  const labels: unknown[] = Array.isArray(data.labels) ? data.labels : [];
  const names = labels.map((l: any) => (typeof l?.name === "string" ? l.name : null)).filter((n): n is string => !!n);
  const bare = labels.filter((l): l is string => typeof l === "string");
  if (bare.length) {
    const byId = await labelNameById(data, deps, bare);
    for (const id of bare) { const n = byId.get(id); if (n) names.push(n); }
  }
  return names;
}

/** id → name for the wanted ids: the webhook's expanded labels first, then the project's label list. */
async function labelNameById(data: any, deps: MirrorDeps, wanted: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const l of Array.isArray(data.labels) ? data.labels : []) if (typeof l?.id === "string" && typeof l?.name === "string") out.set(l.id, l.name);
  if (wanted.some((id) => !out.has(id)) && deps.labelNames) {
    for (const l of await deps.labelNames(deps.mapping.workspaceSlug, deps.mapping.planeProjectId)) out.set(l.id, l.name);
  }
  return out;
}

const refId = (v: any): string | null => (typeof v === "string" ? v : typeof v?.id === "string" ? v.id : null);

export async function onPlaneIssue(job: { event: string; payload: any }, deps: MirrorDeps): Promise<MirrorResult> {
  const { db, mapping } = deps;
  if (mapping.syncDirection === "github_to_plane") return ignored("mapping is github_to_plane");
  const body = job.payload;
  const data = body?.data;
  if (!data) return ignored("no data in payload");
  const action = planeAction(body.action);

  if (job.event === "issue_comment") {
    if (action !== "create") return ignored("only new comments are mirrored");
    const issueId = refId(data.issue);
    if (issueId && await deferPendingMirror(deps,
      `create:plane:${mapping.workspaceSlug}:${mapping.planeProjectId}:${issueId}:${mapping.ghRepoId}`, "github", issueId))
      return { action: "deferred", reason: "creation in progress" };
    const link = issueId ? await findLinkByPlane(db, mapping, issueId) : null;
    if (!link) return ignored("comment on an unlinked item");
    const policies = await loadPolicies(db, mapping.id);
    if (!shouldApply({ field: "comments", from: "plane", policy: policies.comments, direction: mapping.syncDirection })) return ignored("comments policy keeps Plane changes out of GitHub");
    const who = data.actor?.display_name ?? body.activity?.actor?.display_name ?? "Someone";
    await deps.github.apply({ kind: "comment", installationId: mapping.installationId, owner: mapping.owner, repo: mapping.repo,
      repoId: mapping.ghRepoId, number: link.gh_number,
      body: `**${String(who)}** commented in Plane:\n\n${htmlToText(String(data.comment_html ?? data.comment_stripped ?? ""))}` });
    return { action: "updated", fields: ["comments"] };
  }
  if (job.event !== "issue") return ignored(`event ${job.event} is not mirrored`);
  if (data.project !== undefined && refId(data.project) !== mapping.planeProjectId) return ignored("another project");
  const issueId = refId(data.id);
  if (!issueId) return ignored("no issue id");

  const key = `create:plane:${mapping.workspaceSlug}:${mapping.planeProjectId}:${issueId}:${mapping.ghRepoId}`;
  if (await deferPendingMirror(deps, key, "github", issueId)) return { action: "deferred", reason: "creation in progress" };
  const link = await findLinkByPlane(db, mapping, issueId);
  if (!link) {
    const names = await currentLabelNames(data, deps);
    if (!names.some((n) => lc(n) === GATE_LABELS.onPlane)) return ignored("not opted in");
    return createGithubIssue(data, issueId, names, deps);
  }

  const policies = await loadPolicies(db, mapping.id);
  const allowed = (field: MirrorField) => shouldApply({ field, from: "plane", policy: policies[field], direction: mapping.syncDirection });
  const ghTarget = { installationId: mapping.installationId, owner: mapping.owner, repo: mapping.repo, repoId: mapping.ghRepoId, number: link.gh_number };
  // Plane sends one delivery per changed field (§1.3); `activity.field` says which.
  const field: string = String(body.activity?.field ?? "");

  switch (field) {
    case "name":
      if (!allowed("title")) return ignored("title policy keeps Plane changes out of GitHub");
      await deps.github.apply({ ...ghTarget, kind: "update_issue", fields: { title: String(data.name ?? "") } });
      return { action: "updated", fields: ["title"] };
    case "description":
    case "description_html":
      if (!allowed("description")) return ignored("description policy keeps Plane changes out of GitHub");
      await deps.github.apply({ ...ghTarget, kind: "update_issue", fields: { body: htmlToText(String(data.description_html ?? "")) } });
      return { action: "updated", fields: ["description"] };
    case "state":
    case "state_id": {
      if (!allowed("state")) return ignored("state policy keeps Plane changes out of GitHub");
      let group: string | undefined = typeof data.state?.group === "string" ? data.state.group : undefined;
      const stateId = refId(data.state) ?? (typeof data.state_id === "string" ? data.state_id : null);
      if (!group && stateId && deps.listStates) group = (await deps.listStates(mapping.planeProjectId)).find((s) => s.id === stateId)?.group;
      if (!group) return ignored("cannot tell which state group the item moved to");
      await deps.github.apply({ ...ghTarget, kind: "update_issue", fields: { state: group === "completed" || group === "cancelled" ? "closed" : "open" } });
      return { action: "updated", fields: ["state"] };
    }
    // Plane reports the request-body key: the API says `labels`/`assignees`, the web app `label_ids`/`assignee_ids`.
    // Either way old_value/new_value are arrays of UUIDs (measured on v1.4.2), never names.
    case "labels":
    case "label_ids": {
      if (!allowed("labels")) return ignored("labels policy keeps Plane changes out of GitHub");
      const before = idList(body.activity?.old_value);
      const after = idList(body.activity?.new_value);
      const addedIds = after.filter((id) => !before.includes(id));
      const removedIds = before.filter((id) => !after.includes(id));
      if (!addedIds.length && !removedIds.length) return ignored("no label change to mirror");
      const known = await labelNameById(data, deps, [...addedIds, ...removedIds]);
      const pick = (ids: string[]) => ids.map((id) => known.get(id)).filter((n): n is string => !!n && lc(n) !== GATE_LABELS.onPlane);
      const add = pick(addedIds), remove = pick(removedIds);
      if (!add.length && !remove.length) {
        return ignored(addedIds.concat(removedIds).some((id) => !known.has(id)) ? "cannot resolve the label ids to names" : "only the gate label changed");
      }
      if (add.length) await deps.github.apply({ ...ghTarget, kind: "add_labels", labels: add });
      for (const label of remove) await deps.github.apply({ ...ghTarget, kind: "remove_label", label });
      return { action: "updated", fields: ["labels"] };
    }
    case "assignees":
    case "assignee_ids": {
      if (!allowed("assignees")) return ignored("assignees policy keeps Plane changes out of GitHub");
      if (!deps.users.githubLoginForPlaneUserId) return ignored("no Plane-to-GitHub user lookup configured");
      // The activity is the delivered change. Prefer its array (including []) over an expanded
      // snapshot, which may already reflect another edit when Plane serializes the delivery.
      const planeIds = idList(Array.isArray(body.activity?.new_value) ? body.activity.new_value : data.assignees);
      const logins: string[] = [];
      const seen = new Set<string>();
      for (const id of planeIds) {
        const login = await deps.users.githubLoginForPlaneUserId(id);
        if (login && !seen.has(lc(login))) {
          seen.add(lc(login));
          logins.push(login); // unmapped Plane users have no GitHub account to assign (§7.3)
        }
      }
      // An empty set is a real change (the last mapped assignee was removed), so it is sent too. The writer
      // reconciles GitHub's assignees against this list, but only over logins that are in the user map.
      await deps.github.apply({ ...ghTarget, kind: "add_assignees", assignees: logins });
      return { action: "updated", fields: ["assignees"] };
    }
    default:
      return ignored(`field ${field || "(none)"} is not mirrored`);
  }
}

async function createGithubIssue(data: any, issueId: string, names: string[], deps: MirrorDeps): Promise<MirrorResult> {
  const { mapping, db } = deps;
  const slug = mapping.workspaceSlug;
  const planeUrl = safeUrl(deps.planeIssueUrl?.(slug, mapping.planeProjectId, issueId));
  const description = htmlToText(String(data.description_html ?? ""));
  const footer = planeUrl ? `\n\n---\nMirrored from Plane: ${planeUrl}` : "\n\n---\nMirrored from Plane.";
  // Creating the issue with the label creates the `plane` gate label on the repository if absent.
  const labels = [GATE_LABELS.onGithub, ...names.filter((n) => lc(n) !== GATE_LABELS.onPlane)];
  if (deps.github.plan) {
    const key = `create:plane:${slug}:${mapping.planeProjectId}:${issueId}:${mapping.ghRepoId}`;
    const generation = await nextCreateGeneration(db, key);
    if (!generation) return ignored("creation in progress");
    const number = resultRef("created.number");
    const link = { planeWorkspaceSlug: slug, planeProjectId: mapping.planeProjectId, planeIssueId: issueId,
      ghRepoId: mapping.ghRepoId, ghNumber: number, ghKind: "issue" as const, tier: "relation" as const, createdBy: "label_sync" as const };
    const registered = await deps.github.plan(generation, [
      { kind: "write", side: "github", write: { kind: "create_issue", installationId: mapping.installationId,
        owner: mapping.owner, repo: mapping.repo, repoId: mapping.ghRepoId, title: String(data.name ?? ""), body: description + footer, labels }, bind: "created" },
      { kind: "sync_link", link },
      { kind: "write", side: "plane", write: { kind: "add_comment", slug, projectId: mapping.planeProjectId, issueId,
        commentHtml: resultText(`<p>Mirrored to GitHub issue ${escapeHtml(`${mapping.owner}/${mapping.repo}#`)}`, number, ".</p>") } },
      { kind: "audit", entry: { kind: "mirror_created", source: "plane", workspaceSlug: slug, outcome: "applied",
        detail: { direction: "plane_to_github", ghNumber: number, planeIssueId: issueId, mappingId: mapping.id } } },
    ], { pendingLink: { direction: "plane_to_github", ...link },
      pendingMarker: { key, root: createPlanRoot(generation), link: { direction: "plane_to_github", ...link } } });
    return (registered.inserted ?? true) === true ? { action: "created" } : ignored("create plan already registered");
  }
  const created = await deps.github.apply({ kind: "create_issue", installationId: mapping.installationId, owner: mapping.owner,
    repo: mapping.repo, repoId: mapping.ghRepoId, title: String(data.name ?? ""), body: description + footer, labels });
  if (created.number === undefined) throw new Error("GitHub returned no issue number");
  await upsertSyncLink(db, {
    planeWorkspaceSlug: slug, planeProjectId: mapping.planeProjectId, planeIssueId: issueId,
    ghRepoId: mapping.ghRepoId, ghNumber: created.number, ghKind: "issue", tier: "relation", createdBy: "label_sync",
  });
  await deps.plane.apply({ kind: "add_comment", slug, projectId: mapping.planeProjectId, issueId,
    commentHtml: `<p>Mirrored to GitHub issue ${escapeHtml(`${mapping.owner}/${mapping.repo}#${created.number}`)}.</p>` });
  await appendAudit(db, { kind: "mirror_created", source: "plane", workspaceSlug: slug, outcome: "applied",
    detail: { direction: "plane_to_github", ghNumber: created.number, planeIssueId: issueId, mappingId: mapping.id } });
  return { action: "created" };
}
