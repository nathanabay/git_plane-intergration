import test from "node:test";
import { strictEqual, deepStrictEqual, rejects } from "node:assert/strict";
import { readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../../src/db/migrate.ts";
import { appendAudit, getDevInfoLink, markLinkChecked, upsertDevInfoLink, upsertSyncLink } from "../../src/db/ledgers.ts";

async function setup() { const db = new PGlite(); await db.waitReady; await migrate(db); return db; }

test("migrations: every file in src/db/migrations applies in order and a re-run applies nothing", async () => {
  const db = await setup();
  const files = readdirSync(new URL("../../src/db/migrations/", import.meta.url)).filter((f) => f.endsWith(".sql")).sort();
  strictEqual(files[0], "001-init.sql");
  strictEqual(files.includes("002-audit-scope-devinfo.sql"), true);
  deepStrictEqual((await db.query<any>("SELECT version FROM schema_migrations ORDER BY version")).rows.map((r) => r.version), files);
  deepStrictEqual((await migrate(db)).applied, []);
});
test("audit: workspace_slug is stored, optional, and filterable", async () => {
  const db = await setup();
  await appendAudit(db, { kind: "k", outcome: "ok", workspaceSlug: "a" });
  await appendAudit(db, { kind: "k", outcome: "ok", workspaceSlug: "b" });
  await appendAudit(db, { kind: "k", outcome: "ok" });
  strictEqual((await db.query("SELECT 1 FROM audit_log WHERE workspace_slug = 'a'")).rows.length, 1);
  strictEqual((await db.query("SELECT 1 FROM audit_log WHERE workspace_slug IS NULL")).rows.length, 1);
});
test("dev-info links: upsert replaces the link id, keys are per issue", async () => {
  const db = await setup();
  await upsertDevInfoLink(db, { planeIssueId: "i1", key: "k", planeLinkId: "a" });
  await upsertDevInfoLink(db, { planeIssueId: "i2", key: "k", planeLinkId: "x" });
  await upsertDevInfoLink(db, { planeIssueId: "i1", key: "k", planeLinkId: "b" });
  strictEqual(await getDevInfoLink(db, "i1", "k"), "b");
  strictEqual(await getDevInfoLink(db, "i2", "k"), "x");
  strictEqual(await getDevInfoLink(db, "i3", "k"), null);
  strictEqual((await db.query("SELECT 1 FROM dev_info_links")).rows.length, 2);
});
test("dev-info links: the primary key rejects a duplicate raw insert", async () => {
  const db = await setup();
  await db.query("INSERT INTO dev_info_links (plane_issue_id, key, plane_link_id) VALUES ('i','k','a')");
  await rejects(db.query("INSERT INTO dev_info_links (plane_issue_id, key, plane_link_id) VALUES ('i','k','b')"));
});
test("markLinkChecked stamps last_checked_at without touching status", async () => {
  const db = await setup();
  const id = await upsertSyncLink(db, { planeWorkspaceSlug: "w", planeProjectId: "p", planeIssueId: "i", ghRepoId: 1, ghNumber: 1, ghKind: "pr", tier: "relation", createdBy: "branch" });
  await markLinkChecked(db, id);
  const row = (await db.query<any>("SELECT status, last_checked_at FROM sync_links WHERE id = $1", [id])).rows[0];
  strictEqual(row.status, "active"); strictEqual(!!row.last_checked_at, true);
});
