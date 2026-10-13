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
  openStateId?: string | null;
  closedStateId?: string | null;
}

export interface RulesDoc { yaml: string; version: number; updatedBy: string | null; updatedAt: string | null }
export interface PlaneProject { id: string; name: string; identifier: string; label: string }
export interface PlaneMember { id: string; name: string; email: string | null }
export interface PlaneWorkspace { id: string; slug: string; name: string }
export interface PlaneState { id: string; name: string; group: string }
export type Policies = Record<ConflictField, ConflictPolicy>;
export interface UserLink { planeUserId: string; githubLogin: string; githubId: number; needsReauth?: boolean }

export interface MappingHealth {
  mappingId: number; lastGithubDeliveryAt: string | null; lastPlaneDeliveryAt: string | null;
  lastSuccessfulWriteAt: string | null; failuresLast24h: number; disabledReason: string | null; rateLimitedUntil: string | null;
}
export interface WorkspaceHealth {
  database: boolean; healthError?: string; githubAppCredentials: { source: string; decryptOk: boolean };
  planeWebhookSilent: boolean | null; mappings: MappingHealth[];
  setup: { rules: "defaults" | "custom"; policies: "defaults" | "custom"; membersLinked: number; membersTotal: number | null; appEventsVerified: boolean | null };
}

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
  workspaceSlug?: string | null;
}
export interface AuditPage { entries: AuditEntry[]; nextBefore: number | null }

export interface GithubAppInfo { appId: number | null; gheBaseUrl: string | null; configured: boolean; clientId?: string | null; appSlug?: string | null; clientSecretConfigured?: boolean; edition?: "github" | "ghe_cloud" | "ghes"; gheSubdomain?: string | null }
export interface Health {
  database: boolean;
  githubAppConfigured: boolean;
  githubAppCredentials?: { source: string; decryptOk: boolean };
  healthError?: string;
  mappings: number | null;
  lastActivityAt: string | null;
  failuresLast24h: number | null;
}
export type MagicWords = Record<MagicTier, string[]>;
export type { InstanceSettings };

export type { DryRunResult } from "../../operations/tooling.ts";
export type { BackfillCursor, BackfillResult } from "../../operations/tooling.ts";

export interface WorkspaceInstallation {
  installationId: number;
  workspaceSlug: string;
  accountLogin: string | null;
  createdAt: string;
}
