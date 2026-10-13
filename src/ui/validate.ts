// Request-body validation shared by the config API (server) and the React app (browser), so the
// form rejects exactly what the API would. Pure functions; no Node or DOM imports.
import { deriveGithubHosts } from "../github/hosts.ts";
import type { GithubEdition } from "../github/hosts.ts";
import { parseRules } from "../rules/engine.ts";

export class ValidationError extends Error {}

export const SYNC_DIRECTIONS = ["bidirectional", "github_to_plane"] as const;
export type SyncDirection = (typeof SYNC_DIRECTIONS)[number];

export const CONFLICT_FIELDS = ["title", "description", "state", "assignees", "labels", "comments"] as const;
export type ConflictField = (typeof CONFLICT_FIELDS)[number];
export const CONFLICT_POLICIES = ["last_write_wins", "source_of_truth:github", "source_of_truth:plane"] as const;
export type ConflictPolicy = (typeof CONFLICT_POLICIES)[number];

// Spec §7.3: GitHub owns title and description unless configured otherwise.
export const DEFAULT_CONFLICT_POLICIES: Record<ConflictField, ConflictPolicy> = {
  title: "source_of_truth:github",
  description: "source_of_truth:github",
  state: "last_write_wins",
  assignees: "last_write_wins",
  labels: "last_write_wins",
  comments: "last_write_wins",
};

export const MAGIC_TIERS = ["closing", "non_closing", "relation"] as const;
export type MagicTier = (typeof MAGIC_TIERS)[number];

// Spec §6 default word lists.
export const DEFAULT_MAGIC_WORDS: Record<MagicTier, string[]> = {
  closing: ["close", "closes", "closed", "closing", "fix", "fixes", "fixed", "fixing", "resolve", "resolves", "resolved", "resolving",
    "complete", "completes", "completed", "completing", "implement", "implements", "implemented", "implementing"],
  non_closing: ["ref", "refs", "references", "part of", "contributes to", "toward", "towards"],
  relation: ["relates to", "related to"],
};

export const DEFAULT_INSTANCE_SETTINGS = { smartCommitsDefault: true, reconciliationIntervalMinutes: 60, opTtlMinutes: 10 };

export type JsonObject = Record<string, unknown>;

export function isRecord(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function requireRecord(v: unknown, what = "request body"): JsonObject {
  if (!isRecord(v)) throw new ValidationError(`${what} must be a JSON object`);
  return v;
}

function rejectUnknownKeys(body: JsonObject, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new ValidationError(`unknown field ${JSON.stringify(key.slice(0, 40))}`);
  }
}

function posInt(v: unknown, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1 || v > max) {
    throw new ValidationError(`${name} must be a positive integer`);
  }
  return v;
}

/** Audit S3: a hand-off link must name the organization it is for, by GitHub account id or login (exactly one). */
export function parseOwnerHandoff(raw: unknown): { accountId: number } | { accountLogin: string } {
  const body = requireRecord(raw);
  rejectUnknownKeys(body, ["accountId", "accountLogin"]);
  if ((body.accountId === undefined) === (body.accountLogin === undefined)) throw new ValidationError("Name the GitHub organization: accountId or accountLogin");
  if (body.accountId !== undefined) return { accountId: posInt(body.accountId, "accountId") };
  if (typeof body.accountLogin !== "string" || !GITHUB_LOGIN.test(body.accountLogin)) throw new ValidationError("accountLogin must be a GitHub login");
  return { accountLogin: body.accountLogin };
}

function bool(v: unknown, name: string): boolean {
  if (typeof v !== "boolean") throw new ValidationError(`${name} must be true or false`);
  return v;
}

function text(v: unknown, name: string, max: number): string {
  if (typeof v !== "string" || v.trim() === "") throw new ValidationError(`${name} is required`);
  if (v.length > max) throw new ValidationError(`${name} is longer than ${max} characters`);
  return v;
}

const REPO_FULL_NAME = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
export const SLUG_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const PLANE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidPlaneId(v: string): boolean {
  return PLANE_ID.test(v);
}

export interface MappingInput {
  ghRepoId: number;
  ghRepoFullName: string;
  planeProjectId: string;
  syncDirection: SyncDirection;
  smartCommitsEnabled: boolean;
  linkbackComments: boolean;
  autolinks: boolean;
  openStateId: string | null;
  closedStateId: string | null;
}

const MAPPING_KEYS = ["ghRepoId", "ghRepoFullName", "planeProjectId", "syncDirection", "smartCommitsEnabled", "linkbackComments", "autolinks", "openStateId", "closedStateId"];

/** Validates a mapping body. `partial` (PATCH) requires at least one field; otherwise the three identity fields are required. */
export function parseMappingInput(raw: unknown, partial: boolean): Partial<MappingInput> {
  const body = requireRecord(raw);
  rejectUnknownKeys(body, MAPPING_KEYS);
  const out: Partial<MappingInput> = {};
  const has = (k: string) => body[k] !== undefined;
  if (!partial) {
    for (const k of ["ghRepoId", "ghRepoFullName", "planeProjectId"]) if (!has(k)) throw new ValidationError(`${k} is required`);
  } else if (!MAPPING_KEYS.some(has)) {
    throw new ValidationError("no fields to update");
  }
  if (has("ghRepoId")) out.ghRepoId = posInt(body.ghRepoId, "ghRepoId");
  if (has("ghRepoFullName")) {
    const name = text(body.ghRepoFullName, "ghRepoFullName", 201);
    if (!REPO_FULL_NAME.test(name)) throw new ValidationError("ghRepoFullName must look like owner/repo");
    out.ghRepoFullName = name;
  }
  if (has("planeProjectId")) {
    const id = text(body.planeProjectId, "planeProjectId", 64);
    if (!PLANE_ID.test(id)) throw new ValidationError("planeProjectId contains invalid characters");
    out.planeProjectId = id;
  }
  if (has("syncDirection")) {
    const d = body.syncDirection;
    if (typeof d !== "string" || !(SYNC_DIRECTIONS as readonly string[]).includes(d)) {
      throw new ValidationError(`syncDirection must be one of ${SYNC_DIRECTIONS.join(", ")}`);
    }
    out.syncDirection = d as SyncDirection;
  }
  if (has("smartCommitsEnabled")) out.smartCommitsEnabled = bool(body.smartCommitsEnabled, "smartCommitsEnabled");
  if (has("linkbackComments")) out.linkbackComments = bool(body.linkbackComments, "linkbackComments");
  if (has("autolinks")) out.autolinks = bool(body.autolinks, "autolinks");
  for (const key of ["openStateId", "closedStateId"] as const) {
    if (!has(key)) continue;
    if (body[key] === null || body[key] === "") { out[key] = null; continue; }
    const id = text(body[key], key, 64);
    if (!PLANE_ID.test(id)) throw new ValidationError(`${key} contains invalid characters`);
    out[key] = id;
  }
  if (out.openStateId && out.openStateId === out.closedStateId) throw new ValidationError("Open and closed states must differ");
  return out;
}

export function parseConflictPolicies(raw: unknown): Partial<Record<ConflictField, ConflictPolicy>> {
  const body = requireRecord(raw);
  const out: Partial<Record<ConflictField, ConflictPolicy>> = {};
  const keys = Object.keys(body);
  if (keys.length === 0) throw new ValidationError("no conflict policies given");
  for (const key of keys) {
    if (!(CONFLICT_FIELDS as readonly string[]).includes(key)) throw new ValidationError(`unknown field ${JSON.stringify(key.slice(0, 40))}`);
    const policy = body[key];
    if (typeof policy !== "string" || !(CONFLICT_POLICIES as readonly string[]).includes(policy)) {
      throw new ValidationError(`policy for ${key} must be one of ${CONFLICT_POLICIES.join(", ")}`);
    }
    out[key as ConflictField] = policy as ConflictPolicy;
  }
  return out;
}

export function parseUserLink(raw: unknown): { githubLogin: string; githubId: number } {
  const body = requireRecord(raw);
  rejectUnknownKeys(body, ["githubLogin", "githubId"]);
  const login = text(body.githubLogin, "githubLogin", 39);
  if (!GITHUB_LOGIN.test(login)) throw new ValidationError("githubLogin is not a valid GitHub username");
  return { githubLogin: login, githubId: posInt(body.githubId, "githubId") };
}

export const RULES_MAX_BYTES = 256 * 1024;

export function parseRulesBody(raw: unknown): string {
  const body = requireRecord(raw);
  rejectUnknownKeys(body, ["yaml"]);
  if (typeof body.yaml !== "string") throw new ValidationError("yaml must be a string");
  if (body.yaml.length > RULES_MAX_BYTES) throw new ValidationError(`yaml is larger than ${RULES_MAX_BYTES} bytes`);
  return body.yaml;
}

export function parseMagicWords(raw: unknown): Record<MagicTier, string[]> {
  const body = requireRecord(raw);
  rejectUnknownKeys(body, MAGIC_TIERS);
  const out = {} as Record<MagicTier, string[]>;
  const seen = new Map<string, MagicTier>();
  for (const tier of MAGIC_TIERS) {
    const list = body[tier];
    if (!Array.isArray(list) || list.length === 0) throw new ValidationError(`${tier} must be a non-empty list of words`);
    if (list.length > 100) throw new ValidationError(`${tier} has more than 100 words`);
    out[tier] = [];
    for (const w of list) {
      if (typeof w !== "string") throw new ValidationError(`${tier} must contain only strings`);
      const word = w.trim().toLowerCase().replace(/\s+/g, " ");
      if (!/^[a-z]+(?: [a-z]+)*$/.test(word) || word.length > 40) {
        throw new ValidationError(`${tier}: ${JSON.stringify(w.slice(0, 40))} is not a plain lowercase word or phrase`);
      }
      const other = seen.get(word);
      if (other !== undefined && other !== tier) throw new ValidationError(`"${word}" is in both ${other} and ${tier}`);
      if (other === undefined) { seen.set(word, tier); out[tier].push(word); }
    }
  }
  return out;
}

export interface InstanceSettings { smartCommitsDefault: boolean; reconciliationIntervalMinutes: number; opTtlMinutes: number; requireVerifiedCommits?: boolean }

export function parseInstanceSettings(raw: unknown): Partial<InstanceSettings> {
  const body = requireRecord(raw);
  rejectUnknownKeys(body, ["smartCommitsDefault", "reconciliationIntervalMinutes", "opTtlMinutes", "requireVerifiedCommits"]);
  const out: Partial<InstanceSettings> = {};
  if (body.smartCommitsDefault !== undefined) out.smartCommitsDefault = bool(body.smartCommitsDefault, "smartCommitsDefault");
  if (body.requireVerifiedCommits !== undefined) out.requireVerifiedCommits = bool(body.requireVerifiedCommits, "requireVerifiedCommits");
  if (body.reconciliationIntervalMinutes !== undefined) out.reconciliationIntervalMinutes = posInt(body.reconciliationIntervalMinutes, "reconciliationIntervalMinutes", 10080);
  if (body.opTtlMinutes !== undefined) out.opTtlMinutes = posInt(body.opTtlMinutes, "opTtlMinutes", 10080);
  if (Object.keys(out).length === 0) throw new ValidationError("no settings given");
  return out;
}

export interface GithubAppInput { appId: number; privateKey?: string; webhookSecret?: string; gheBaseUrl: string | null; clientId?: string | null; clientSecret?: string; appSlug?: string | null; edition?: GithubEdition; gheSubdomain?: string | null }

const PEM = /^-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----\s*$/;

/** Secrets may be omitted to keep the stored ones (the API never returns them, so a form cannot resend them). */
export function parseGithubApp(raw: unknown): GithubAppInput {
  const body = requireRecord(raw);
  rejectUnknownKeys(body, ["appId", "privateKey", "webhookSecret", "gheBaseUrl", "clientId", "clientSecret", "appSlug", "edition", "gheSubdomain"]);
  const out: GithubAppInput = { appId: posInt(body.appId, "appId"), gheBaseUrl: null };
  if (body.privateKey !== undefined && body.privateKey !== "") {
    if (typeof body.privateKey !== "string" || body.privateKey.length > 16384 || !PEM.test(body.privateKey.trim())) {
      throw new ValidationError("privateKey must be a PEM private key");
    }
    out.privateKey = body.privateKey;
  }
  if (body.webhookSecret !== undefined && body.webhookSecret !== "") {
    if (typeof body.webhookSecret !== "string" || body.webhookSecret.trim() === "" || body.webhookSecret.length > 512) {
      throw new ValidationError("webhookSecret must be a non-empty string of at most 512 characters");
    }
    out.webhookSecret = body.webhookSecret;
  }
  const ghe = body.gheBaseUrl;
  if (ghe !== undefined && ghe !== null && ghe !== "") {
    if (typeof ghe !== "string" || ghe.length > 300) throw new ValidationError("gheBaseUrl must be an https URL");
    let u: URL;
    try { u = new URL(ghe); } catch { throw new ValidationError("gheBaseUrl must be an https URL"); }
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) {
      throw new ValidationError("gheBaseUrl must be a plain https URL without credentials or query");
    }
    out.gheBaseUrl = u.origin + u.pathname.replace(/\/+$/, "");
  }
  for (const field of ["clientId", "appSlug"] as const) {
    if (body[field] !== undefined) out[field] = body[field] === null || body[field] === "" ? null : text(body[field], field, 200);
  }
  if (out.appSlug && !/^[a-z0-9][a-z0-9_-]*$/i.test(out.appSlug)) throw new ValidationError("appSlug must be a GitHub App slug");
  if (body.clientSecret !== undefined && body.clientSecret !== "") out.clientSecret = text(body.clientSecret, "clientSecret", 4096);
  if (body.edition !== undefined || out.gheBaseUrl !== null) {
    try {
      const hosts = deriveGithubHosts({ edition: body.edition as GithubEdition | undefined,
        gheBaseUrl: out.gheBaseUrl, gheSubdomain: body.gheSubdomain as string | null | undefined });
      out.edition = hosts.edition;
      out.gheBaseUrl = hosts.edition === "github" ? null : hosts.apiBaseUrl;
      out.gheSubdomain = hosts.edition === "ghe_cloud" ? hosts.webOrigin.slice(8, -8) : null;
    } catch (err) { throw new ValidationError(err instanceof Error ? err.message : "Invalid GitHub edition"); }
  } else if (body.gheSubdomain !== undefined) throw new ValidationError("gheSubdomain requires an edition");
  return out;
}

export function isValidRepoFullName(fullName: string): boolean {
  return REPO_FULL_NAME.test(fullName);
}

export function isValidGithubLogin(login: string): boolean {
  return GITHUB_LOGIN.test(login);
}

export const DRY_RUN_EVENTS = ["pull_request", "pull_request_review", "push", "check_suite", "deployment_status", "issues", "issue_comment", "issue"] as const;
export type DryRunEvent = (typeof DRY_RUN_EVENTS)[number];

export const DRY_RUN_TRIGGERS = ["branch.created", "push", "commit.pushed_to_default",
  ...["drafted", "opened", "review_requested", "changes_requested", "approved", "ready_for_merge", "merged", "closed_unmerged", "reopened"].map((action) => `pull_request.${action}`),
  "pull_request.*", "check_suite.success", "check_suite.failure", "check_suite.*", "deployment_status.success", "deployment_status.failure", "deployment_status.*",
  "issue.created", "issue.updated", "issue.deleted", "issue.opened", "issue.closed", "issue.*", "comment.created", "comment.edited", "comment.deleted", "comment.*"];

/** Delegate trigger syntax to the engine so new accepted family actions need no UI enumeration. */
export function validateRuleTrigger(trigger: unknown): string {
  if (typeof trigger !== "string" || trigger.length > 100) throw new ValidationError("Enter a rule trigger");
  try { parseRules(`- when: ${JSON.stringify(trigger)}\n  then: [{comment: preview}]\n`); }
  catch { throw new ValidationError("That trigger is not accepted by the rules engine"); }
  return trigger;
}

export interface DryRunInput {
  event?: DryRunEvent;
  trigger?: string;
  source?: "github" | "plane";
  /** A pasted delivery payload; ignored when `auditId` names a recorded one. */
  payload?: JsonObject;
  auditId?: number;
  /** Rules to test; defaults to the mapping's saved rules (or the §7.1 defaults). */
  yaml?: string;
  mappingId?: number;
}

export function parseDryRun(raw: unknown): DryRunInput {
  const body = requireRecord(raw);
  rejectUnknownKeys(body, ["event", "trigger", "source", "payload", "auditId", "yaml", "mappingId"]);
  const event = body.event;
  if (body.trigger === undefined && (typeof event !== "string" || !(DRY_RUN_EVENTS as readonly string[]).includes(event))) {
    throw new ValidationError(`event must be one of ${DRY_RUN_EVENTS.join(", ")}`);
  }
  if (body.source !== undefined && body.source !== "github" && body.source !== "plane") throw new ValidationError("source must be github or plane");
  const out: DryRunInput = { ...(body.source !== undefined ? { source: body.source as "github" | "plane" } : {}),
    ...(body.trigger !== undefined ? { trigger: validateRuleTrigger(body.trigger) } : { event: event as DryRunEvent }) };
  if (body.payload !== undefined) out.payload = requireRecord(body.payload, "payload");
  if (body.auditId !== undefined) out.auditId = posInt(body.auditId, "auditId");
  if (out.payload === undefined && out.auditId === undefined) throw new ValidationError("give a payload or an auditId to test against");
  if (body.yaml !== undefined) {
    if (typeof body.yaml !== "string") throw new ValidationError("yaml must be a string");
    if (body.yaml.length > RULES_MAX_BYTES) throw new ValidationError(`yaml is larger than ${RULES_MAX_BYTES} bytes`);
    out.yaml = body.yaml;
  }
  if (body.mappingId !== undefined) out.mappingId = posInt(body.mappingId, "mappingId");
  return out;
}

/** `PUT /instance/installations/:id` body: which workspace may use the installation, plus an optional display label. */
export function parseInstallationEntry(raw: unknown): { workspaceSlug: string; accountLogin: string | null } {
  const body = requireRecord(raw);
  rejectUnknownKeys(body, ["workspaceSlug", "accountLogin"]);
  const workspaceSlug = text(body.workspaceSlug, "workspaceSlug", 100);
  if (!SLUG_PATTERN.test(workspaceSlug)) throw new ValidationError("workspaceSlug is not a valid workspace slug");
  const accountLogin = body.accountLogin === undefined || body.accountLogin === null ? null : text(body.accountLogin, "accountLogin", 100);
  return { workspaceSlug, accountLogin };
}
