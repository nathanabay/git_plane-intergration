/** Table names and row shapes shared by data-access code. Columns are the snake_case names Postgres returns. */
export const TABLES = {
  syncLinks: "sync_links",
  appliedOps: "applied_ops",
  webhookDeliveries: "webhook_deliveries",
  processedCommits: "processed_commits",
  auditLog: "audit_log",
  devInfoLinks: "dev_info_links",
  userLinkTombstones: "user_link_tombstones",
  githubCredentialState: "github_credential_state",
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
}
