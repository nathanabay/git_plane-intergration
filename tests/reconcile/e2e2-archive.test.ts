// E2E-2 (Plane A2): on the real test Plane v1.4.2, GITSY-8 was archived (archived_at set, state Done) without an
// `archived_at` activity row, and two sweeps orphaned it. These tests drive the real PlaneClient against the exact
// responses that Plane returned for that item (fixtures/plane-v1.4.2-archived-gitsy-8.json):
//   - work-item detail: 404 {"error": "The requested resource does not exist."} (the view reads `issue_objects`,
//     which hides archived and deleted items alike);
//   - activities: 200, a page whose newest row is the state change to Done, with no archive row;
//   - list lookup `?external_source=gitsync&external_id=<intent>`: 200 with the item and `archived_at` (the view reads
//     `Issue.objects`, which hides only soft-deleted rows); an unknown external id is the same 404.
import test from "node:test";
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { SecretString } from "../../src/auth/identity.ts";
import { migrate } from "../../src/db/migrate.ts";
import { upsertSyncLink } from "../../src/db/ledgers.ts";
import { PLANE_EXTERNAL_SOURCE, PlaneClient, PlaneWritePath, planeCreatedItem, recordPlaneCreatedItem } from "../../src/sync/plane.ts";
import { reconcileOnce } from "../../src/sync/reconcile.ts";

const real = JSON.parse(readFileSync(new URL("./fixtures/plane-v1.4.2-archived-gitsy-8.json", import.meta.url), "utf8"));
const SLUG = "gitsync-test";
const PROJECT = real.project.body.id as string;
const ITEM = real.external.body.id as string;
const INTENT = real.external.body.external_id as string;
const ITEMS = `/api/v1/workspaces/${SLUG}/projects/${PROJECT}/work-items/`;

/** A Plane that answers with the captured v1.4.2 responses. `deleted` turns the archived item into a deleted one. */
function realPlane(opts: { deleted?: boolean } = {}) {
  const calls: string[] = [];
  const reply = (r: { status: number; body: unknown }) => new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    if ((init?.method ?? "GET") !== "GET") return new Response("{}", { status: 405 });
    if (url.pathname === `/api/v1/workspaces/${SLUG}/projects/${PROJECT}/`) return reply(real.project);
    if (url.pathname === `${ITEMS}${ITEM}/`) return reply(real.detail);
    if (url.pathname === `${ITEMS}${ITEM}/activities/`) return reply(real.activities);
    if (url.pathname === ITEMS && url.searchParams.get("external_source") === PLANE_EXTERNAL_SOURCE) {
      return reply(!opts.deleted && url.searchParams.get("external_id") === INTENT ? real.external : real.externalMissing);
    }
    return reply(real.externalMissing);
  }) as unknown as typeof fetch;
  return { calls, plane: new PlaneClient({ baseUrl: "http://plane.test", token: new SecretString("k"), fetch: fetchFn, rateLimitPerMinute: 0 }) };
}

async function linkedDb(opts: { createdByGitsync: boolean }) {
  const db = new PGlite(); await db.waitReady; await migrate(db);
  await upsertSyncLink(db, { planeWorkspaceSlug: SLUG, planeProjectId: PROJECT, planeIssueId: ITEM, ghRepoId: 1, ghNumber: 1, ghKind: "issue", tier: "closing", createdBy: "label_sync" });
  if (opts.createdByGitsync) await recordPlaneCreatedItem(db, { planeIssueId: ITEM, planeProjectId: PROJECT, externalSource: PLANE_EXTERNAL_SOURCE, externalId: INTENT });
  return db;
}
const linkRow = (db: PGlite) => db.query<any>("SELECT status, plane_archived_at, missing_since FROM sync_links WHERE plane_issue_id = $1", [ITEM]).then((r) => r.rows[0]);
const audits = (db: PGlite) => db.query<any>("SELECT kind, detail->>'reason' AS reason FROM audit_log WHERE kind LIKE 'sync_link_%' ORDER BY id").then((r) => r.rows.map((a) => [a.kind, a.reason]));

test("E2E-2: an item git-sync created and Plane archived without an activity row is archived on the first sweep and never orphaned", async () => {
  const db = await linkedDb({ createdByGitsync: true });
  const { plane, calls } = realPlane();
  deepStrictEqual(await reconcileOnce({ db, plane }), { checked: 1, orphaned: 0, archived: 1, errors: 0 });
  const row = await linkRow(db);
  strictEqual(row.status, "active"); ok(row.plane_archived_at, "the link is marked archived"); strictEqual(row.missing_since, null);
  ok(calls.some((c) => c.startsWith(`GET ${ITEMS}?`) && c.includes(`external_id=${INTENT}`)), "the external-id lookup was made");
  // Later sweeps (the E2E ran two): still archived, never orphaned, and only the detail read is repeated.
  calls.length = 0;
  for (let i = 0; i < 2; i++) deepStrictEqual(await reconcileOnce({ db, plane }), { checked: 1, orphaned: 0, archived: 1, errors: 0 });
  deepStrictEqual(calls, [`GET ${ITEMS}${ITEM}/`, `GET ${ITEMS}${ITEM}/`]);
  strictEqual((await linkRow(db)).status, "active");
  deepStrictEqual(await audits(db), [["sync_link_archived", null]]);
});

test("E2E-2: when the external-id lookup no longer finds the item, it was deleted: orphaned on the first sweep", async () => {
  const db = await linkedDb({ createdByGitsync: true });
  const { plane } = realPlane({ deleted: true });
  deepStrictEqual(await reconcileOnce({ db, plane }), { checked: 1, orphaned: 1, archived: 0, errors: 0 });
  strictEqual((await linkRow(db)).status, "orphaned");
  deepStrictEqual(await audits(db), [["sync_link_orphaned", "deleted"]]);
});

test("E2E-2: an item created in Plane (no external id) with the same activity log keeps the two-sweep rule and makes no lookup", async () => {
  const db = await linkedDb({ createdByGitsync: false });
  const { plane, calls } = realPlane();
  deepStrictEqual(await reconcileOnce({ db, plane }), { checked: 1, orphaned: 0, archived: 0, errors: 0 });
  strictEqual((await linkRow(db)).status, "active");
  deepStrictEqual(await reconcileOnce({ db, plane }), { checked: 1, orphaned: 1, archived: 0, errors: 0 });
  ok(!calls.some((c) => c.includes("external_id=")), "no external-id lookup without a recorded external id");
  deepStrictEqual(await audits(db), [["sync_link_missing", null], ["sync_link_orphaned", "not_found_twice"]]);
});

test("E2E-2: a mismatched external id is a lookup error, and another item's id is no evidence about this link", async () => {
  for (const body of [{ ...real.external.body, id: "00000000-0000-0000-0000-000000000000" }, { ...real.external.body, external_id: "plan-other-1" }]) {
    const fetchFn = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    const client = new PlaneClient({ baseUrl: "http://plane.test", token: new SecretString("k"), fetch: fetchFn, rateLimitPerMinute: 0, maxRetries: 0 });
    if (body.external_id !== INTENT) {
      await client.findIssueByExternalId(SLUG, PROJECT, PLANE_EXTERNAL_SOURCE, INTENT).then(() => { throw new Error("accepted a mismatched item"); }, (err) => strictEqual(err.status, 502));
    } else {
      strictEqual((await client.findIssueByExternalId(SLUG, PROJECT, PLANE_EXTERNAL_SOURCE, INTENT))?.id, body.id);
    }
  }
  // A different id with the right external id reaches reconcile, which then has no evidence about this link.
  const db = await linkedDb({ createdByGitsync: true });
  const { plane: c } = realPlane();
  const plane = {
    getIssue: c.getIssue.bind(c), getProject: c.getProject.bind(c), listIssueIds: c.listIssueIds.bind(c), listIssueActivities: c.listIssueActivities.bind(c),
    findIssueByExternalId: async () => ({ ...real.external.body, id: "00000000-0000-0000-0000-000000000000" }),
  };
  deepStrictEqual(await reconcileOnce({ db, plane }), { checked: 1, orphaned: 0, archived: 0, errors: 0 });
  strictEqual((await linkRow(db)).plane_archived_at, null);
});

test("E2E-2: a create records its external id, and migration 012 recovers older creates from retained outbox rows", async () => {
  // The create path: v1.4.2 answers the pre-create external-id lookup 404 and the POST with the new item.
  const db = new PGlite(); await db.waitReady; await migrate(db);
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if ((init?.method ?? "GET") === "GET" && url.searchParams.has("external_id")) return new Response(JSON.stringify(real.externalMissing.body), { status: 404 });
    if (init?.method === "POST") return new Response(JSON.stringify({ ...real.external.body, archived_at: null }), { status: 201 });
    return new Response("[]", { status: 200 });
  }) as unknown as typeof fetch;
  const writer = new PlaneWritePath({ client: new PlaneClient({ baseUrl: "http://plane.test", token: new SecretString("k"), fetch: fetchFn, rateLimitPerMinute: 0 }), db });
  const result = await writer.apply({ kind: "create_issue", slug: SLUG, projectId: PROJECT, fields: { name: "E2E 4.1 mirror from GitHub" } }, { intentId: INTENT });
  strictEqual(result.id, ITEM);
  deepStrictEqual(await planeCreatedItem(db, ITEM, PROJECT), { externalSource: PLANE_EXTERNAL_SOURCE, externalId: INTENT });

  // The backfill: a database at 011 with an applied create in the outbox, then upgraded.
  const dir = mkdtempSync(join(tmpdir(), "mig012-"));
  try {
    for (const f of readdirSync("src/db/migrations").filter((f) => f.endsWith(".sql") && f < "012-")) writeFileSync(join(dir, f), readFileSync(join("src/db/migrations", f)));
    const old = new PGlite(); await old.waitReady; await migrate(old, { dir });
    await old.query(`INSERT INTO outbound_writes (id, side, target_key, write, status, result) VALUES ($1, 'plane', 'k', $2::jsonb, 'applied', $3::jsonb)`,
      [INTENT, JSON.stringify({ kind: "create_issue", slug: SLUG, projectId: PROJECT, fields: {} }), JSON.stringify({ ok: true, id: ITEM })]);
    deepStrictEqual((await migrate(old)).applied, readdirSync("src/db/migrations").filter((f) => f.endsWith(".sql") && f >= "012-").sort());
    deepStrictEqual(await planeCreatedItem(old, ITEM, PROJECT), { externalSource: PLANE_EXTERNAL_SOURCE, externalId: INTENT });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
