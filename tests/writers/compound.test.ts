import test from "node:test";
import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { createOrderedOutbox, deliveryScope, OrderedWriteDeferredError } from "../../src/app/writers.ts";
import { database, queue, intentJob } from "./outbox-fixture.ts";

test("compound Plane mutations read fields after preceding writes, including another producer's labels", async (t) => {
  const db = await database(t), planeQueue = queue();
  let labels = ["existing"], assignees: string[] = [];
  const outbox = createOrderedOutbox({ db,
    queues: { plane: planeQueue as any, github: queue() as any }, loadActorToken: async () => null,
    plane: { preflight: async () => {}, apply: async (w) => {
      if (w.kind === "update_issue") {
        if (w.fields.labels) labels = w.fields.labels as string[];
        if (w.fields.assignees) assignees = w.fields.assignees as string[];
      }
      return { ok: true };
    } }, github: { apply: async () => ({ ok: true }) },
    readPlaneIssueFields: async () => ({ labels: [...labels], assignees: [...assignees] }),
  });
  const target = { slug: "ws", projectId: "p", issueId: "i" };
  const stage = async (deliveryId: string, apply: () => Promise<unknown>) => {
    await deliveryScope.run({ deliveryId }, apply);
    return intentJob(db);
  };
  const mirror = await stage("mirror", () => outbox.plane.apply({ ...target, kind: "update_issue", fields: { labels: ["mirrored"] } }));
  const first = await stage("first", () => outbox.plane.mutateIssue(target, { kind: "add_label", id: "first" }));
  const second = await stage("second", () => outbox.plane.mutateIssue(target, { kind: "add_label", id: "second" }));
  await outbox.executePlane(mirror);
  await outbox.executePlane(first);
  await outbox.executePlane(second);
  deepStrictEqual(labels, ["mirrored", "first", "second"]);
  const assign = await stage("assign", () => outbox.plane.mutateIssue(target, { kind: "assign", id: "alice" }));
  const remove = await stage("remove", () => outbox.plane.mutateIssue(target, { kind: "remove_label", id: "first" }));
  await outbox.executePlane(assign);
  await outbox.executePlane(remove);
  deepStrictEqual(assignees, ["alice"]);
  deepStrictEqual(labels, ["mirrored", "second"]);
});

test("desired GitHub assignees reconcile under the target lock, so an empty newer intent clears delayed additions", async (t) => {
  const db = await database(t), githubQueue = queue();
  await db.query("INSERT INTO user_map (workspace_slug, plane_user_id, gh_login, gh_id) VALUES ('ws','u','alice',1)");
  let current = ["unmapped"], fail = true, clock = Date.now();
  const calls: string[] = [];
  const outbox = createOrderedOutbox({ db, now: () => clock,
    queues: { plane: queue() as any, github: githubQueue as any }, loadActorToken: async () => null,
    plane: { preflight: async () => {}, apply: async () => ({ ok: true }) },
    github: { apply: async (w) => {
      if (fail) { fail = false; throw new Error("temporary network failure"); }
      if (w.kind === "add_assignees") current.push(...w.assignees);
      if (w.kind === "remove_assignees") current = current.filter((login) => !w.assignees.includes(login));
      calls.push(w.kind);
      return { ok: true };
    } }, listGithubAssignees: async () => [...current],
  });
  const target = { kind: "add_assignees" as const, installationId: 1, repoId: 2, owner: "o", repo: "r", number: 3 };
  const stage = async (id: string, assignees: string[]) => {
    await deliveryScope.run({ deliveryId: id }, () => outbox.github.setAssignees({ ...target, assignees }, "ws"));
    return intentJob(db);
  };
  const old = await stage("old", ["alice"]), newer = await stage("new", []);
  await rejects(outbox.executeGithub(old), OrderedWriteDeferredError);
  await rejects(outbox.executeGithub(newer), OrderedWriteDeferredError);
  clock += 600_000;
  await rejects(outbox.executeGithub(newer), OrderedWriteDeferredError);
  await outbox.executeGithub(newer);
  await outbox.executeGithub(old);
  deepStrictEqual(current, ["unmapped"]);
  deepStrictEqual(calls, ["add_assignees", "remove_assignees"]);
  strictEqual((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM outbound_writes WHERE status = 'applied'")).rows[0]!.n, 2);
});

test("F1/F3: label-name mutations resolve IDs outbound and preserve add→remove→add ordering", async (t) => {
  const db = await database(t), planeQueue = queue();
  let labels: string[] = [], calls = 0;
  const outbox = createOrderedOutbox({ db, queues: { plane: planeQueue as any, github: queue() as any }, loadActorToken: async () => null,
    plane: { preflight: async () => {}, apply: async (w) => {
      calls++;
      if (w.kind === "upsert_label") return { ok: true, id: "label" };
      if (w.kind === "update_issue") labels = w.fields.labels as string[];
      return { ok: true };
    } }, github: { apply: async () => ({ ok: true }) }, readPlaneIssueFields: async () => ({ labels: [...labels], assignees: [] }) });
  await deliveryScope.run({ deliveryId: "labels" }, async () => {
    for (const kind of ["add_label", "remove_label", "add_label"] as const)
      await outbox.plane.mutateIssue({ slug: "ws", projectId: "p", issueId: "i" }, { kind, name: "bug" });
  });
  strictEqual(calls, 0);
  strictEqual(planeQueue.jobs.size, 1);
  const rows = (await db.query<{ id: string }>("SELECT id FROM outbound_writes ORDER BY sequence")).rows;
  strictEqual(rows.length, 6);
  for (const row of rows) await outbox.executePlane(await intentJob(db, row.id));
  deepStrictEqual(labels, ["label"]);
  strictEqual(calls, 6);
});
