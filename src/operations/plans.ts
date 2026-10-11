// Durable result-dependent steps. References are data, so recovery never needs a live reducer closure.
import type { appendAudit, upsertSyncLink } from "../db/ledgers.ts";
import type { InboundJob } from "../queue/index.ts";
import type { SecretString } from "../auth/identity.ts";

export type ResultReference = { $result: string };
export type StringReference = { $concat: (string | ResultReference)[] };
export const resultRef = (path: string): ResultReference => ({ $result: path });
export const resultText = (...parts: (string | ResultReference)[]): StringReference => ({ $concat: parts });
type Template<T> = T extends object ? { [K in keyof T]: Template<T[K]> | ResultReference | StringReference } : T;
export type OutboxPlanStep =
  | { kind: "write"; side: "plane" | "github"; write: object; bind?: string }
  | { kind: "sync_link"; link: Template<Parameters<typeof upsertSyncLink>[1]> }
  | { kind: "audit"; entry: Template<Parameters<typeof appendAudit>[1]> }
  | { kind: "clear_pending_link"; key: string }
  | { kind: "dev_info"; issueId: string; key: string; linkId: string | ResultReference };
export interface OutboxPlanOptions {
  actorToken?: SecretString;
  /** A later event joins an existing create workflow's ordering and retention group. */
  groupRoot?: string;
  bindings?: Record<string, string>;
  predecessor?: string;
  pendingMarker?: { key: string; root: string; link: Record<string, unknown> };
  pendingLink?: Record<string, unknown>;
  /** Reserve all Plane steps against an existing issue, including dependent label upserts. */
  target?: { slug: string; projectId: string; issueId: string };
}
export type PlanWriter = (key: string | undefined, steps: OutboxPlanStep[], opts?: OutboxPlanOptions) => Promise<{ ok: true; inserted?: boolean }>;
/** SA handles this target-specific continuation, rather than replaying an entire reducer. */
export interface ReducerContinuation {
  kind: "pr_created" | "mirror_created" | "mirror_pending";
  workspaceSlug?: string;
  job: InboundJob;
  mappingId: number;
  projectId: string;
  issueId: string;
  identifier: string;
}
export interface PlanMetadata {
  root: string;
  marker?: { key: string; root: string; link: Record<string, unknown> };
  bind?: string;
  predecessor?: string;
  bindings: Record<string, string>;
  after: Exclude<OutboxPlanStep, { kind: "write" }>[];
}

/** Resolve only explicit reference objects; missing results are an error, never fabricated IDs. */
export function resolvePlanValue(value: unknown, results: Record<string, unknown>): any {
  if (Array.isArray(value)) return value.map((v) => resolvePlanValue(v, results));
  if (!value || typeof value !== "object") return value;
  const v = value as Record<string, unknown>;
  if (typeof v.$result === "string") {
    const [binding, field, ...extra] = v.$result.split(".");
    if (!binding || !field || extra.length) throw new Error(`invalid outbox result reference ${v.$result}`);
    const found = (results[binding] as Record<string, unknown> | undefined)?.[field];
    if (found === undefined || found === null) throw new Error(`outbox result ${v.$result} is missing`);
    return found;
  }
  if (Array.isArray(v.$concat)) return v.$concat.map((p) => String(resolvePlanValue(p, results))).join("");
  return Object.fromEntries(Object.entries(v).map(([k, child]) => [k, resolvePlanValue(child, results)]));
}
