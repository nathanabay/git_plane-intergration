// Two-way issue mirroring (spec §7.3). Opt-in by label: `plane` on a GitHub issue creates a Plane
// work item, `github` on a Plane item creates a GitHub issue. Per field, the mapping's conflict
// policy and direction decide whether a change from one side is applied to the other. Every write
// goes through A4's write paths, which own echo suppression and the triage ban.
import { createHash, randomUUID } from "node:crypto";
import { deliveryScope } from "../app/writers.ts";
import { freezeMappingAuthority } from "../app/mappings.ts";
import { resultRef, resultText } from "../operations/plans.ts";
import { restoreCreateWorkflow } from "../operations/tooling.ts";
import type { PlanWriter, OutboxPlanStep } from "../operations/plans.ts";
import type { InboundJob } from "../queue/index.ts";
import type { SecretString } from "../auth/identity.ts";
import type { Db } from "../db/migrate.ts";
import { appendAudit, upsertSyncLink } from "../db/ledgers.ts";
import { escapeHtml, safeUrl } from "../github/html.ts";
import { htmlToText, textToHtml } from "./text.ts";
import type { TextContext } from "./text.ts";
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
    // Neither side delivers in occurrence order, so the reducers mirror the partner's current value (`freshest`),
    // never an older delivered snapshot: whichever change was made last is what both sides end with.
    case "last_write_wins": return true;
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
  /**
   * C5: post the cross-link comment on GitHub and the Plane link. When the caller leaves it out, the mirror
   * reads the mapping's `linkback_enabled` column; a missing row counts as on (the column defaults to true).
   */
  linkbackEnabled?: boolean;
  /** C4: the Plane states a reopened and a closed GitHub issue map to. Unset means the mapping row decides. */
  openStateId?: string | null;
  closedStateId?: string | null;
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
   * The GitHub web origin (C8: `https://github.com`, `https://<sub>.ghe.com` or the GHES base URL), used to build the
   * Plane link to an issue the mirror created. GitHub → Plane links use the delivered `html_url` instead.
   */
  githubWebOrigin?: string;
  /**
   * C6: a Plane user's display name, for a mention of someone with no linked GitHub account (Plane → GitHub).
   * Plane v1.4.2's mention-component carries only the user id. Without it such a mention reads "Unknown user".
   */
  planeUserDisplayName?(planeUserId: string): Promise<string | null>;
  /**
   * The project's labels (`GET …/projects/{pid}/labels/`). Plane's label activity carries label UUIDs, and a
   * removed label is no longer in the webhook's expanded `data.labels`, so ids are resolved here when needed.
   */
  labelNames?(slug: string, projectId: string): Promise<{ id: string; name: string }[]>;
  /**
   * The GitHub issue as it is now (`GET /repos/{owner}/{repo}/issues/{issue_number}`), or null when it is gone.
   * GitHub may deliver webhooks out of order, so snapshot fields are taken from this read when it is newer.
   */
  currentGithubIssue?(number: number): Promise<any | null>;
  /** The Plane work item as it is now (`planeClient.getIssue`), or null when it is gone. Plane deliveries are unordered too. */
  currentPlaneIssue?(issueId: string): Promise<any | null>;
}

/**
 * A Plane display name as literal GitHub Markdown (security-audit ATTACK-CLASSES "Injection", second-order use: a
 * name typed in Plane is rendered by GitHub). `@` becomes the full-width `＠` (U+FF20), so a name cannot mention or
 * notify a user or `@org/team` (Context7 /websites/github_en: typing `@` plus a user or team name notifies them);
 * Markdown punctuation is backslash-escaped so it cannot open a link, image or emphasis; line breaks are flattened and
 * the length is capped.
 */
export function markdownLiteral(name: string): string {
  return name.replace(/[\r\n\t]+/g, " ").trim().slice(0, 100).replace(/@/g, "\uFF20").replace(/[\\`*_{}\[\]()<>#+!|~]/g, (c) => `\\${c}`) || "Someone";
}

/**
 * C6/C7: the context for G2's prose converter (src/sync/text.ts). GitHub → Plane: `@login` of a user linked in this
 * workspace becomes Plane's `<mention-component entity_identifier=… entity_name="user_mention">`, an unlinked login a
 * link to its profile, and `#123`, `owner/repo#123` and issue URLs links on the configured GitHub host (C8). Plane →
 * GitHub: a mention becomes `@login`, or the display name for someone unlinked. Code spans and blocks are left alone.
 * The writers hash the converted value, so the echo of a mirrored write is recognised and a round trip cannot loop.
 */
function proseContext(deps: MirrorDeps): TextContext {
  return {
    webOrigin: deps.githubWebOrigin ?? "https://github.com",
    owner: deps.mapping.owner,
    repo: deps.mapping.repo,
    planeUserForGithubLogin: async (login) => {
      const id = await deps.users.planeUserIdForGithubLogin(login);
      return id ? { id } : null;
    },
    githubUserForPlaneId: async (planeUserId) => {
      const login = await deps.users.githubLoginForPlaneUserId?.(planeUserId) ?? null;
      if (login) return { login };
      const displayName = await deps.planeUserDisplayName?.(planeUserId) ?? null;
      return displayName ? { displayName: markdownLiteral(displayName) } : null;
    },
  };
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
  // The original continuation already owns this delivery, including its explicit replay. Adding
  // another event resume would run the original rule a second time after repairing a failed tail.
  const original = await deps.db.query(`SELECT 1 FROM outbound_writes WHERE write->'_plan'->>'root' = $1
    AND write->>'kind' = 'resume_reducer' AND write->'continuation'->'job'->>'source' = $2
    AND COALESCE(write->'continuation'->'job'->>'writeDeliveryId', write->'continuation'->'job'->>'deliveryId') = $3 LIMIT 1`,
  [pending.outbox_id, job.source, job.writeDeliveryId ?? job.deliveryId]);
  if (original.rows.length) return true;
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

/** Only a confirmed orphan permits replacement. Failed/ambiguous creates recover their original intent. */
export async function nextCreateGeneration(db: Db, key: string): Promise<string | null> {
  const live = await db.query(`SELECT 1 FROM pending_sync_links p WHERE p.key = $1
    AND NOT EXISTS (SELECT 1 FROM outbound_writes w
      WHERE w.write->'_plan'->>'root' = p.outbox_id AND w.status = 'failed')`, [key]);
  if (live.rows.length) return null;
  const last = (await db.query<{ sequence: string | number; root: string; pending: boolean; failed: boolean }>(`SELECT r.sequence,
    COALESCE(r.write->'_plan'->>'root', r.id) AS root,
    EXISTS (SELECT 1 FROM outbound_writes w
      WHERE w.write->'_plan'->>'root' = COALESCE(r.write->'_plan'->>'root', r.id) AND w.status = 'pending') AS pending,
    EXISTS (SELECT 1 FROM outbound_writes w
      WHERE w.write->'_plan'->>'root' = COALESCE(r.write->'_plan'->>'root', r.id) AND w.status = 'failed') AS failed
    FROM outbound_writes r WHERE r.id = $1 OR r.write->'_plan'->'after' @> $2::jsonb
      OR r.write->'_plan'->'marker'->>'key' = $3
    ORDER BY r.sequence DESC LIMIT 1`, [createPlanRoot(key), JSON.stringify([{ kind: "clear_pending_link", key }]), key])).rows[0];
  if (!last) {
    // Retention of terminal rows must not turn a recorded ambiguous create into a fresh intent.
    const failed = await db.query("SELECT 1 FROM audit_log WHERE kind = 'mirror_create_failed' AND detail->>'markerKey' = $1 LIMIT 1", [key]);
    return failed.rows.length ? null : key;
  }
  if (last.pending && !last.failed) return null;
  const orphan = await db.query(`SELECT 1 FROM outbound_writes c JOIN sync_links l
    ON l.status = 'orphaned' AND l.gh_repo_id = (COALESCE(
      (SELECT r.write->'_plan'->'marker'->'link'->>'ghRepoId' FROM outbound_writes r WHERE r.id = $1),
      (SELECT a->'link'->>'ghRepoId' FROM outbound_writes w,
        LATERAL jsonb_array_elements(COALESCE(w.write->'_plan'->'after','[]'::jsonb)) a
        WHERE w.write->'_plan'->>'root' = $1 AND a->>'kind' = 'sync_link' LIMIT 1)))::bigint
    AND ((c.side = 'plane' AND l.plane_issue_id = c.result->>'id'
      AND l.plane_workspace_slug = c.write->>'slug' AND l.plane_project_id = c.write->>'projectId')
      OR (c.side = 'github' AND l.gh_number = (c.result->>'number')::int))
    WHERE c.write->'_plan'->>'root' = $1 AND c.write->>'kind' = 'create_issue'
      AND c.result->>'ok' = 'true' LIMIT 1`, [last.root]);
  if (!orphan.rows.length) {
    // A failed create may have committed remotely without returning a response. Reset its existing
    // rows so the executor uses their saved result or looks up the same external_id before posting.
    // An unavailable lookup leaves that identity pending; it never authorizes a new generation.
    if (last.failed) await restoreCreateWorkflow(db, last.root);
    return null;
  }
  // A later retained marker step also identifies the generation if retention pruned its root first.
  return `${key}:generation:${last.sequence}`;
}

interface MirrorSettings { linkback: boolean; openStateId: string | null; closedStateId: string | null }

const stateIdOf = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/**
 * The mapping's linkback toggle and chosen open/closed states (C4, C5). Values on the mapping win; otherwise the
 * live row is read as JSON so the mirror keeps working on a database that predates the state columns.
 */
async function loadMirrorSettings(deps: MirrorDeps): Promise<MirrorSettings> {
  const m = deps.mapping;
  const need = m.linkbackEnabled === undefined || m.openStateId === undefined || m.closedStateId === undefined;
  const row = need ? (await deps.db.query<{ row: Record<string, unknown> }>(
    "SELECT to_jsonb(rm) AS row FROM repo_mappings rm WHERE rm.id = $1", [m.id])).rows[0]?.row ?? {} : {};
  return {
    linkback: m.linkbackEnabled ?? (row.linkback_enabled === undefined || row.linkback_enabled === null ? true : row.linkback_enabled === true),
    openStateId: m.openStateId !== undefined ? stateIdOf(m.openStateId) : stateIdOf(row.open_state_id),
    closedStateId: m.closedStateId !== undefined ? stateIdOf(m.closedStateId) : stateIdOf(row.closed_state_id),
  };
}

export type MirrorStateResolution = { ok: true; stateId: string; chosen: boolean } | { ok: false; reason: string };

/**
 * C4: the Plane state for a GitHub issue that is closed (or open). The mapping's chosen state wins while it still
 * exists in the project and is not a triage state (Plane v1.4.2 keeps triage states out of the default manager);
 * otherwise today's default applies: the default *completed* state for closed, the default *unstarted* for open.
 * `openFallback: false` (creates) leaves an open item in Plane's own default state when nothing was chosen.
 */
export function mirrorStateFor(states: StateRef[], closed: boolean, settings: Pick<MirrorSettings, "openStateId" | "closedStateId">,
  opts: { openFallback?: boolean } = {}): MirrorStateResolution {
  const chosen = closed ? settings.closedStateId : settings.openStateId;
  const hit = chosen ? states.find((s) => s.id === chosen && lc(String(s.group)) !== "triage") : undefined;
  if (hit) return { ok: true, stateId: hit.id, chosen: true };
  if (!closed && opts.openFallback === false) return { ok: false, reason: "no open state chosen" };
  const group = closed ? "completed" : "unstarted";
  const r = resolveStateTarget(states, group);
  return r.ok ? { ok: true, stateId: r.stateId, chosen: false } : { ok: false, reason: `no ${group} state in the Plane project` };
}

/** A chosen state that is gone is worth telling the admin about; the fallback state was used instead. */
async function auditStateFallback(deps: MirrorDeps, closed: boolean, settings: MirrorSettings, r: MirrorStateResolution): Promise<void> {
  const chosen = closed ? settings.closedStateId : settings.openStateId;
  if (!chosen || (r.ok && r.chosen)) return;
  await appendAudit(deps.db, { kind: "mirror_state_fallback", source: "mapping", workspaceSlug: deps.mapping.workspaceSlug, outcome: "fallback",
    detail: { mappingId: deps.mapping.id, side: closed ? "closed" : "open", chosenStateId: chosen, usedStateId: r.ok ? r.stateId : null } });
}

/**
 * C4, Plane → GitHub: the completed group closes as `completed`, the cancelled group as `not_planned`, any other
 * group reopens. GitHub's `state_reason` accepts completed, not_planned, duplicate, reopened or null and is ignored
 * unless the state changes (REST "Update an issue", Context7 /websites/github_en_rest).
 */
export function githubStateForGroup(group: string): { state: "open" | "closed"; state_reason: "completed" | "not_planned" | "reopened" } {
  const g = lc(group);
  if (g === "completed") return { state: "closed", state_reason: "completed" };
  if (g === "cancelled") return { state: "closed", state_reason: "not_planned" };
  return { state: "open", state_reason: "reopened" };
}

/** C5: the Plane link title for a mirrored GitHub issue. */
const githubLinkTitle = (m: MirrorMapping, number: number | string) => `GitHub issue ${m.owner}/${m.repo}#${number}`;

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

const stamp = (v: unknown): number | null => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};

/**
 * The snapshot to mirror from: the current read when it is at least as new as the delivered one, else the delivery.
 * Both GitHub and Plane document that deliveries can arrive in any order and a retry resends the original snapshot,
 * so a delayed event must not write its older value over a newer one. Plane and GitHub both stamp `updated_at` on the
 * object; a read without one, or a failed/absent read, leaves the delivered snapshot (the previous behavior).
 */
export function freshest(delivered: any, current: any): any {
  if (!current || typeof current !== "object") return delivered;
  const now = stamp(current.updated_at), then = stamp(delivered?.updated_at);
  if (now === null || (then !== null && now < then)) return delivered;
  // A field the read omits keeps the delivered value; the read is never a reason to blank a field.
  return { ...delivered, ...Object.fromEntries(Object.entries(current).filter(([, v]) => v !== undefined)) };
}

// ---- GitHub → Plane ----------------------------------------------------------------------------------
export async function onGithubIssue(payload: any, deps: MirrorDeps): Promise<MirrorResult> {
  // Pending continuations re-enter here too. Preserve delivery/replay identity while replacing
  // any caller authority with the verified mapping that owns this mirror operation.
  const scope = deliveryScope.getStore() ?? { deliveryId: randomUUID() };
  return deliveryScope.run({ ...scope, authority: freezeMappingAuthority(deps.mapping) },
    () => mirrorGithubIssue(payload, deps));
}

async function mirrorGithubIssue(payload: any, deps: MirrorDeps): Promise<MirrorResult> {
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
  // Comments are additive history and keep their own identity; every other field mirrors GitHub's current value.
  const current = payload.comment || !deps.currentGithubIssue ? issue : freshest(issue, await deps.currentGithubIssue(issue.number));
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
      commentHtml: `<p><strong>${who}</strong> commented${url ? ` on <a href="${escapeHtml(url)}">GitHub</a>` : " on GitHub"}:</p>${await textToHtml(String(payload.comment.body ?? ""), proseContext(deps))}` });
    return { action: "updated", fields: ["comments"] };
  }

  switch (action) {
    case "edited": {
      const changes = payload.changes ?? {};
      const results: MirrorField[] = [];
      if (changes.title !== undefined) {
        const r = await update("title", { name: String(current.title ?? "") });
        if (r.action === "updated") results.push("title");
      }
      if (changes.body !== undefined) {
        const r = await update("description", { description_html: await planeDescriptionHtml(current.body, deps) });
        if (r.action === "updated") results.push("description");
      }
      return results.length ? { action: "updated", fields: results } : ignored("nothing to mirror in this edit");
    }
    case "closed":
    case "reopened": {
      if (!allowed("state")) return ignored("state policy keeps GitHub changes out of Plane");
      if (!deps.listStates) return ignored("no state lookup configured");
      // A delayed `closed` after a reopen (or the reverse) mirrors the issue's state now, not the action's.
      const closed = typeof current.state === "string" ? lc(current.state) === "closed" : action === "closed";
      const settings = await loadMirrorSettings(deps);
      const r = mirrorStateFor(await deps.listStates(target.projectId), closed, settings);
      await auditStateFallback(deps, closed, settings, r);
      if (!r.ok) return ignored(r.reason);
      return update("state", { state: r.stateId });
    }
    case "labeled":
    case "unlabeled": {
      if (lc(payload.label?.name ?? "") === GATE_LABELS.onGithub) return ignored("gate label");
      if (!allowed("labels")) return ignored("labels policy keeps GitHub changes out of Plane");
      if (deps.plane.plan) {
        const { steps, labels } = planeLabelPlan(target, labelNames(current.labels));
        steps.push({ kind: "write", side: "plane", write: { kind: "update_issue", ...target, fields: { labels } } });
        await deps.plane.plan(undefined, steps, { target });
        return { action: "updated", fields: ["labels"] };
      }
      return update("labels", { labels: await planeLabelIds(deps, target, labelNames(current.labels)) });
    }
    case "assigned":
    case "unassigned": {
      if (!allowed("assignees")) return ignored("assignees policy keeps GitHub changes out of Plane");
      return update("assignees", { assignees: await planeAssigneeIds(deps, current.assignees) });
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

/** C4 on create: a closed issue lands in the closed state; an open one in the chosen open state, if any. */
async function applyCreateState(deps: MirrorDeps, issue: any, settings: MirrorSettings, fields: Record<string, unknown>): Promise<void> {
  if (!deps.listStates) return;
  const closed = issue.state === "closed";
  if (!closed && !settings.openStateId) return;
  const r = mirrorStateFor(await deps.listStates(deps.mapping.planeProjectId), closed, settings, { openFallback: false });
  await auditStateFallback(deps, closed, settings, r);
  if (r.ok) fields.state = r.stateId;
}

/**
 * E2E-3: Plane v1.4.2 parses `description_html` with lxml (`plane/api/serializers/issue.py`), which refuses an empty or
 * whitespace-only document, so `""` is answered 400 "Invalid HTML passed". An empty GitHub body is sent as Plane's own
 * empty document instead, the `Issue.description_html` model default.
 */
export const PLANE_EMPTY_DESCRIPTION = "<p></p>";

/** A GitHub issue body (null, empty or markdown) as `description_html` Plane accepts. */
async function planeDescriptionHtml(body: unknown, deps: MirrorDeps): Promise<string> {
  const html = await textToHtml(String(body ?? ""), proseContext(deps));
  return html.trim() ? html : PLANE_EMPTY_DESCRIPTION;
}

async function createPlaneItem(payload: any, deps: MirrorDeps): Promise<MirrorResult> {
  const { mapping, db } = deps;
  const issue = payload.issue;
  const slug = mapping.workspaceSlug;
  const projectId = mapping.planeProjectId;
  const fields: Record<string, unknown> = { name: String(issue.title ?? ""), description_html: await planeDescriptionHtml(issue.body, deps) };

  if (deps.plane.plan) return planPlaneCreate(payload, deps, fields);

  // The reverse gate label must exist on the Plane side for people to use it (§7.3).
  await deps.plane.apply({ kind: "upsert_label", slug, projectId, name: GATE_LABELS.onPlane });
  const labels = await planeLabelIds(deps, { slug, projectId }, labelNames(issue.labels));
  if (labels.length) fields.labels = labels;
  const assignees = await planeAssigneeIds(deps, issue.assignees);
  if (assignees.length) fields.assignees = assignees;
  const settings = await loadMirrorSettings(deps);
  await applyCreateState(deps, issue, settings, fields);

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
  // C5: one Plane link and one GitHub comment per pair, only while linkback is on.
  if (settings.linkback) {
    if (ghUrl) await deps.plane.apply({ kind: "add_link", slug, projectId, issueId: created.id, url: ghUrl, title: githubLinkTitle(mapping, issue.number) });
    await deps.github.apply({ kind: "comment", installationId: mapping.installationId, owner: mapping.owner, repo: mapping.repo,
      repoId: mapping.ghRepoId, number: issue.number,
      body: planeUrl ? `Linked to Plane work item: ${planeUrl}` : `Linked to a Plane work item (${created.id}).` });
  }
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
  const settings = await loadMirrorSettings(deps);
  await applyCreateState(deps, issue, settings, fields);
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
    // C5: the cross-links are steps of this generation's plan, so a replayed delivery never adds them twice
    // (the plan registers once per generation key) and a retried link is absorbed by Plane's duplicate-URL check.
    ...(settings.linkback ? [
      ...(ghUrl ? [{ kind: "write" as const, side: "plane" as const, write: { kind: "add_link", ...target, issueId: id, url: ghUrl,
        title: githubLinkTitle(mapping, issue.number) } }] : []),
      { kind: "write" as const, side: "github" as const, write: { kind: "comment", installationId: mapping.installationId, owner: mapping.owner,
        repo: mapping.repo, repoId: mapping.ghRepoId, number: issue.number, body } },
    ] : []),
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

/**
 * C2 attribution (spec §12.3): a change made in Plane by a user linked in this workspace is written to GitHub as that
 * user (`asUser`). User access tokens "attribute activity to both a user and your app"; installation tokens attribute it
 * to the app (Context7 /websites/github_en, "Best practices for creating a GitHub App"). The write path falls back to the
 * installation token when the user has no usable token or GitHub refuses it, so this never drops a write. Automated
 * writes (creates, cross-links, linkback) keep the service identity.
 */
async function planeAuthor(deps: MirrorDeps, ...candidates: unknown[]): Promise<{ asUser?: string }> {
  const id = candidates.map(refId).find((x): x is string => !!x);
  if (!id) return {};
  const linked = await deps.db.query("SELECT 1 FROM user_map WHERE workspace_slug = $1 AND plane_user_id = $2", [deps.mapping.workspaceSlug, id]);
  return linked.rows.length ? { asUser: id } : {};
}

/** Plane activity fields whose delivery carries a whole value (not a diff), so an older one must not win. */
const FULL_VALUE_FIELDS = new Set(["name", "description", "description_html", "state", "state_id", "assignees", "assignee_ids"]);

export async function onPlaneIssue(job: { event: string; payload: any }, deps: MirrorDeps): Promise<MirrorResult> {
  const scope = deliveryScope.getStore() ?? { deliveryId: randomUUID() };
  return deliveryScope.run({ ...scope, authority: freezeMappingAuthority(deps.mapping) },
    () => mirrorPlaneIssue(job, deps));
}

async function mirrorPlaneIssue(job: { event: string; payload: any }, deps: MirrorDeps): Promise<MirrorResult> {
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
    // The comment's author, not whoever triggered the delivery; the "commented in Plane" line stays for the fallback.
    await deps.github.apply({ kind: "comment", installationId: mapping.installationId, owner: mapping.owner, repo: mapping.repo,
      repoId: mapping.ghRepoId, number: link.gh_number, ...(await planeAuthor(deps, data.actor, body.activity?.actor)),
      body: `**${markdownLiteral(String(who))}** commented in Plane:\n\n${await htmlToText(String(data.comment_html ?? data.comment_stripped ?? ""), proseContext(deps))}` });
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
  // Every field edit below is the Plane user's own change, so it carries their GitHub identity when linked.
  const ghTarget = { installationId: mapping.installationId, owner: mapping.owner, repo: mapping.repo, repoId: mapping.ghRepoId, number: link.gh_number,
    ...(await planeAuthor(deps, body.activity?.actor)) };
  // Plane sends one delivery per changed field (§1.3); `activity.field` says which.
  const field: string = String(body.activity?.field ?? "");
  // Full-value fields mirror the item as it is now when that is newer than this delivery (Plane's deliveries are
  // independent tasks with no order, and a retry resends the snapshot taken when the change was queued).
  // Label deliveries are diffs (old_value/new_value), which stay correct in any order.
  const snapshot = FULL_VALUE_FIELDS.has(field) && deps.currentPlaneIssue ? freshest(data, await deps.currentPlaneIssue(issueId)) : data;
  const fresher = snapshot !== data;

  switch (field) {
    case "name":
      if (!allowed("title")) return ignored("title policy keeps Plane changes out of GitHub");
      await deps.github.apply({ ...ghTarget, kind: "update_issue", fields: { title: String(snapshot.name ?? "") } });
      return { action: "updated", fields: ["title"] };
    case "description":
    case "description_html":
      if (!allowed("description")) return ignored("description policy keeps Plane changes out of GitHub");
      await deps.github.apply({ ...ghTarget, kind: "update_issue", fields: { body: await htmlToText(String(snapshot.description_html ?? ""), proseContext(deps)) } });
      return { action: "updated", fields: ["description"] };
    case "state":
    case "state_id": {
      if (!allowed("state")) return ignored("state policy keeps Plane changes out of GitHub");
      let group: string | undefined = typeof snapshot.state?.group === "string" ? snapshot.state.group : undefined;
      const stateId = refId(snapshot.state) ?? (typeof snapshot.state_id === "string" ? snapshot.state_id : null);
      if (!group && stateId && deps.listStates) group = (await deps.listStates(mapping.planeProjectId)).find((s) => s.id === stateId)?.group;
      if (!group) return ignored("cannot tell which state group the item moved to");
      await deps.github.apply({ ...ghTarget, kind: "update_issue", fields: githubStateForGroup(group) });
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
      // A newer read is the item's assignee set now. Otherwise the activity is the delivered change: prefer its
      // array (including []) over the expanded snapshot, which may already reflect another edit.
      const planeIds = fresher ? idList(snapshot.assignees ?? snapshot.assignee_ids)
        : idList(Array.isArray(body.activity?.new_value) ? body.activity.new_value : data.assignees);
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
  const settings = await loadMirrorSettings(deps);
  // C5: the Plane link points at the new issue on the configured GitHub host (C8), never a hardcoded one.
  const origin = safeUrl(deps.githubWebOrigin ?? "https://github.com")?.replace(/\/+$/, "");
  const issuesBase = origin ? `${origin}/${mapping.owner}/${mapping.repo}/issues/` : null;
  const linkbackBody = planeUrl ? `Linked to Plane work item: ${planeUrl}` : `Linked to a Plane work item (${issueId}).`;
  const description = await htmlToText(String(data.description_html ?? ""), proseContext(deps));
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
      ...(settings.linkback ? [
        ...(issuesBase ? [{ kind: "write" as const, side: "plane" as const, write: { kind: "add_link", slug, projectId: mapping.planeProjectId, issueId,
          url: resultText(issuesBase, number), title: resultText(githubLinkTitle(mapping, ""), number) } }] : []),
        { kind: "write" as const, side: "github" as const, write: { kind: "comment", installationId: mapping.installationId, owner: mapping.owner,
          repo: mapping.repo, repoId: mapping.ghRepoId, number, body: linkbackBody } },
      ] : []),
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
  if (settings.linkback) {
    if (issuesBase) await deps.plane.apply({ kind: "add_link", slug, projectId: mapping.planeProjectId, issueId,
      url: `${issuesBase}${created.number}`, title: githubLinkTitle(mapping, created.number) });
    await deps.github.apply({ kind: "comment", installationId: mapping.installationId, owner: mapping.owner, repo: mapping.repo,
      repoId: mapping.ghRepoId, number: created.number, body: linkbackBody });
  }
  await appendAudit(db, { kind: "mirror_created", source: "plane", workspaceSlug: slug, outcome: "applied",
    detail: { direction: "plane_to_github", ghNumber: created.number, planeIssueId: issueId, mappingId: mapping.id } });
  return { action: "created" };
}
