export type Tier = "closing" | "non_closing" | "relation";

export interface MagicWords { closing: string[]; non_closing: string[]; relation: string[] }

/** Exactly the spec §6 table. Instance settings (§8) may replace any list. */
export const DEFAULT_MAGIC_WORDS: MagicWords = {
  closing: [
    "close", "closes", "closed", "closing",
    "fix", "fixes", "fixed", "fixing",
    "resolve", "resolves", "resolved", "resolving",
    "complete", "completes", "completed", "completing",
    "implement", "implements", "implemented", "implementing",
  ],
  non_closing: ["ref", "refs", "references", "part of", "contributes to", "toward", "towards"],
  relation: ["relates to", "related to"],
};

/** Strongest first: a word listed under two tiers resolves to the stronger one. */
export const TIER_ORDER: readonly Tier[] = ["closing", "non_closing", "relation"];

export function tierRank(tier: Tier): number {
  return TIER_ORDER.length - TIER_ORDER.indexOf(tier);
}
