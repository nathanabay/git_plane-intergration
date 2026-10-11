import test from "node:test";
import { strictEqual, deepStrictEqual, ok, rejects } from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../../src/db/migrate.ts";
import { processInbound } from "../../src/queue/workers.ts";
import type { InboundDeps } from "../../src/queue/workers.ts";
import type { InboundJob } from "../../src/queue/index.ts";

async function setup(over: Partial<InboundDeps> = {}) {
  const db = new PGlite(); await db.waitReady; await migrate(db);
  const deps: InboundDeps = { db, opTtlMinutes: 30, onPlaneEvent: async () => {}, onGithubEvent: async () => {}, ...over };
  return { db, deps };
}
const rows = (db: PGlite, id: string) => db.query<any>("SELECT kind, source, outcome, error, detail, workspace_slug FROM audit_log WHERE delivery_id = $1 ORDER BY id", [id]).then((r) => r.rows);
const gh = (id: string, payload: object = { repository: { id: 9 } }): InboundJob => ({ source: "github", deliveryId: id, event: "push", receivedAt: "", payload });
const pl = (id: string, extra: object = {}): InboundJob => ({ source: "plane", deliveryId: id, event: "issue", receivedAt: "", payload: { workspace_slug: "ws", data: { id: "i" }, activity: { field: "name", new_value: "x", actor: { id: "h" } }, ...extra } });

test("audit: a handled delivery stores event and payload, no headers", async () => {
  const { db, deps } = await setup();
  await processInbound(gh("a", { repository: { id: 9 }, ref: "r" }), deps);
  const [r] = await rows(db, "a");
  strictEqual(r.kind, "inbound_delivery"); strictEqual(r.outcome, "handled"); strictEqual(r.source, "github");
  deepStrictEqual(r.detail, { event: "push", payload: { repository: { id: 9 }, ref: "r" } });
});
test("audit: a duplicate is audited without repeating the payload", async () => {
  const { db, deps } = await setup();
  await processInbound(gh("a"), deps); await processInbound(gh("a"), deps);
  const r = await rows(db, "a");
  deepStrictEqual(r.map((x) => x.outcome), ["handled", "duplicate"]);
  deepStrictEqual(r[1].detail, { event: "push" });
});
test("audit: an echo is audited as echo", async () => {
  const { db, deps } = await setup({ serviceUserId: "svc" });
  await processInbound(pl("e", { activity: { field: "name", new_value: "x", actor: { id: "svc" } } }), deps);
  strictEqual((await rows(db, "e"))[0].outcome, "echo");
});
test("audit: transient failure followed by success leaves no unsuperseded failed row, final failure is audited (F14)", async () => {
  let fail = true;
  const { db, deps } = await setup({ onGithubEvent: async () => { if (fail) throw new Error("reducer broke"); } });

  // (a) Transient failure (attemptsMade: 0, maxAttempts: 10) leaves no failed row
  await rejects(
    processInbound(gh("f-transient"), deps, { attemptsMade: 0, maxAttempts: 10 }),
    /reducer broke/
  );
  let r = await rows(db, "f-transient");
  strictEqual(r.length, 0, "transient failure must not write a failed audit row");

  // Subsequent success leaves only handled row (no unsuperseded failed row)
  fail = false;
  strictEqual(
    await processInbound(gh("f-transient"), deps, { attemptsMade: 1, maxAttempts: 10 }),
    "handled"
  );
  r = await rows(db, "f-transient");
  deepStrictEqual(r.map((x) => x.outcome), ["handled"]);

  // (b) Failure on final attempt (attemptsMade: 9, maxAttempts: 10) writes exactly one failed row
  fail = true;
  await rejects(
    processInbound(gh("f-final"), deps, { attemptsMade: 9, maxAttempts: 10 }),
    /reducer broke/
  );
  r = await rows(db, "f-final");
  strictEqual(r.length, 1);
  strictEqual(r[0].outcome, "failed");
  ok(/reducer broke/.test(r[0].error));

  // If a later attempt eventually succeeds (recovery/redelivery), the failed row is marked superseded
  fail = false;
  strictEqual(
    await processInbound(gh("f-final"), deps, { attemptsMade: 1, maxAttempts: 10 }),
    "handled"
  );
  r = await rows(db, "f-final");
  deepStrictEqual(r.map((x) => x.outcome), ["superseded", "handled"]);
});
test("audit: the workspace comes from a Plane payload", async () => {
  const { db, deps } = await setup();
  await processInbound(pl("p"), deps);
  strictEqual((await rows(db, "p"))[0].workspace_slug, "ws");
});
test("audit: a GitHub delivery resolves its workspace through the repo mapping, only when unambiguous", async () => {
  const { db, deps } = await setup();
  await db.query("INSERT INTO repo_mappings (workspace_slug, gh_repo_id, gh_repo_full_name, plane_project_id, sync_direction) VALUES ('wsA', 9, 'o/r', 'p', 'bidirectional')");
  await processInbound(gh("m"), deps);
  strictEqual((await rows(db, "m"))[0].workspace_slug, "wsA");
  await db.query("INSERT INTO repo_mappings (workspace_slug, gh_repo_id, gh_repo_full_name, plane_project_id, sync_direction) VALUES ('wsB', 9, 'o/r', 'q', 'bidirectional')");
  await processInbound(gh("n"), deps);
  strictEqual((await rows(db, "n"))[0].workspace_slug, null);
});
test("audit: a delivery whose audit write fails is still handled", async () => {
  const { db, deps } = await setup();
  await db.exec("ALTER TABLE audit_log RENAME TO audit_gone");
  const quiet = console.error; console.error = () => {};
  try { strictEqual(await processInbound(gh("z"), deps), "handled"); } finally { console.error = quiet; }
});
