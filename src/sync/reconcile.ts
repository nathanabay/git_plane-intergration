import type { Db } from "../db/migrate.ts";
import {
  appendAudit, deleteSpooled, lastDeliveryAt, listActiveSyncLinks, listMappedPlaneProjects, listSpooled, markLinkArchived,
  markLinkChecked, markLinkMissing, markLinkOrphaned, markSpoolFailed, pruneAppliedOps, writeIngressHealth,
} from "../db/ledgers.ts";
import type { SyncLinkRow } from "../db/schema.ts";
import type { InboundJob } from "../queue/index.ts";
import { PlaneApiError, planeCreatedItem } from "./plane.ts";
import type { PlaneActivity, PlaneClient, PlaneProject } from "./plane.ts";

/**
 * The reads the sweep makes. All are GETs: the sweep never writes to Plane or GitHub (pitfall 4).
 * `findIssueByExternalId` is optional only for older test fakes; the production client always has it.
 */
export type ReconcilePlane = Pick<PlaneClient, "getIssue" | "getProject" | "listIssueIds" | "listIssueActivities">
  & Partial<Pick<PlaneClient, "findIssueByExternalId">>;

/** `present`: the item exists and is neither archived nor deleted, only hidden from the detail view (triage, draft). */
type Verdict = "visible" | "archived" | "deleted" | "present" | "unknown";

const notFound = (err: unknown) => err instanceof PlaneApiError && err.status === 404;

/**
 * Sweep of active links (§1.3).
 *
 * A6: links are checked per Plane project. When a project holds several links, its visible item ids are
 * listed (100 per request) and only the ids missing from that list are read one by one. The listing is
 * abandoned for per-item reads as soon as it would cost more requests than the links it checks.
 *
 * A2: Plane answers 404 for an archived item and for every item of an archived project, as well as for a
 * deleted item. A 404 is therefore classified before anything happens: an archived project, or an
 * `archived_at` activity, marks the link archived (it stays active and is never reported); a `deleted`
 * activity orphans it. When the activity log says neither (E2E-2: an archive that bypassed Plane's activity task
 * leaves no row), an item git-sync created is looked up by its external id, which still finds an archived item
 * and no longer finds a deleted one. Anything else orphans it only when an earlier sweep saw the same 404.
 *
 * An orphaned link stops further checks. An unreachable issue is never closed or moved; `onOrphan` lets
 * the caller tell people.
 */
export async function reconcileOnce(deps: { db: Db; plane: ReconcilePlane; batchSize?: number; onOrphan?(link: SyncLinkRow): Promise<void> }): Promise<{ checked: number; orphaned: number; archived: number; errors: number }> {
  const limit = deps.batchSize ?? 100;
  const out = { checked: 0, orphaned: 0, archived: 0, errors: 0 };

  const byProject = new Map<string, SyncLinkRow[]>();
  let afterId: string | number | undefined;
  for (;;) {
    const page = await listActiveSyncLinks(deps.db, afterId === undefined ? { limit } : { limit, afterId });
    for (const link of page) {
      const key = `${link.plane_workspace_slug}\u0000${link.plane_project_id}`;
      const list = byProject.get(key);
      if (list) list.push(link); else byProject.set(key, [link]);
    }
    if (page.length < limit) break;
    afterId = page[page.length - 1]!.id;
  }

  for (const links of byProject.values()) {
    const { plane_workspace_slug: slug, plane_project_id: projectId } = links[0]!;
    let visible = new Set<string>();
    if (links.length > 1) {
      try {
        // Contract 3: a partial listing proves the ids it holds are visible, never that the others are not.
        visible = new Set((await deps.plane.listIssueIds(slug, projectId, { maxPages: Math.max(1, Math.floor(links.length / 2)) })).ids);
      } catch { visible = new Set(); }
    }
    let project: Promise<PlaneProject | null> | undefined;
    const projectOnce = () => (project ??= deps.plane.getProject(slug, projectId).catch((err) => {
      if (notFound(err)) return null;
      throw err;
    }));

    for (const link of links) {
      out.checked++;
      try {
        if (!visible.has(link.plane_issue_id)) {
          try {
            await deps.plane.getIssue(slug, projectId, link.plane_issue_id);
          } catch (err) {
            if (!notFound(err)) throw err;
            // Already known archived and still hidden: one read per sweep, not three.
            const verdict = link.plane_archived_at ? "archived" : await classifyMissing(deps.db, deps.plane, link, projectOnce);
            if (verdict === "present") { await markLinkChecked(deps.db, link.id); continue; }
            if (verdict === "archived") {
              await markLinkArchived(deps.db, link.id);
              if (!link.plane_archived_at) {
                await appendAudit(deps.db, { kind: "sync_link_archived", workspaceSlug: slug, detail: linkDetail(link), outcome: "archived" });
              }
              out.archived++;
              continue;
            }
            if (verdict !== "deleted" && (await markLinkMissing(deps.db, link.id)) === null) {
              await appendAudit(deps.db, { kind: "sync_link_missing", workspaceSlug: slug, detail: linkDetail(link), outcome: "awaiting_confirmation" });
              continue; // one unexplained 404 is not enough: the next sweep must agree
            }
            await orphan(deps, link, verdict, out);
            continue;
          }
        }
        await markLinkChecked(deps.db, link.id);
      } catch {
        out.errors++; // unreachable or erroring: leave the link as it is and look again next sweep
      }
    }
  }
  return out;
}

async function classifyMissing(db: Db, plane: ReconcilePlane, link: SyncLinkRow, project: () => Promise<PlaneProject | null>): Promise<Verdict> {
  const p = await project();
  if (p && p.archived_at) return "archived";
  if (!p) return "unknown"; // the project is gone or no longer visible to the service user
  let activities: PlaneActivity[];
  try {
    activities = await plane.listIssueActivities(link.plane_workspace_slug, link.plane_project_id, link.plane_issue_id);
  } catch (err) {
    if (notFound(err)) return byExternalId(db, plane, link);
    throw err;
  }
  const verdict = verdictFromActivities(activities);
  return verdict === "unknown" ? byExternalId(db, plane, link) : verdict;
}

/**
 * E2E-2: Plane v1.4.2 has no v1 archived-items read, but its list lookup by external id reads `Issue.objects`:
 * an archived item comes back with `archived_at`, a deleted one is 404. Only items git-sync created carry an
 * external id; for any other item this has no evidence and the two-sweep rule decides.
 */
async function byExternalId(db: Db, plane: ReconcilePlane, link: SyncLinkRow): Promise<Verdict> {
  if (!plane.findIssueByExternalId) return "unknown";
  const created = await planeCreatedItem(db, link.plane_issue_id, link.plane_project_id);
  if (!created) return "unknown";
  const item = await plane.findIssueByExternalId(link.plane_workspace_slug, link.plane_project_id, created.externalSource, created.externalId);
  if (!item) return "deleted";
  if (item.id !== link.plane_issue_id) return "unknown"; // the id names another item: no evidence about this one
  return item.archived_at ? "archived" : "present";
}

/** Newest first: the latest of a `deleted` row or an `archived_at` row says what happened to the item. */
export function verdictFromActivities(activities: PlaneActivity[]): Verdict {
  const sorted = [...activities].sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
  for (const a of sorted) {
    if (a.verb === "deleted" && (a.field === "issue" || a.field == null)) return "deleted";
    if (a.field === "archived_at") return a.new_value === "restore" ? "unknown" : "archived";
  }
  return "unknown";
}

const linkDetail = (link: SyncLinkRow) => ({ linkId: link.id, planeIssueId: link.plane_issue_id, ghRepoId: link.gh_repo_id, ghNumber: link.gh_number });

async function orphan(deps: { db: Db; onOrphan?(link: SyncLinkRow): Promise<void> }, link: SyncLinkRow, verdict: Verdict, out: { orphaned: number; errors: number }): Promise<void> {
  await markLinkOrphaned(deps.db, link.id);
  out.orphaned++;
  await appendAudit(deps.db, {
    kind: "sync_link_orphaned",
    workspaceSlug: link.plane_workspace_slug,
    detail: { ...linkDetail(link), reason: verdict === "deleted" ? "deleted" : "not_found_twice" },
    outcome: "orphaned",
  });
  try { await deps.onOrphan?.(link); } catch { out.errors++; }
}

/** Ops older than the TTL can no longer match an echo (§5). */
export function pruneExpiredOps(deps: { db: Db; ttlMinutes: number }): Promise<number> {
  return pruneAppliedOps(deps.db, deps.ttlMinutes);
}

/** A1: how long a Plane change may go without a delivery before the webhook is reported as silent. */
export const PLANE_WEBHOOK_GRACE_MS = 30 * 60_000;

/**
 * A1: Plane v1.4.2 disables a webhook after its retries fail, and nothing tells git-sync. Every visible
 * change bumps an item's `updated_at` and produces a delivery, so a mapped project whose newest change is
 * older than the grace period yet newer than the last delivery (plus the grace) means deliveries stopped.
 * The webhook itself cannot be read: Plane's webhook endpoints take a browser session, not an API key.
 */
export async function checkPlaneWebhookHealth(deps: { db: Db; plane: Pick<PlaneClient, "latestIssueUpdate">; now?: number; graceMs?: number }): Promise<{ silent: boolean; latestChangeAt: Date | null; lastDeliveryAt: Date | null; errors: number }> {
  const now = deps.now ?? Date.now();
  const grace = deps.graceMs ?? PLANE_WEBHOOK_GRACE_MS;
  let latest: Date | null = null;
  let errors = 0;
  for (const p of await listMappedPlaneProjects(deps.db)) {
    try {
      const at = await deps.plane.latestIssueUpdate(p.workspaceSlug, p.projectId);
      const d = at ? new Date(at) : null;
      if (d && !Number.isNaN(d.getTime()) && d.getTime() <= now - grace && (!latest || d > latest)) latest = d;
    } catch { errors++; }
  }
  const delivered = await lastDeliveryAt(deps.db, "plane");
  const silent = latest !== null && (delivered === null || latest.getTime() > delivered.getTime() + grace);
  const previous = await writeIngressHealth(deps.db, "plane", { silent, latestChangeAt: latest, lastDeliveryAt: delivered });
  if (silent && !previous) {
    console.error("Plane webhook looks disabled or failing: Plane changes are not arriving as deliveries. Re-enable it in Plane's workspace webhook settings (deploy/APPLY.md).");
    await appendAudit(deps.db, { kind: "plane_webhook_silent", source: "plane", detail: { latestChangeAt: latest, lastDeliveryAt: delivered }, outcome: "alert" });
  } else if (!silent && previous) {
    await appendAudit(deps.db, { kind: "plane_webhook_recovered", source: "plane", detail: { lastDeliveryAt: delivered }, outcome: "recovered" });
  }
  return { silent, latestChangeAt: latest, lastDeliveryAt: delivered, errors };
}

/** A1: queues the deliveries the webhook route kept while the queue was down, oldest first. */
export async function replaySpooledDeliveries(deps: { db: Db; enqueue(job: InboundJob): Promise<void>; limit?: number }): Promise<{ replayed: number; failed: number }> {
  const out = { replayed: 0, failed: 0 };
  for (const row of await listSpooled(deps.db, deps.limit ?? 500)) {
    try {
      // The queue job id is `<source>-<deliveryId>`, so a replay that already reached the queue is a no-op.
      await deps.enqueue({ source: row.source, deliveryId: row.delivery_id, event: row.event, receivedAt: new Date(row.received_at).toISOString(), payload: row.payload });
    } catch (err) {
      out.failed++;
      await markSpoolFailed(deps.db, row.id, err instanceof Error ? err.message : "enqueue failed");
      break; // the queue is still down: keep the order and try again on the next run
    }
    await deleteSpooled(deps.db, row.id);
    out.replayed++;
  }
  return out;
}
