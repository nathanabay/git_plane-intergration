import type { AuditEntry } from "./types.ts";

const KIND_LABELS: Record<string, string> = {
  inbound_delivery: "Webhook received", inbound: "Unrecognized webhook", push: "Branch or commit push", pull_request: "Pull request updated",
  issue: "Plane work item updated", issues: "GitHub issue updated", issue_comment: "Comment updated", status: "Commit status updated",
  outbound_write_failed: "Sync write failed", outbound_write_retry: "Sync write retry scheduled", outbound_write: "Sync write",
  installation_not_allowed: "GitHub installation is not approved", installation_invalidated: "GitHub installation access removed",
  github_not_installed: "GitHub App unavailable", identity_fallback: "Service account attribution", identity_email_match: "Account matched by email",
  plane_webhook_silent: "Plane webhook has stopped arriving", readiness_unavailable: "Merge readiness could not be checked",
  build_incomplete: "Build checks are incomplete", rollup_link: "Development link updated", orphan_linkback: "Missing work item reported",
  rule_match: "Automation rule matched", rule_action: "Automation action", reference_unresolved: "Work item reference not found",
  mirror_conflict: "Concurrent mirror update", mirror_create_failed: "Mirrored work item creation failed", mirror_created: "Mirrored work item created",
  backfill: "Existing references linked", replay: "Webhook replay requested", smart_commit_step_executed: "Smart Commit action completed",
  pr_create_request: "Work item creation requested by pull request", ready_for_merge: "Pull request ready to merge",
  pr_association_unavailable: "Related pull requests could not be checked", deployment_status_stale: "Older deployment update skipped",
  deployment_rollup_version: "Deployment status updated",
};

export function humanLabel(value: string): string {
  const words = value.replace(/[_.:-]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
export const auditKindLabel = (kind: string): string => KIND_LABELS[kind] ?? humanLabel(kind);

export function AuditDetail({ entry }: { entry: AuditEntry }) {
  const detail = entry.detail && typeof entry.detail === "object" ? entry.detail as Record<string, unknown> : {};
  const summary = entry.error ?? (typeof detail.message === "string" ? detail.message
    : typeof detail.githubLogin === "string" ? `GitHub account: ${detail.githubLogin}`
    : typeof detail.ruleName === "string" ? `Rule: ${detail.ruleName}`
    : "Recorded sync activity");
  return <><span>{summary}</span><details><summary>Show raw</summary><pre><code>{JSON.stringify(entry, null, 2)}</code></pre></details></>;
}
