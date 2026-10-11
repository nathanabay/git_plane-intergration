import type { ConflictField, ConflictPolicy, InstanceSettings, MagicTier, SyncDirection } from "../validate.ts";

export interface Mapping {
  id: number;
  workspaceSlug: string;
  ghRepoId: number;
  ghRepoFullName: string;
  planeProjectId: string;
  syncDirection: SyncDirection;
  smartCommitsEnabled: boolean;
  linkbackComments: boolean;
  autolinks: boolean;
}

export interface RulesDoc { yaml: string; version: number; updatedBy: string | null; updatedAt: string | null }
export type Policies = Record<ConflictField, ConflictPolicy>;
export interface UserLink { planeUserId: string; githubLogin: string; githubId: number }

export interface AuditEntry {
  id: number;
  kind: string;
  source: string | null;
  deliveryId: string | null;
  detail: unknown;
  outcome: string;
  error: string | null;
  replayOf: number | null;
  createdAt: string;
}
export interface AuditPage { entries: AuditEntry[]; nextBefore: number | null }

export interface GithubAppInfo { appId: number | null; gheBaseUrl: string | null; configured: boolean }
export interface Health {
  database: boolean;
  githubAppConfigured: boolean;
  mappings: number;
  lastActivityAt: string | null;
  failuresLast24h: number;
}
export type MagicWords = Record<MagicTier, string[]>;
export type { InstanceSettings };

export interface DryRunResult {
  dryRun: true;
  trigger: string | null;
  matched: { index: number; name: string | null } | null;
  actions: { type: string; [k: string]: unknown }[];
}
export interface BackfillResult { linked: number; unresolved: number; pullRequests: number; issues: number }

export interface WorkspaceInstallation {
  installationId: number;
  workspaceSlug: string;
  accountLogin: string | null;
  createdAt: string;
}
