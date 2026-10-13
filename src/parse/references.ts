import type { PlaneClient } from "../sync/plane.ts";
import { PlaneApiError } from "../sync/plane.ts";
import { DEFAULT_MAGIC_WORDS, TIER_ORDER, tierRank } from "./magicWords.ts";
import type { MagicWords, Tier } from "./magicWords.ts";

export type { MagicWords, Tier } from "./magicWords.ts";

export interface IssueRef { identifier: string; project: string; sequence: number; tier: Tier; source: "branch" | "title" | "body" | "commit" }
export interface ParseResult { refs: IssueRef[]; skipped: string[]; createRequests: string[] }

// Plane project identifiers: a letter then up to 11 letters/digits, so 2-12 characters here (1-character
// "projects" like X-1 are ignored on purpose).
const PROJECT = "[A-Za-z][A-Za-z0-9]{1,11}";
const KEY_SRC = `(?<![A-Za-z0-9])(${PROJECT})-(\\d+)(?![A-Za-z0-9_])`;

// Technical tokens that look like keys (UTF-8, SHA-256, CVE-2024, ...). A small deny-list, not a heuristic:
// a real Plane project with one of these identifiers must be renamed or referenced through a magic word.
const NOT_PROJECTS = new Set(["UTF", "SHA", "ISO", "AES", "RSA", "CVE", "CWE", "RFC", "TLS", "SSL", "MD", "ES", "PEP", "USB", "HTTP", "IPV", "SSH", "GPT", "RS", "CRC", "UTC", "WIN"]);

type Source = IssueRef["source"];
const SOURCE_ORDER: Source[] = ["branch", "title", "body", "commit"];

function ref(project: string, seq: string, tier: Tier, source: Source): IssueRef | null {
  const p = project.toUpperCase();
  if (NOT_PROJECTS.has(p)) return null;
  const sequence = Number(seq);
  if (!Number.isSafeInteger(sequence)) return null;
  return { identifier: `${p}-${sequence}`, project: p, sequence, tier, source };
}

const escapeRe = (s: string) => s.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");

function tierLookup(words: MagicWords): Map<string, Tier> {
  const map = new Map<string, Tier>();
  for (const tier of TIER_ORDER) for (const w of words[tier]) {
    const k = w.trim().toLowerCase().replace(/\s+/g, " ");
    if (k && !map.has(k)) map.set(k, tier);
  }
  return map;
}

function magicRegex(words: MagicWords): RegExp | null {
  const all = TIER_ORDER.flatMap((t) => words[t]).map((w) => w.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  if (all.length === 0) return null;
  const key = `(?<![A-Za-z0-9])${PROJECT}-\\d+(?![A-Za-z0-9_])`;
  const sep = `(?:\\s*,\\s*(?:and\\s+)?|\\s+and\\s+|\\s*&\\s*|\\s+)`;
  return new RegExp(`(?<![A-Za-z0-9_])(${all.map(escapeRe).join("|")})(?![A-Za-z0-9_])\\s*:?\\s+(${key}(?:${sep}${key})*)`, "gi");
}

function scan(text: string, source: Source, words: MagicWords, out: IssueRef[], skip: Set<string>, creates: Set<string>): void {
  if (source === "body" || source === "title") {
    for (const m of text.matchAll(new RegExp(`(?<![A-Za-z0-9])(${PROJECT})-NEW(?![A-Za-z0-9_])`, "g"))) {
      if (!NOT_PROJECTS.has(m[1]!.toUpperCase())) creates.add(m[1]!.toUpperCase());
    }
  }
  if (source === "body") {
    for (const m of text.matchAll(new RegExp(`(?<![A-Za-z0-9_])(?:skip|ignore)\\s+${KEY_SRC}`, "gi"))) {
      const r = ref(m[1]!, m[2]!, "relation", source);
      if (r) skip.add(r.identifier);
    }
  }
  const lookup = tierLookup(words);
  const magic = magicRegex(words);
  // A magic-word occurrence already has its tier. Only independent occurrences
  // may compete with it; rescanning the same title key as bare would promote Ref.
  const classified = new Set<number>();
  if (magic) {
    for (const m of text.matchAll(magic)) {
      const tier = lookup.get(m[1]!.toLowerCase().replace(/\s+/g, " "));
      if (!tier) continue;
      for (const k of m[2]!.matchAll(new RegExp(KEY_SRC, "g"))) {
        classified.add(m.index! + m[0].length - m[2]!.length + k.index!);
        const r = ref(k[1]!, k[2]!, tier, source);
        if (r) out.push(r);
      }
    }
  }
  // Bare keys are uppercase-only in free text, which keeps prose like "step-2" out of the results.
  const bare: Tier = source === "title" || source === "branch" ? "closing" : "relation";
  const bareKey = source === "branch" ? KEY_SRC : KEY_SRC.replace(PROJECT, "[A-Z][A-Z0-9]{1,11}");
  for (const m of text.matchAll(new RegExp(bareKey, source === "branch" ? "gi" : "g"))) {
    if (classified.has(m.index!)) continue;
    const r = ref(m[1]!, m[2]!, bare, source);
    if (r) out.push(r);
  }
}

export function parseReferences(input: { branch?: string; title?: string; body?: string; commits?: string[] }, words: MagicWords = DEFAULT_MAGIC_WORDS): ParseResult {
  const found: IssueRef[] = [];
  const skip = new Set<string>();
  const creates = new Set<string>();

  if (input.branch) {
    // Bare branch keys remain case-insensitive/closing; explicit words use the
    // same classification as title/body/commit references.
    scan(input.branch, "branch", words, found, skip, creates);
  }
  if (input.title) scan(input.title, "title", words, found, skip, creates);
  if (input.body) scan(input.body, "body", words, found, skip, creates);
  for (const c of input.commits ?? []) scan(c, "commit", words, found, skip, creates);

  const best = new Map<string, IssueRef>();
  for (const r of found) {
    if (skip.has(r.identifier)) continue;
    const cur = best.get(r.identifier);
    if (!cur || tierRank(r.tier) > tierRank(cur.tier) || (tierRank(r.tier) === tierRank(cur.tier) && SOURCE_ORDER.indexOf(r.source) < SOURCE_ORDER.indexOf(cur.source))) best.set(r.identifier, r);
  }
  return { refs: [...best.values()], skipped: [...skip].sort(), createRequests: [...creates].sort() };
}

/** §6: all linked PRs must merge. Closed-unmerged PRs neither block nor count; with no merged PR it is false. */
export function allLinkedPrsMerged(prs: { state: "open" | "merged" | "closed_unmerged" }[]): boolean {
  return prs.some((p) => p.state === "merged") && !prs.some((p) => p.state === "open");
}

/**
 * Looks each identifier up through §1.2's identifier endpoint. 404 (no such sequence) and 403 (no such project,
 * or one the service account is not a member of — Plane answers 403 for both) mean the key is not a work item
 * we can see: it is reported as unknown with the status, never thrown, so one stray `JIRA-12` cannot fail the
 * delivery. 5xx and network errors still propagate so the delivery is retried.
 */
export async function resolveReferences(client: PlaneClient, slug: string, refs: IssueRef[]): Promise<{ found: { ref: IssueRef; issue: any }[]; unknown: IssueRef[]; statuses: Record<string, number> }> {
  const found: { ref: IssueRef; issue: any }[] = [];
  const unknown: IssueRef[] = [];
  const statuses: Record<string, number> = {};
  const cache = new Map<string, any>();
  for (const r of refs) {
    if (!cache.has(r.identifier)) {
      try {
        cache.set(r.identifier, await client.getIssueByIdentifier(slug, r.identifier));
      } catch (err) {
        if (err instanceof PlaneApiError && (err.status === 404 || err.status === 403)) {
          cache.set(r.identifier, null);
          statuses[r.identifier] = err.status;
        } else throw err;
      }
    }
    const issue = cache.get(r.identifier);
    if (issue) found.push({ ref: r, issue }); else unknown.push(r);
  }
  return { found, unknown, statuses };
}
