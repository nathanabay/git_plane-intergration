// Development information on the work item (spec §7.4): Jira-vocabulary rollups delivered through
// Plane's links endpoint, previews detected from deployments, and in-place updates of one link per
// rollup (Plane rejects duplicate URLs, so a changing status must edit the link, not add another).
import type { SecretString } from "../auth/identity.ts";
import type { Db } from "../db/migrate.ts";
import { getDevInfoLink, upsertDevInfoLink } from "../db/ledgers.ts";
import { safeUrl } from "../github/html.ts";
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
