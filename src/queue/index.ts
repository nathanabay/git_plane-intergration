import { Queue } from "bullmq";

export const QUEUE_NAMES = {
  inboundGithub: "inbound-github",
  inboundPlane: "inbound-plane",
  outboundPlane: "outbound-plane",
  outboundGithub: "outbound-github"
} as const;

// Kept out of QUEUE_NAMES, which names the four webhook/write queues the A2 oracle pins.
export const MAINTENANCE_QUEUE = "maintenance";

export interface InboundJob {
  source: "github" | "plane";
  deliveryId: string;
  writeDeliveryId?: string;
  event: string;
  receivedAt: string;
  payload: unknown;
}

export interface Queues {
  inboundGithub: Queue<InboundJob>;
  inboundPlane: Queue<InboundJob>;
  outboundPlane: Queue;
  outboundGithub: Queue;
  enqueueInbound(job: InboundJob): Promise<void>;
  close(): Promise<void>;
}

export function createQueues(opts: { connectionUrl: string; prefix: string }): Queues {
  const connection = { url: opts.connectionUrl };
  const prefix = opts.prefix;
  // Retained completed jobs keep a redelivered webhook's jobId a no-op for a day.
  const defaultJobOptions = {
    attempts: 10,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { age: 24 * 3600, count: 10000 },
    removeOnFail: { age: 7 * 24 * 3600 },
  };

  // Writes are retried for hours, not seconds: one side's outage must not fail the other side's deliveries (§4).
  // The delay comes from the workers' custom backoff strategy (src/queue/workers.ts).
  const outboundJobOptions = { ...defaultJobOptions, attempts: 30, backoff: { type: "custom" } };

  const inboundGithub = new Queue<InboundJob>(QUEUE_NAMES.inboundGithub, { connection, prefix, defaultJobOptions });
  const inboundPlane = new Queue<InboundJob>(QUEUE_NAMES.inboundPlane, { connection, prefix, defaultJobOptions });
  const outboundPlane = new Queue(QUEUE_NAMES.outboundPlane, { connection, prefix, defaultJobOptions: outboundJobOptions });
  const outboundGithub = new Queue(QUEUE_NAMES.outboundGithub, { connection, prefix, defaultJobOptions: outboundJobOptions });

  const enqueueInbound = async (job: InboundJob): Promise<void> => {
    const jobId = `${job.source}-${job.deliveryId}`;
    if (job.source === "github") {
      await inboundGithub.add("webhook", job, { jobId });
    } else {
      await inboundPlane.add("webhook", job, { jobId });
    }
  };

  const close = async (): Promise<void> => {
    await Promise.all([
      inboundGithub.close(),
      inboundPlane.close(),
      outboundPlane.close(),
      outboundGithub.close()
    ]);
  };

  return {
    inboundGithub,
    inboundPlane,
    outboundPlane,
    outboundGithub,
    enqueueInbound,
    close
  };
}
