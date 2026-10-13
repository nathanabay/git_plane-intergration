// PR and branch automation (spec §7.1, §7.5). The lifecycle→state table is presentation sugar:
import * as yaml from "yaml";
import type { SecretString } from "../auth/identity.ts";
import type { Action, ActionExecutor, RuleEvent } from "../rules/types.ts";
function allLinkedPrsMerged(prs: { state: "open" | "merged" | "closed_unmerged" }[]): boolean {
  return prs.some((p) => p.state === "merged") && !prs.some((p) => p.state === "open");
}

import type { PlaneWrite, PlaneWriteResult } from "../sync/plane.ts";
import { escapeHtml } from "./html.ts";
import { classifyGithubError } from "./errors.ts";

export const LIFECYCLES = [
  "branch_pushed", "drafted", "opened", "review_requested", "changes_requested", "approved",
  "ready_for_merge", "merged", "closed_unmerged", "reopened",
] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];

export interface BranchRule { baseBranch: string; lifecycle: Lifecycle; state: string }
export interface LifecycleMapping {
  /** Lifecycle point → state target (`group`, `group:Name` or `Name`). A missing point means no change. */
  states: Partial<Record<Lifecycle, string>>;
  /** Regex the base branch must match for the `merged` default to apply (§7.1: merged into main). */
  mergedBaseBranch: string;
  /** Ordered, first match wins, evaluated before the defaults. */
  branchRules: BranchRule[];
}

/** The §7.1 shipping defaults. Approved and closed-without-merge deliberately change nothing. */
export const QLL_DEFAULTS: LifecycleMapping = {
  states: {
    branch_pushed: "started:In Progress",
    drafted: "started:In Progress",
    opened: "started:In Progress",
    review_requested: "started:In Review",
    merged: "completed:Done",
  },
  mergedBaseBranch: "^main$",
  branchRules: [],
};

const TRIGGER: Record<Lifecycle, string> = {
  branch_pushed: "branch.created",
  drafted: "pull_request.drafted",
  opened: "pull_request.opened",
  review_requested: "pull_request.review_requested",
  changes_requested: "pull_request.changes_requested",
  approved: "pull_request.approved",
  ready_for_merge: "pull_request.ready_for_merge",
  merged: "pull_request.merged",
  closed_unmerged: "pull_request.closed_unmerged",
  reopened: "pull_request.reopened",
};

function checkTarget(state: unknown, where: string): string {
  if (typeof state !== "string" || state.trim() === "") throw new Error(`${where}: state target is required`);
  return state.trim();
}

/** Computes a deterministic hash of YAML content for divergence detection (F11). */
export function computeYamlHash(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  let h1 = 0xdeadbeef, h2 = 0x41c64e6d;
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/** YAML that A6's `parseRules` accepts: branch rules first, then the lifecycle defaults. */
export function compileLifecycleRules(mapping: LifecycleMapping): string {
  const rules: Record<string, unknown>[] = [];
  mapping.branchRules.forEach((r, i) => {
    if (!(LIFECYCLES as readonly string[]).includes(r.lifecycle)) throw new Error(`branch rule ${i}: unknown lifecycle ${String(r.lifecycle)}`);
    if (r.lifecycle === "branch_pushed") {
      rules.push({
        name: `${r.lifecycle}`,
        when: TRIGGER[r.lifecycle],
        then: [{ set_state: checkTarget(r.state, `branch rule ${i}`) }],
      });
    } else {
      try { new RegExp(r.baseBranch); } catch { throw new Error(`branch rule ${i}: invalid base branch regex`); }
      if (r.baseBranch === "") throw new Error(`branch rule ${i}: base branch is required`);
      rules.push({
        name: `${r.lifecycle} into ${r.baseBranch}`,
        when: TRIGGER[r.lifecycle],
        if: { base_branch: r.baseBranch },
        then: [{ set_state: checkTarget(r.state, `branch rule ${i}`) }],
      });
    }
  });
  for (const lifecycle of LIFECYCLES) {
    const target = mapping.states[lifecycle];
    if (target === undefined || target === null) continue;
    const rule: Record<string, unknown> = { name: `default: ${lifecycle}`, when: TRIGGER[lifecycle] };
    if (lifecycle === "merged") {
      try { new RegExp(mapping.mergedBaseBranch); } catch { throw new Error("mergedBaseBranch is not a valid regex"); }
      rule.if = { base_branch: mapping.mergedBaseBranch };
    }
    rule.then = [{ set_state: checkTarget(target, lifecycle) }];
    rules.push(rule);
  }
  const yamlBody = yaml.stringify(rules);
  const mappingPayload = {
    states: mapping.states,
    mergedBaseBranch: mapping.mergedBaseBranch,
    branchRules: mapping.branchRules,
  };
  const jsonForHash = JSON.stringify(mappingPayload);
  const hash = computeYamlHash(jsonForHash + "\n" + yamlBody);
  const comment = `# gitsync-lifecycle-mapping: ${JSON.stringify({ ...mappingPayload, hash })}\n`;
  return comment + yamlBody;
}

/** Parses back a LifecycleMapping from YAML if an embedded comment is present and not diverged (F11, F18). */
export function parseLifecycleMappingFromYaml(yamlSource: string): LifecycleMapping | null {
  if (!yamlSource) return null;
  const match = yamlSource.match(/^#\s*gitsync-lifecycle-mapping:\s*(.+)$/m);
  if (!match || !match[1]) return null;
  try {
    const data = JSON.parse(match[1]);
    if (!data || typeof data !== "object") return null;
    if (typeof data.states !== "object" || data.states === null) return null;
    // F11 & F18: verify neither the body nor the embedded comment has diverged
    const { hash, ...mappingPayload } = data;
    const body = yamlSource.replace(/^#\s*gitsync-lifecycle-mapping:.*(?:\r?\n|$)/m, "");
    const jsonForHash = JSON.stringify(mappingPayload);
    const expectedHash = computeYamlHash(jsonForHash + "\n" + body);
    if (!hash || hash !== expectedHash) {
      return null;
    }
    return {
      states: data.states ?? {},
      mergedBaseBranch: typeof data.mergedBaseBranch === "string" ? data.mergedBaseBranch : "^main$",
      branchRules: Array.isArray(data.branchRules) ? data.branchRules : [],
    };
  } catch {
    return null;
  }
}

// ---- events → rule events ----------------------------------------------------------------------------
function baseEvent(trigger: string, payload: any): RuleEvent {
  const pr = payload?.pull_request ?? payload?.check_suite?.pull_requests?.[0] ?? payload?.check_run?.check_suite?.pull_requests?.[0] ?? {};
  const event: RuleEvent = { trigger };
  if (typeof payload?.repository?.full_name === "string") event.repo = payload.repository.full_name;
  if (typeof pr.base?.ref === "string") event.base_branch = pr.base.ref;
  if (typeof pr.head?.ref === "string") event.head_branch = pr.head.ref;
  if (Array.isArray(pr.labels)) event.labels = pr.labels.map((l: any) => l?.name).filter((n: unknown): n is string => typeof n === "string");
  if (typeof pr.user?.login === "string") event.author = pr.user.login;
  const prCtx: Record<string, unknown> = {};
  if (pr.number !== undefined) prCtx.number = pr.number;
  if (typeof pr.title === "string") prCtx.title = pr.title;
  if (typeof pr.html_url === "string") prCtx.url = pr.html_url;
  if (event.head_branch) prCtx.branch = event.head_branch;
  if (event.base_branch) prCtx.base = event.base_branch;
  if (event.author) prCtx.author = event.author;
  event.context = { pr: prCtx };
  return event;
}

export interface ReviewSummary {
  user?: { id?: number; login?: string };
  state?: string;
  submitted_at?: string;
}

export interface CheckSuiteSummary {
  status?: string;
  conclusion?: string | null;
  latest_check_runs_count?: number;
}

export interface CombinedCommitStatus {
  state?: string;
  total_count?: number;
  statuses?: unknown[];
}

/**
 * Evaluates whether a PR is ready for merge based on real GitHub state (F7, F9):
 * - Reviews: latest actionable review per reviewer is APPROVED, and none is CHANGES_REQUESTED (with >= 1 approval).
 * - Checks: check suites are completed with success, neutral, or skipped; ignores latest_check_runs_count === 0; stale is non-blocking.
 * - Commit statuses: combined status is success, or commit has zero statuses.
 */
export function isReadyForMerge(
  reviews: ReviewSummary[],
  checkSuites: CheckSuiteSummary[],
  commitStatus?: CombinedCommitStatus | null
): boolean {
  if (Array.isArray(checkSuites)) {
    for (const s of checkSuites) {
      if (s?.latest_check_runs_count === 0) continue;
      if (s?.conclusion === "stale") continue;
      if (s?.status !== "completed") return false;
      if (s?.conclusion !== "success" && s?.conclusion !== "neutral" && s?.conclusion !== "skipped") {
        return false;
      }
    }
  }

  if (commitStatus && typeof commitStatus.state === "string") {
    const count = commitStatus.total_count ?? (Array.isArray(commitStatus.statuses) ? commitStatus.statuses.length : undefined);
    if (commitStatus.state === "success") {
      // Passes
    } else if (commitStatus.state === "pending" && count === 0) {
      // GitHub combined status returns state="pending" with total_count=0 when no statuses exist
    } else {
      return false;
    }
  }

  if (!Array.isArray(reviews) || reviews.length === 0) return false;
  const latestByReviewer = new Map<string, string>();
  for (const r of reviews) {
    const reviewer = String(r?.user?.id ?? r?.user?.login ?? "");
    if (!reviewer) continue;
    const state = String(r?.state ?? "").toUpperCase();
    if (state === "APPROVED" || state === "CHANGES_REQUESTED" || state === "DISMISSED") {
      latestByReviewer.set(reviewer, state);
    }
  }
  if (latestByReviewer.size === 0) return false;
  let hasApproval = false;
  for (const state of latestByReviewer.values()) {
    if (state === "CHANGES_REQUESTED") return false;
    if (state === "APPROVED") hasApproval = true;
  }
  return hasApproval;
}

export interface OctokitRequest {
  request<T = any>(route: string, params?: Record<string, unknown>): Promise<{ data: T; headers?: Record<string, unknown> }>;
}

export interface GithubCollection<T> { items: T[]; complete: boolean; nextPage?: number }

/** Numbered pagination with explicit completeness at a safety bound. Link and totals take precedence over page size. */
export async function readGithubCollection<T>(
  octokit: OctokitRequest, route: string, params: Record<string, unknown>,
  select: (data: any) => T[], options: { maxPages?: number; startPage?: number; total?: (data: any) => unknown } = {},
): Promise<GithubCollection<T>> {
  const items: T[] = [];
  const start = options.startPage ?? 1;
  for (let page = start; page < start + (options.maxPages ?? 100); page++) {
    const res = await octokit.request(route, { ...params, per_page: 100, page });
    const batch = select(res.data);
    if (!Array.isArray(batch)) throw new Error(`Invalid GitHub collection response for ${route}`);
    items.push(...batch);
    const headers = res.headers ?? {};
    const link = Object.entries(headers).find(([key]) => key.toLowerCase() === "link")?.[1];
    const total = options.total?.(res.data);
    const remaining = typeof total === "number" && Number.isFinite(total) ? (start - 1) * 100 + items.length < total : undefined;
    const hasNext = typeof link === "string" ? /;\s*rel=["']?next\b/.test(link)
      : remaining ?? batch.length >= 100;
    if (!hasNext && remaining === true) return { items, complete: false, nextPage: page + 1 };
    if (!hasNext) return { items, complete: true };
    // An empty page advertised as unfinished cannot advance the collection safely.
    if (!batch.length) return { items, complete: false, nextPage: page };
  }
  return { items, complete: false, nextPage: start + (options.maxPages ?? 100) };
}

/** Use repository HTML URLs from verified deliveries/API responses; REST /api/v3 paths are never web paths. */
export async function githubRepositoryWebUrl(
  octokit: OctokitRequest, repo: { owner: string; repo: string; id: number }, delivered?: any, apiBaseUrl?: string,
): Promise<string> {
  const valid = (value: any): string | null => {
    if (Number(value?.id) !== repo.id || typeof value?.html_url !== "string") return null;
    try {
      const url = new URL(value.html_url);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
      if (decodeURIComponent(url.pathname).replace(/\/$/, "").toLowerCase() !== `/${repo.owner}/${repo.repo}`.toLowerCase()) return null;
      return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
    } catch { return null; }
  };
  const supplied = valid(delivered);
  if (supplied) return supplied;
  const fetched = valid((await octokit.request("GET /repos/{owner}/{repo}", { owner: repo.owner, repo: repo.repo })).data);
  if (fetched) return fetched;
  const origin = apiBaseUrl ? new URL(apiBaseUrl).origin : "https://github.com";
  return `${origin}/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
}

/** Reviews arrive chronologically; latest decisions must be evaluated only after a complete read. */
export function readPrReviews(octokit: OctokitRequest, repo: { owner: string; repo: string }, prNumber: number) {
  // A deliberate safety bound is explicit in the returned contract; page 20 has no special meaning.
  return readGithubCollection<ReviewSummary>(octokit, "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
    { ...repo, pull_number: prNumber }, (data) => data, { maxPages: 100 });
}

/** Both lifecycle and fenced-continuation callers must run readiness after these events' own rules. */
export function shouldReevaluatePrReadiness(event: string, payload: any): boolean {
  return event === "pull_request_review" && payload?.action === "submitted" && String(payload?.review?.state ?? "").toLowerCase() === "approved"
    || event === "pull_request" && (payload?.action === "ready_for_review" || payload?.action === "reopened");
}

/** Fetches complete reviews, suites and combined status. Unavailable or incomplete data fails closed. */
export async function checkPrReadiness(
  octokit: OctokitRequest,
  repo: { owner: string; repo: string },
  prNumber: number,
  headSha: string,
  hooks?: { onUnavailable?: (info: { what: "commit_status"; status: number }) => void | Promise<void> }
): Promise<boolean> {
  const fetchCombinedStatus = async (): Promise<CombinedCommitStatus | null> => {
    try {
      const res = await octokit.request<CombinedCommitStatus>("GET /repos/{owner}/{repo}/commits/{ref}/status", {
        ...repo, ref: headSha,
      });
      if (!res.data || typeof res.data.state !== "string") return null;
      return res.data;
    } catch (err) {
      const failure = classifyGithubError(err);
      if (failure.kind === "permission" || failure.kind === "not_found") {
        const status = Number((err as any)?.status ?? (err as any)?.response?.status);
        await hooks?.onUnavailable?.({ what: "commit_status", status });
        return null;
      }
      throw err; // Preserve rate-limit response/deadline for the shared queue/outbox policy.
    }
  };
  const [reviews, suites, status] = await Promise.all([
    readPrReviews(octokit, repo, prNumber),
    readGithubCollection<CheckSuiteSummary>(octokit, "GET /repos/{owner}/{repo}/commits/{ref}/check-suites",
      { ...repo, ref: headSha }, (data) => data?.check_suites, { maxPages: 20, total: (data) => data?.total_count }),
    fetchCombinedStatus(),
  ]);
  if (!reviews.complete || !suites.complete || status === null) return false;
  return isReadyForMerge(reviews.items, suites.items, status);
}

export interface PrRuleEventOptions {
  isReadyForMerge?: boolean;
  reviews?: ReviewSummary[];
  checkSuites?: CheckSuiteSummary[];
  commitStatus?: CombinedCommitStatus | null;
}

/** `pull_request` / `pull_request_review` deliveries → a §7.1 lifecycle trigger, or null when it is not one. */
export function prEventToRuleEvent(
  event: string,
  payload: any,
  options?: PrRuleEventOptions
): RuleEvent | null {
  const action: unknown = payload?.action;
  const pr = payload?.pull_request ?? payload?.check_suite?.pull_requests?.[0] ?? payload?.check_run?.check_suite?.pull_requests?.[0];
  if (!pr) return null;
  const ready = options?.isReadyForMerge ?? (options?.reviews && options?.checkSuites ? isReadyForMerge(options.reviews, options.checkSuites, options.commitStatus) : false);

  let trigger: string | null = null;
  if (event === "pull_request") {
    switch (action) {
      case "opened": trigger = pr.draft ? "pull_request.drafted" : "pull_request.opened"; break;
      case "converted_to_draft": trigger = "pull_request.drafted"; break;
      case "ready_for_review": trigger = "pull_request.opened"; break;
      case "review_requested": trigger = "pull_request.review_requested"; break;
      case "closed": trigger = pr.merged ? "pull_request.merged" : "pull_request.closed_unmerged"; break;
      case "reopened": trigger = "pull_request.reopened"; break;
      default: {
        if (!pr.draft && !pr.merged && (pr.state ?? "open") === "open" && ready) {
          trigger = "pull_request.ready_for_merge";
        }
      }
    }
  } else if (event === "pull_request_review" && action === "submitted") {
    const state = String(payload?.review?.state ?? "").toLowerCase();
    if (state === "approved") {
      trigger = (!pr.draft && !pr.merged && (pr.state ?? "open") === "open" && ready) ? "pull_request.ready_for_merge" : "pull_request.approved";
    } else if (state === "changes_requested") {
      trigger = "pull_request.changes_requested";
    }
  } else if (event === "check_suite" && action === "completed") {
    const conclusion = String(payload?.check_suite?.conclusion ?? "").toLowerCase();
    if (conclusion === "success" || conclusion === "neutral") {
      if (!pr.draft && !pr.merged && (pr.state ?? "open") === "open" && ready) {
        trigger = "pull_request.ready_for_merge";
      }
    }
  }
  return trigger ? baseEvent(trigger, payload) : null;
}

/** A branch push as the `push` trigger (the "branch pushed" default); only branch refs qualify. */
export function pushToRuleEvent(payload: any): RuleEvent | null {
  const ref: unknown = payload?.ref;
  if (typeof ref !== "string" || !ref.startsWith("refs/heads/") || payload?.deleted === true) return null;
  const event: RuleEvent = { trigger: "push", head_branch: ref.slice("refs/heads/".length) };
  if (typeof payload?.repository?.full_name === "string") event.repo = payload.repository.full_name;
  if (typeof payload?.sender?.login === "string") event.author = payload.sender.login;
  return event;
}

// ---- state targets -----------------------------------------------------------------------------------
export interface StateRef { id: string; name: string; group: string; default?: boolean }
export type StateResolution = { ok: true; stateId: string } | { ok: false; reason: "not_found" | "ambiguous" };

const GROUPS = ["backlog", "unstarted", "started", "completed", "cancelled", "triage"];
const lower = (s: string) => s.trim().toLowerCase();

/**
 * `group`, `group:Name` or `Name`, resolved inside one project's states. The group is the stable key;
 * the name picks within it. A bare name is accepted only when it is unique in the project (§7.1).
 */
export function resolveStateTarget(states: StateRef[], target: string): StateResolution {
  const t = target.trim();
  const colon = t.indexOf(":");
  const head = colon > 0 ? lower(t.slice(0, colon)) : null;
  if (head && GROUPS.includes(head)) {
    const inGroup = states.filter((s) => lower(s.group) === head);
    const name = lower(t.slice(colon + 1));
    if (inGroup.length === 0) return { ok: false, reason: "not_found" };
    const named = inGroup.filter((s) => lower(s.name) === name);
    if (named.length === 1) return { ok: true, stateId: named[0]!.id };
    if (named.length > 1) return { ok: false, reason: "ambiguous" };
    return inGroup.length === 1 ? { ok: true, stateId: inGroup[0]!.id } : { ok: false, reason: "not_found" };
  }
  if (GROUPS.includes(lower(t))) {
    const inGroup = states.filter((s) => lower(s.group) === lower(t));
    const pick = inGroup.find((s) => s.default) ?? inGroup[0];
    return pick ? { ok: true, stateId: pick.id } : { ok: false, reason: "not_found" };
  }
  const named = states.filter((s) => lower(s.name) === lower(t));
  if (named.length === 1) return { ok: true, stateId: named[0]!.id };
  return { ok: false, reason: named.length > 1 ? "ambiguous" : "not_found" };
}

// ---- executor ----------------------------------------------------------------------------------------
export interface LinkedIssue {
  slug: string;
  projectId: string;
  issueId: string;
  /** Link tier (§6). Defaults to closing. Relation links never change state; non-closing skip the merge state. */
  tier?: "closing" | "non_closing" | "relation";
  /** Every PR linked to this item. When given, a merge advances the item only once all of them merged (§6). */
  linkedPrs?: { state: "open" | "merged" | "closed_unmerged" }[];
}

export interface ExecutorDeps {
  writer: {
    apply(write: PlaneWrite, opts?: { actorToken?: SecretString }): Promise<PlaneWriteResult>;
    mutateIssue?(
      target: { slug: string; projectId: string; issueId: string },
      mutation: any,
      opts?: { actorToken?: SecretString }
    ): Promise<{ ok: boolean; id?: string }>;
  };
  listStates(projectId: string): Promise<StateRef[]>;
  issues: LinkedIssue[];
  actorToken?: SecretString;
  /** Current label and assignee ids of an issue, needed because Plane replaces both lists on write. */
  getIssueFields?(issue: LinkedIssue): Promise<{ labels: string[]; assignees: string[] }>;
  /** Maps a rule's `assign:` value to a Plane user id. */
  resolveAssignee?(who: string, issue: LinkedIssue): Promise<string | null>;
  /** Workspace slug for `create_issue`, which has no linked issue to borrow it from. */
  slug?: string;
}

export function createRuleExecutor(deps: ExecutorDeps): ActionExecutor {
  const opts = deps.actorToken ? { actorToken: deps.actorToken } : undefined;
  const write = (w: PlaneWrite) => deps.writer.apply(w, opts);
  const stateCache = new Map<string, Promise<StateRef[]>>();
  const statesOf = (projectId: string) => {
    let p = stateCache.get(projectId);
    if (!p) { p = deps.listStates(projectId); stateCache.set(projectId, p); }
    return p;
  };
  // F3: track in-memory field state per issue across actions so queued writes
  // do not re-fetch stale remote fields and overwrite prior actions on the same issue.
  const fieldsCache = new Map<string, { labels: string[]; assignees: string[] }>();
  const issueKey = (issue: LinkedIssue) => `${issue.slug}/${issue.projectId}/${issue.issueId}`;

  const needFields = async (issue: LinkedIssue, what: string) => {
    const key = issueKey(issue);
    let cur = fieldsCache.get(key);
    if (!cur) {
      if (!deps.getIssueFields) throw new Error(`${what} needs the issue's current labels and assignees, which this executor was not given`);
      const fetched = await deps.getIssueFields(issue);
      cur = { labels: [...fetched.labels], assignees: [...fetched.assignees] };
      fieldsCache.set(key, cur);
    }
    return cur;
  };

  /** §6: only closing links advance on merge, and only when every linked PR has merged. */
  const mayChangeState = (issue: LinkedIssue, trigger: string): boolean => {
    const tier = issue.tier ?? "closing";
    if (tier === "relation") return false;
    if (trigger !== "pull_request.merged") return true;
    if (tier === "non_closing") return false;
    return issue.linkedPrs === undefined || allLinkedPrsMerged(issue.linkedPrs);
  };

  return {
    async execute(action: Action, event: RuleEvent): Promise<void> {
      if (action.type === "create_issue") {
        // One new item, however many linked issues the event touched.
        const slug = deps.slug ?? deps.issues[0]?.slug;
        if (!slug) throw new Error("create_issue needs a workspace slug");
        await write({ kind: "create_issue", slug, projectId: action.project, fields: { name: action.title } });
        return;
      }
      for (const issue of deps.issues) {
        const base = { slug: issue.slug, projectId: issue.projectId, issueId: issue.issueId };
        switch (action.type) {
          case "set_state": {
            if (!mayChangeState(issue, event.trigger)) break;
            const r = resolveStateTarget(await statesOf(issue.projectId), action.state);
            if (!r.ok) throw new Error(`state "${action.state}" ${r.reason === "ambiguous" ? "is ambiguous" : "does not exist"} in project ${issue.projectId}`);
            const updateWrite = {
              kind: "update_issue" as const,
              ...base,
              fields: { state: r.stateId },
              ...(event.trigger === "branch.created" ? { skipTerminalState: true } : {}),
            };
            await write(updateWrite as PlaneWrite);
            break;
          }
          case "comment":
            await write({ kind: "add_comment", ...base, commentHtml: `<p>${escapeHtml(action.body)}</p>` });
            break;
          case "log_time":
            // Plane CE has no worklog API; the logged time becomes a comment (§7.2).
            await write({ kind: "add_comment", ...base, commentHtml: `<p>Time logged: ${escapeHtml(action.duration)}</p>` });
            break;
          case "add_link":
            await write({ kind: "add_link", ...base, url: action.url, title: action.title });
            break;
          case "add_label": {
            if (deps.writer.mutateIssue) {
              await deps.writer.mutateIssue(base, { kind: "add_label", name: action.label }, opts);
              break;
            }
            const label = await write({ kind: "upsert_label", slug: issue.slug, projectId: issue.projectId, name: action.label });
            if (!label.id) throw new Error(`Plane returned no id for label "${action.label}"`);
            const cur = await needFields(issue, "add_label");
            if (!cur.labels.includes(label.id)) {
              cur.labels.push(label.id);
              await write({ kind: "update_issue", ...base, fields: { labels: [...cur.labels] } });
            }
            break;
          }
          case "remove_label": {
            if (deps.writer.mutateIssue) {
              await deps.writer.mutateIssue(base, { kind: "remove_label", name: action.label }, opts);
              break;
            }
            const label = await write({ kind: "upsert_label", slug: issue.slug, projectId: issue.projectId, name: action.label });
            if (!label.id) break;
            const cur = await needFields(issue, "remove_label");
            if (cur.labels.includes(label.id)) {
              cur.labels = cur.labels.filter((l) => l !== label.id);
              await write({ kind: "update_issue", ...base, fields: { labels: [...cur.labels] } });
            }
            break;
          }
          case "assign": {
            const id = deps.resolveAssignee ? await deps.resolveAssignee(action.assignee, issue) : action.assignee;
            if (!id) break; // an unmapped user leaves the field alone (§7.3)
            if (deps.writer.mutateIssue) {
              await deps.writer.mutateIssue(base, { kind: "assign", id }, opts);
              break;
            }
            const cur = await needFields(issue, "assign");
            if (!cur.assignees.includes(id)) {
              cur.assignees.push(id);
              await write({ kind: "update_issue", ...base, fields: { assignees: [...cur.assignees] } });
            }
            break;
          }
        }
      }
    },
  };
}

