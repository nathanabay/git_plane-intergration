import test from "node:test";
import { deepStrictEqual, notStrictEqual, strictEqual } from "node:assert/strict";
import { queuedPlaneWriter, queuedGithubWriter, deliveryScope } from "../../src/app/writers.ts";
import { SecretString } from "../../src/auth/identity.ts";
import type { PlaneWrite } from "../../src/sync/plane.ts";

function fakeQueue() {
  const jobs = new Map<string, any>();
  const added: string[] = [];
  const looked: string[] = [];
  let state = "completed";
  return {
    jobs, added, looked,
    setState(value: string) { state = value; },
    async add(_name: string, data: any, opts: any = {}) {
      const id = opts.jobId ?? `generated-${jobs.size}`;
      added.push(id);
      if (!jobs.has(id)) jobs.set(id, { id, data, returnvalue: { ok: true }, getState: async () => state });
      return jobs.get(id);
    },
    async getJob(id: string) { looked.push(id); return jobs.get(id); },
  };
}

const update = (issueId: string, fields: Record<string, unknown> = { name: "New title" }): PlaneWrite =>
  ({ kind: "update_issue", slug: "ws", projectId: "project", issueId, fields });

const inlinePlane = () => ({ preflight: async () => {}, apply: async () => ({ ok: true as const }) }) as any;

test("F2: a partial retry cannot give a missing target the completed target's job ID", async () => {
  const queue = fakeQueue();
  const writer = queuedPlaneWriter(inlinePlane(), queue as any);
  await deliveryScope.run({ deliveryId: "github-d1", seq: 0 }, () => writer.apply(update("first")));
  // The retry skips the completed first step and issues only the missing second step.
  await deliveryScope.run({ deliveryId: "github-d1", seq: 0 }, () => writer.apply(update("second")));
  strictEqual(queue.jobs.size, 2);
  deepStrictEqual([...queue.jobs.values()].map((j) => j.data.issueId), ["first", "second"]);
  notStrictEqual(queue.added[0], queue.added[1]);
});

test("F2: equivalent writes get the same ID regardless of object key order or earlier writes", async () => {
  const queue = fakeQueue();
  const writer = queuedPlaneWriter(inlinePlane(), queue as any);
  await deliveryScope.run({ deliveryId: "github-d1", seq: 0 }, async () => {
    await writer.apply(update("other"));
    await writer.apply(update("same", { name: "Title", description_html: "<p>Body</p>" }));
  });
  await deliveryScope.run({ deliveryId: "github-d1", seq: 0 }, () =>
    writer.apply(update("same", { description_html: "<p>Body</p>", name: "Title" })));
  strictEqual(queue.added[1], queue.looked.at(-1));
  strictEqual(queue.jobs.size, 2);
});

test("F2: delivery IDs that used to sanitize to the same string remain distinct", async () => {
  const queue = fakeQueue();
  const writer = queuedPlaneWriter(inlinePlane(), queue as any);
  for (const deliveryId of ["github-d/1", "github-d:1"])
    await deliveryScope.run({ deliveryId, seq: 0 }, () => writer.apply(update("same")));
  strictEqual(queue.jobs.size, 2);
});

test("F2: a queued write is acknowledged immediately, without waiting for the worker", async () => {
  const queue = fakeQueue();
  queue.setState("waiting");
  const writer = queuedPlaneWriter(inlinePlane(), queue as any);
  let acknowledged = false;
  const pending = writer.apply(update("same")).then(() => { acknowledged = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const beforeCompletion = acknowledged;
  queue.setState("completed");
  await pending;
  strictEqual(beforeCompletion, true);
  strictEqual(acknowledged, true);
});

test("F2: GitHub job IDs also follow target and content across partial retries", async () => {
  const queue = fakeQueue();
  const writer = queuedGithubWriter({ apply: async () => ({ ok: true }) } as any, queue as any);
  for (const number of [1, 2]) await deliveryScope.run({ deliveryId: "plane-d1", seq: 0 }, () =>
    writer.apply({ kind: "update_issue", installationId: 1, owner: "acme", repo: "web", repoId: 1, number,
      fields: { state: "closed" } }));
  strictEqual(queue.jobs.size, 2);
});

test("F2: omitted wire fields cannot collide with an explicit field-clear operation", async () => {
  const queue = fakeQueue();
  const writer = queuedPlaneWriter(inlinePlane(), queue as any);
  for (const name of [undefined, null]) await deliveryScope.run({ deliveryId: "github-d1", seq: 0 }, () =>
    writer.apply(update("same", { name })));
  strictEqual(queue.jobs.size, 2);
});

test("F6: the standalone adapter fails closed instead of sending a PAT write around an older job", async () => {
  const queue = fakeQueue();
  queue.setState("waiting");
  let inlineWrites = 0;
  const writer = queuedPlaneWriter({ preflight: async () => {}, apply: async () => {
    inlineWrites++; return { ok: true };
  } } as any, queue as any);
  await writer.apply(update("same")).catch(() => {});
  let status: number | undefined;
  try { await writer.apply(update("same", { name: "Actor" }), { actorToken: new SecretString("PAT") }); }
  catch (err) { status = (err as { status?: number }).status; }
  strictEqual(status, 503);
  strictEqual(inlineWrites, 0);
});
