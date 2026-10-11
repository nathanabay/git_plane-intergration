import test from "node:test";
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { createOrderedOutbox, deliveryScope } from "../../src/app/writers.ts";
import { PlaneApiError } from "../../src/sync/plane.ts";
import { upsertRollupLink } from "../../src/sync/dev-info.ts";
import { database, queue, intentJob } from "../writers/outbox-fixture.ts";

const target = { slug: "ws", projectId: "p", issueId: "i" };

test("F1: queued rollups resolve and remember link IDs outbound, including a deleted link", async (t) => {
  const db = await database(t), planeQueue = queue();
  const writes: string[] = [];
  let next = 0, deleted = false;
  const outbox = createOrderedOutbox({ db, queues: { plane: planeQueue as any, github: queue() as any }, loadActorToken: async () => null,
    plane: { preflight: async () => {}, apply: async (w) => {
      if (w.kind === "update_link") { if (deleted) { deleted = false; throw new PlaneApiError(404, {}, "deleted"); } writes.push(`update:${w.linkId}:${w.title}`); }
      if (w.kind === "add_link") { writes.push(`add:${w.title}`); return { ok: true, id: `link-${++next}` }; }
      return { ok: true };
    } }, github: { apply: async () => ({ ok: true }) } });
  for (const title of ["OPEN", "MERGED"]) await deliveryScope.run({ deliveryId: title }, () => upsertRollupLink({ db, writer: outbox.plane }, target, "pr:2:3", { title, url: "https://github.test/o/r/pull/3" }));
  strictEqual((await db.query("SELECT 1 FROM dev_info_links")).rows.length, 0);
  const rows = (await db.query<{ id: string }>("SELECT id FROM outbound_writes ORDER BY sequence")).rows;
  for (const row of rows) await outbox.executePlane(await intentJob(db, row.id));
  deepStrictEqual(writes, ["add:OPEN", "update:link-1:MERGED"]);
  deleted = true;
  await deliveryScope.run({ deliveryId: "reopened" }, () => upsertRollupLink({ db, writer: outbox.plane }, target, "pr:2:3", { title: "REOPENED", url: "https://github.test/o/r/pull/3" }));
  await outbox.executePlane(await intentJob(db));
  strictEqual((await db.query<{ plane_link_id: string }>("SELECT plane_link_id FROM dev_info_links")).rows[0]!.plane_link_id, "link-2");
});
