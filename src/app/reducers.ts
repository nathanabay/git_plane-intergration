// Registers every reducer on the event router. Anything without one is audited as `unhandled` by the caller.
import { appendAudit } from "../db/ledgers.ts";
import type { InboundJob } from "../queue/index.ts";
import { EventRouter } from "../sync/router.ts";
import { handleChecks, handleCommitStatus } from "./checks.ts";
import type { AppContext } from "./context.ts";
import { invalidateInstallationMappings, refreshInstallationMappings } from "./context.ts";
import { handleGithubIssue, handlePlaneIssue } from "./issues.ts";
import { handlePullRequest } from "./pr.ts";
import { handlePush } from "./push.ts";
import { deliveryScope } from "./writers.ts";

export function createRouter(ctx: AppContext): EventRouter {
  const router = new EventRouter();
  const gh = (event: string, fn: (ctx: AppContext, job: InboundJob) => Promise<void>) => router.on("github", event, (job) => fn(ctx, job));
  gh("installation", handleInstallation);
  gh("installation_repositories", handleInstallation);
  gh("pull_request", handlePullRequest);
  gh("pull_request_review", handlePullRequest);
  gh("push", handlePush);
  gh("issues", handleGithubIssue);
  gh("issue_comment", handleGithubIssue);
  gh("check_suite", handleChecks);
  gh("check_run", handleChecks);
  gh("status", handleCommitStatus);
  gh("deployment_status", handleChecks);
  router.on("plane", "issue", (job) => handlePlaneIssue(ctx, job));
  router.on("plane", "issue_comment", (job) => handlePlaneIssue(ctx, job));
  return router;
}

/** Installation events have no top-level repository and need their own route. */
export async function handleInstallation(ctx: AppContext, job: InboundJob): Promise<void> {
  const payload = job.payload as any;
  const id = Number(payload?.installation?.id);
  if (!Number.isSafeInteger(id) || id <= 0) return;
  const repoIds = (rows: unknown): number[] => (Array.isArray(rows) ? rows : [])
    .map((r) => Number(r?.id)).filter((n) => Number.isSafeInteger(n) && n > 0);
  if (job.event === "installation_repositories") {
    // Invalidate removed identities even when a payload includes additions as well.
    const removed = repoIds(payload.repositories_removed);
    if (removed.length) await invalidateInstallationMappings(ctx, id, removed);
    const added = repoIds(payload.repositories_added);
    if (added.length) await refreshInstallationMappings(ctx, id, added);
    return;
  }
  if (payload.action === "deleted" || payload.action === "suspend") {
    await invalidateInstallationMappings(ctx, id);
  } else if (["created", "unsuspend", "new_permissions_accepted"].includes(payload.action)) {
    // Inspect all this workspace's existing mappings; payload repository arrays may be absent/bounded.
    await refreshInstallationMappings(ctx, id);
  }
}

/** The inbound handler for one source: route, and say so in the audit log when nothing handles the event. */
export function inboundHandler(ctx: AppContext, router: EventRouter, source: "plane" | "github"): (job: InboundJob) => Promise<void> {
  return (job) => deliveryScope.run({ deliveryId: `${source}-${job.writeDeliveryId ?? job.deliveryId}`, seq: 0,
    // An explicit replay carries its own write identity; the outbox resets failed rows only when it differs from the transport id.
    ...(job.writeDeliveryId ? { writeDeliveryId: job.writeDeliveryId } : {}), transportDeliveryId: job.deliveryId,
    ...(source === "plane" && typeof (job.payload as any)?.workspace_slug === "string" && (job.payload as any).workspace_slug
      ? { workspaceSlug: (job.payload as any).workspace_slug } : {}),
  }, async () => {
    if ((await router.dispatch(job)) === "unhandled") {
      await appendAudit(ctx.db, { kind: "inbound", source, deliveryId: job.deliveryId, detail: { event: job.event }, outcome: "unhandled" });
    }
  });
}
