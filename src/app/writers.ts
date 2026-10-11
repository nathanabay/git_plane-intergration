// Reducers acknowledge durable registration; result-dependent work is a serializable outbox plan.
// Standalone adapters support raw consumers. Production uses one shared ordered outbox.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Queue } from "bullmq";
import type { GithubWritePath } from "../sync/github.ts";
import type { PlaneWritePath } from "../sync/plane.ts";
import { PlaneApiError } from "../sync/plane.ts";
import type { GithubWriter, PlaneWriter } from "./context.ts";
import { makeOrderedOutbox, nextWriteJobId } from "../operations/outbox.ts";
import type { DeliveryContext, OrderedOutboxDeps } from "../operations/outbox.ts";
export { OrderedWriteDeferredError, QueuedWriteFailedError } from "../operations/outbox.ts";
export type { IssueMutation, OrderedOutbox, OutboxJob } from "../operations/outbox.ts";

export { resultRef, resultText } from "../operations/plans.ts";
export type { OutboxPlanStep, OutboxPlanOptions, PlanWriter, ReducerContinuation, ResultReference, StringReference } from "../operations/plans.ts";

export const deliveryScope = new AsyncLocalStorage<DeliveryContext>();

/** Construct once in the service; reducers and workers must share this durable ordering contract. */
export function createOrderedOutbox(deps: Omit<OrderedOutboxDeps, "scope">) {
  return makeOrderedOutbox({ ...deps,
    ...(deps.resumeReducer ? { resumeReducer: (request) => deliveryScope.run({
      deliveryId: `${request.job.source}-${request.job.writeDeliveryId ?? request.job.deliveryId}`,
      ...(request.workspaceSlug ? { workspaceSlug: request.workspaceSlug } : {}),
    }, () => deps.resumeReducer!(request)) } : {}),
    scope: () => deliveryScope.getStore() });
}

function jobId(side: "plane" | "github", write: unknown): string {
  const scope = deliveryScope.getStore();
  return nextWriteJobId(side, write, scope);
}

type Enqueue = Pick<Queue, "add" | "getJob">;

const PLANE_INLINE = new Set(["create_issue", "upsert_label", "add_link", "update_link"]);

export function queuedPlaneWriter(inline: PlaneWritePath, queue: Enqueue): PlaneWriter {
  return {
    async apply(write, opts = {}) {
      if (opts.actorToken) throw new PlaneApiError(503, {}, "actor writes require the ordered outbox");
      if (PLANE_INLINE.has(write.kind)) return inline.apply(write, opts);
      const id = jobId("plane", write);
      const existing = await queue.getJob(id);
      if (existing && await existing.getState() === "completed") return { ok: true };
      await inline.preflight(write); // the triage ban and unknown states fail here, before registration
      await queue.add("write", write, { jobId: id });
      return { ok: true };
    },
  };
}

export function queuedGithubWriter(inline: GithubWritePath, queue: Enqueue): GithubWriter {
  return {
    async apply(write) {
      if (write.kind === "create_issue") return inline.apply(write);
      const id = jobId("github", write);
      await queue.add("write", write, { jobId: id });
      return { ok: true };
    },
  };
}
