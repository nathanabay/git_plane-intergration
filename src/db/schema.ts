/** Table names and row shapes shared by data-access code. Columns are the snake_case names Postgres returns. */
export const TABLES = {
  syncLinks: "sync_links",
  appliedOps: "applied_ops",
  webhookDeliveries: "webhook_deliveries",
  processedCommits: "processed_commits",
  auditLog: "audit_log",
  devInfoLinks: "dev_info_links",
  userLinkTombstones: "user_link_tombstones",
  userLinkLocks: "user_link_locks",
  githubCredentialState: "github_credential_state",
  inboundSpool: "inbound_spool",
  ingressHealth: "ingress_health",
  oauthStates: "oauth_states",
} as const;

export interface SyncLinkRow {
  id: number | string;
  plane_workspace_slug: string;
  plane_project_id: string;
  plane_issue_id: string;
  gh_repo_id: number | string;
  gh_number: number;
  gh_kind: "issue" | "pr";
  tier: "closing" | "non_closing" | "relation";
  created_by: "magic_word" | "branch" | "label_sync" | "manual";
  status: "active" | "orphaned";
  orphaned_at: string | Date | null;
  last_checked_at: string | Date | null;
  /** A2: set while the Plane item (or its project) is archived; the link stays active. */
  plane_archived_at?: string | Date | null;
  /** A2: first sweep that got an unexplained 404; a second sweep that agrees orphans the link. */
  missing_since?: string | Date | null;
}
