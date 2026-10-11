import type { Db } from "../db/migrate.ts";
import { appendAudit, listActiveSyncLinks, markLinkChecked, markLinkOrphaned, pruneAppliedOps } from "../db/ledgers.ts";
import type { SyncLinkRow } from "../db/schema.ts";
import { PlaneApiError } from "./plane.ts";
import type { PlaneClient } from "./plane.ts";

/**
 * Sweep of active links (§1.3). A Plane issue that answers 404 is gone or unreachable: the link becomes
 * `orphaned`, which stops further checks. This is deliberately read-only toward Plane and GitHub — an
 * unreachable issue is never closed or moved (pitfall 4); `onOrphan` lets the caller tell people.
 */
export async function reconcileOnce(deps: { db: Db; plane: PlaneClient; batchSize?: number; onOrphan?(link: SyncLinkRow): Promise<void> }): Promise<{ checked: number; orphaned: number; errors: number }> {
  const limit = deps.batchSize ?? 100;
  const out = { checked: 0, orphaned: 0, errors: 0 };
  let afterId: string | number | undefined;
  for (;;) {
    const page = await listActiveSyncLinks(deps.db, afterId === undefined ? { limit } : { limit, afterId });
    if (page.length === 0) break;
    for (const link of page) {
      out.checked++;
      try {
        await deps.plane.getIssue(link.plane_workspace_slug, link.plane_project_id, link.plane_issue_id);
        await markLinkChecked(deps.db, link.id);
      } catch (err) {
        if (err instanceof PlaneApiError && err.status === 404) {
          await markLinkOrphaned(deps.db, link.id);
          out.orphaned++;
          await appendAudit(deps.db, {
            kind: "sync_link_orphaned",
            workspaceSlug: link.plane_workspace_slug,
            detail: { linkId: link.id, planeIssueId: link.plane_issue_id, ghRepoId: link.gh_repo_id, ghNumber: link.gh_number },
            outcome: "orphaned",
          });
          try { await deps.onOrphan?.(link); } catch { out.errors++; }
        } else {
          out.errors++; // unreachable or erroring: leave the link active and look again next sweep
        }
      }
    }
    afterId = page[page.length - 1]!.id;
    if (page.length < limit) break;
  }
  return out;
}

/** Ops older than the TTL can no longer match an echo (§5). */
export function pruneExpiredOps(deps: { db: Db; ttlMinutes: number }): Promise<number> {
  return pruneAppliedOps(deps.db, deps.ttlMinutes);
}
