// Development information on the work item (spec §7.4): Jira-vocabulary rollups delivered through
// Plane's links endpoint, previews detected from deployments, and in-place updates of one link per
// rollup (Plane rejects duplicate URLs, so a changing status must edit the link, not add another).
import type { SecretString } from "../auth/identity.ts";
import type { Db } from "../db/migrate.ts";
import { getDevInfoLink, upsertDevInfoLink } from "../db/ledgers.ts";
import { safeUrl } from "../github/html.ts";
import { parseReferences } from "../parse/references.ts";
import { PlaneApiError } from "./plane.ts";
import type { PlaneWrite, PlaneWriteResult } from "./plane.ts";
import type { FrozenWriteAuthority } from "../app/mappings.ts";

export type PrStatus = "OPEN" | "MERGED" | "DECLINED";
export type ReviewStatus = "REVIEW" | "APPROVAL" | "REJECTED";

export interface RollupPr {
  number: number;
  title: string;
  state: string;
  merged: boolean;
  reviews?: { state: string; user?: { login?: string } | null }[];
}

export function prStatus(pr: Pick<RollupPr, "state" | "merged">): PrStatus {
  if (pr.merged) return "MERGED";
  return String(pr.state).toLowerCase() === "open" ? "OPEN" : "DECLINED";
}

/**
 * Review rollup: any reviewer's standing change request is REJECTED, otherwise any approval is
 * APPROVAL, otherwise the PR is still in REVIEW. Only each reviewer's latest decisive review counts.
 */
export function reviewStatus(reviews: NonNullable<RollupPr["reviews"]>): ReviewStatus {
  const latest = new Map<string, string>();
  reviews.forEach((r, i) => {
    const state = String(r.state).toUpperCase();
    const who = r.user?.login ?? `#${i}`;
    if (state === "APPROVED" || state === "CHANGES_REQUESTED") latest.set(who, state);
    else if (state === "DISMISSED") latest.delete(who);
  });
  const states = [...latest.values()];
  if (states.includes("CHANGES_REQUESTED")) return "REJECTED";
  return states.includes("APPROVED") ? "APPROVAL" : "REVIEW";
}

export function categorisedTitle(category: string, text: string): string {
  const cat = category.replace(/[\[\]\r\n]/g, "").trim();
  return `[${cat}] ${text.replace(/[\r\n]+/g, " ").trim()}`;
}

/** `[PR] #12 Title · OPEN · REVIEW`; the review part only matters while the PR is open. */
export function prRollupTitle(pr: RollupPr): string {
  const status = prStatus(pr);
  const parts: string[] = [status];
  if (status === "OPEN") parts.push(reviewStatus(pr.reviews ?? []));
  return categorisedTitle("PR", `#${pr.number} ${pr.title} · ${parts.join(" · ")}`);
}

export type BuildStatus = "pass" | "fail" | "pending";
const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"]);
const PASSED = new Set(["success", "neutral", "skipped"]);

/** pass if every run passed, fail if any failed, otherwise (including no runs) pending. */
export function buildStatus(runs: { conclusion?: string | null }[]): BuildStatus {
  if (runs.some((r) => r.conclusion && FAILED.has(r.conclusion))) return "fail";
  if (runs.length > 0 && runs.every((r) => r.conclusion && PASSED.has(r.conclusion))) return "pass";
  return "pending";
}

/** Context7 /websites/github_en_rest, /rest/commits/statuses: the combined state covers the latest
 * status of every context. No statuses is pending, never a passing build. */
export function commitStatusBuildStatus(combined: { state?: unknown; total_count?: unknown }): BuildStatus {
  const count = combined?.total_count;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
    throw new Error("Invalid combined GitHub status count");
  if (count === 0) return "pending";
  switch (combined.state) {
    case "success": return "pass";
    case "failure": return "fail";
    case "pending": return "pending";
    default: throw new Error("Invalid combined GitHub status state");
  }
}

export interface Preview { name: string; url: string }

const PROVIDERS: [suffix: string, name: string][] = [
  [".vercel.app", "Vercel"],
  [".netlify.app", "Netlify"],
  [".pages.dev", "Cloudflare Pages"],
  [".amplifyapp.com", "AWS Amplify"],
];

export function detectPreviews(input: { environmentUrls?: string[]; body?: string }): Preview[] {
  const out: Preview[] = [];
  const seen = new Set<string>();
  const add = (name: string, url: string) => { if (!seen.has(url)) { seen.add(url); out.push({ name, url }); } };
  for (const raw of input.environmentUrls ?? []) {
    const url = safeUrl(raw);
    if (!url) continue;
    const host = new URL(url).hostname.toLowerCase();
    const hit = PROVIDERS.find(([suffix]) => host.endsWith(suffix));
    if (hit) add(hit[1], raw.trim());
  }
  for (const m of (input.body ?? "").matchAll(/\[([^\]\n]{0,100}?\bPreview)\]\(\s*(https?:\/\/[^\s)]+)\s*\)/gi)) {
    const url = safeUrl(m[2]);
    if (url) add(m[1]!.trim(), m[2]!.trim());
  }
  return out;
}

export function prRollupKey(repoId: number | string, number: number): string {
  return `pr:${repoId}:${number}`;
}

export interface RollupTarget {
  slug: string;
  projectId: string;
  issueId: string;
  /** Source mapping snapshot carried intact through standalone rollup registration and inline fallback. */
  _authority?: FrozenWriteAuthority;
}
export interface RollupDeps {
  db: Db;
  writer: { upsertRollup?(target: RollupTarget, key: string, link: { title: string; url: string }): Promise<PlaneWriteResult>; apply(write: PlaneWrite, opts?: { actorToken?: SecretString }): Promise<PlaneWriteResult> };
  /** Recovers the id of an existing link with this URL when Plane reports a duplicate we hold no id for. */
  findLinkId?(target: RollupTarget, url: string): Promise<string | null>;
}

/** First call adds the link and stores its id; later calls edit that same link in place. */
export async function upsertRollupLink(
  deps: RollupDeps, target: RollupTarget, key: string, link: { title: string; url: string },
): Promise<{ action: "added" | "updated" | "unchanged-duplicate"; linkId?: string }> {
  const { db, writer } = deps;
  if (writer.upsertRollup) {
    await writer.upsertRollup(target, key, link);
    return { action: "updated" }; // the outbox resolves/stores the actual link ID after execution
  }
  const remember = (linkId: string) => upsertDevInfoLink(db, { planeIssueId: target.issueId, key, planeLinkId: linkId });

  const add = async () => {
    const res = await writer.apply({ kind: "add_link", ...target, ...link });
    if (res.id) { await remember(res.id); return { action: "added" as const, linkId: res.id }; }
    // Plane already has this URL on the item but we hold no id for it; recover it if we can.
    const found = deps.findLinkId ? await deps.findLinkId(target, link.url) : null;
    if (!found) return { action: "unchanged-duplicate" as const };
    await writer.apply({ kind: "update_link", ...target, linkId: found, ...link });
    await remember(found);
    return { action: "updated" as const, linkId: found };
  };

  const stored = await getDevInfoLink(db, target.issueId, key);
  if (!stored) return add();
  try {
    await writer.apply({ kind: "update_link", ...target, linkId: stored, ...link });
    return { action: "updated", linkId: stored };
  } catch (err) {
    // The link was deleted in Plane; the rollup comes back as a new link.
    if (err instanceof PlaneApiError && err.status === 404) return add();
    throw err;
  }
}

// ---- branch names (N3) --------------------------------------------------------------------------------------
// A per-mapping template (repo_mappings.branch_template) renders the branch name offered on the work item.
// Placeholders: {key} (required; e.g. WEB-12), {title-slug}, {username} (the viewer's GitHub login, when known).

export const DEFAULT_BRANCH_TEMPLATE = "{key}-{title-slug}";
const PLACEHOLDERS = new Set(["key", "title-slug", "username"]);
const TEMPLATE_LITERAL = /^[A-Za-z0-9._\/-]*$/;
const MAX_TEMPLATE = 120;
const MAX_SLUG = 50;
const MAX_BRANCH = 200;

/** Lowercase ASCII words joined by hyphens, cut at a word boundary. */
export function titleSlug(title: string, max = MAX_SLUG): string {
  const words = title.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let out = "";
  for (const w of words) {
    const next = out ? `${out}-${w}` : w;
    if (next.length > max) { if (!out) out = w.slice(0, max); break; }
    out = next;
  }
  return out;
}

/** git check-ref-format rules for a branch under refs/heads/ (plus: not starting with "-"). */
export function isValidGitBranchName(name: string): boolean {
  if (!name || name.length > MAX_BRANCH || name === "@") return false;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false;
  if (/[\x00-\x20\x7f~^:?*\[\\]/.test(name) || name.includes("..") || name.includes("//") || name.includes("@{")) return false;
  return name.split("/").every((c) => c !== "" && !c.startsWith(".") && !c.endsWith(".lock"));
}

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]!);
}

/**
 * Renders a template. A missing {username} is dropped together with the separator after it, so
 * `{username}/{key}-{title-slug}` still gives `WEB-12-fix-login` for the suggested link.
 */
export function renderBranchName(template: string | null | undefined, v: { key: string; title: string; username?: string | null }): string {
  const t = template ?? DEFAULT_BRANCH_TEMPLATE;
  const user = (v.username ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const slug = titleSlug(v.title);
  let out = t;
  if (!user) out = out.replace(/\{username\}[\/_-]?/g, "");
  if (!slug) out = out.replace(/[\/_-]?\{title-slug\}/g, "");
  out = out.replace(/\{key\}/g, v.key).replace(/\{title-slug\}/g, slug).replace(/\{username\}/g, user);
  out = out.replace(/\/{2,}/g, "/").replace(/-{2,}/g, "-").replace(/^[\/._-]+|[\/._-]+$/g, "");
  if (out.length > MAX_BRANCH) out = out.slice(0, MAX_BRANCH).replace(/[\/._-]+$/g, "");
  return out;
}

export type TemplateCheck = { ok: true } | { ok: false; reason: string };

/**
 * A template is valid when it uses only known placeholders and safe literal characters, contains {key},
 * and renders to a valid branch name from which our branch parser reads the key back (otherwise a branch
 * created from it would never link to the work item).
 */
/** The keys our push and PR handling read from a branch name. */
export function branchKeys(branch: string): string[] {
  return parseReferences({ branch }).refs.map((r) => r.identifier);
}

export function validateBranchTemplate(template: string, parseBranchKeys: (branch: string) => string[] = branchKeys): TemplateCheck {
  if (typeof template !== "string" || template.length === 0) return { ok: false, reason: "The template is empty" };
  if (template.length > MAX_TEMPLATE) return { ok: false, reason: `The template is longer than ${MAX_TEMPLATE} characters` };
  const names = placeholders(template);
  const unknown = names.find((n) => !PLACEHOLDERS.has(n));
  if (unknown !== undefined) return { ok: false, reason: `Unknown placeholder {${unknown}}; use {key}, {title-slug} or {username}` };
  if (!names.includes("key")) return { ok: false, reason: "The template must contain {key}" };
  if (!TEMPLATE_LITERAL.test(template.replace(/\{[^{}]*\}/g, ""))) return { ok: false, reason: "Use only letters, digits, '.', '_', '-' and '/' outside placeholders" };
  for (const sample of [
    { key: "ABC-123", title: "Fix the login page", username: "octocat" },
    { key: "ABC-123", title: "", username: null },
  ]) {
    const name = renderBranchName(template, sample);
    if (!isValidGitBranchName(name)) return { ok: false, reason: `The template renders an invalid branch name (${name || "empty"})` };
    if (!parseBranchKeys(name).map((k) => k.toUpperCase()).includes(sample.key)) {
      return { ok: false, reason: `The key cannot be read back from ${name}; separate {key} with '-' or '/'` };
    }
  }
  return { ok: true };
}

/** The same rollup key and URL push.ts uses, so the first push turns the suggestion into the branch link. */
export function branchRollupKey(repoId: number | string, branch: string): string {
  return `branch:${repoId}:${branch}`;
}

export function branchTreeUrl(repoWebUrl: string, branch: string): string {
  return `${repoWebUrl.replace(/\/+$/, "")}/tree/${encodeURIComponent(branch).replace(/%2F/g, "/")}`;
}

export const SUGGESTED_PREFIX = "suggested: ";

export function suggestedBranchTitle(branch: string): string {
  return categorisedTitle("Branch", SUGGESTED_PREFIX + branch);
}

/**
 * Adds `[Branch] suggested: <name>` to a work item when it is linked or created, so there is a name to copy
 * at once. Callers check the mapping's linkback setting first. Returns the branch name.
 */
export async function upsertSuggestedBranchLink(
  deps: RollupDeps, target: RollupTarget,
  s: { repoId: number | string; repoWebUrl: string; template: string | null; key: string; title: string },
): Promise<string> {
  const branch = renderBranchName(s.template, { key: s.key, title: s.title });
  if (!isValidGitBranchName(branch)) throw new Error(`Branch template renders an invalid name: ${branch}`);
  await upsertRollupLink(deps, target, branchRollupKey(s.repoId, branch), { title: suggestedBranchTitle(branch), url: branchTreeUrl(s.repoWebUrl, branch) });
  return branch;
}

// ---- reading rollup links back (Development panel) ----------------------------------------------------------
export type DevLinkCategory = "PR" | "CI" | "Deploy" | "Preview" | "Branch";
export interface DevLink { category: DevLinkCategory; text: string; url: string; suggested?: boolean }
const CATEGORIES = new Set<DevLinkCategory>(["PR", "CI", "Deploy", "Preview", "Branch"]);

/** Parses `[Category] text` link titles written by this service; other links are ignored. */
export function parseDevLinks(links: { title?: unknown; url?: unknown }[]): DevLink[] {
  const out: DevLink[] = [];
  for (const l of links) {
    const m = typeof l.title === "string" ? /^\[([A-Za-z]+)\] (.*)$/s.exec(l.title) : null;
    const url = typeof l.url === "string" ? safeUrl(l.url) : null;
    if (!m || !url || !CATEGORIES.has(m[1] as DevLinkCategory)) continue;
    const category = m[1] as DevLinkCategory;
    const text = m[2]!;
    if (category === "Branch" && text.startsWith(SUGGESTED_PREFIX)) out.push({ category, text: text.slice(SUGGESTED_PREFIX.length), url, suggested: true });
    else out.push({ category, text, url });
  }
  return out;
}
