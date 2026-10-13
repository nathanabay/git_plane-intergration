#!/usr/bin/env node
// Oracle for tasks A5 (spec §6) and A7 (spec §1.3), plus the wave-4 storage additions other
// leaves consume: audit workspace scoping, inbound deliveries audited with their payload (B8
// replay), and the dev-info link table (B7).
import { resolve, join } from "node:path";
import { createServer } from "node:http";
import { strictEqual, deepStrictEqual, ok } from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";

const root = resolve(import.meta.dirname, "..");
const results = [];
async function check(name, fn, ms = 60000) {
  let timer;
  const limit = new Promise((_, no) => { timer = setTimeout(() => no(new Error(`timed out after ${ms}ms`)), ms); });
  try { await Promise.race([fn(), limit]); results.push([name, null]); console.log(`ok   ${name}`); }
  catch (e) { results.push([name, e]); console.error(`FAIL: ${name}: ${String(e?.message ?? e).split("\n")[0]}`); }
  finally { clearTimeout(timer); }
}

const P = await import(join(root, "src/parse/references.ts"));
const { DEFAULT_MAGIC_WORDS } = await import(join(root, "src/parse/magicWords.ts"));
const R = await import(join(root, "src/sync/reconcile.ts"));
const { migrate } = await import(join(root, "src/db/migrate.ts"));
const L = await import(join(root, "src/db/ledgers.ts"));
const W = await import(join(root, "src/queue/workers.ts"));
const { PlaneClient } = await import(join(root, "src/sync/plane.ts"));
const { SecretString } = await import(join(root, "src/auth/identity.ts"));

const tierOf = (res, id) => res.refs.find((r) => r.identifier === id)?.tier;

await check("§6 magic-word tables ship as the defaults, all three tiers", () => {
  for (const w of ["close", "closes", "closed", "closing", "fix", "fixes", "fixed", "fixing", "resolve", "resolves", "resolved", "resolving", "complete", "completes", "completed", "completing", "implement", "implements", "implemented", "implementing"]) ok(DEFAULT_MAGIC_WORDS.closing.includes(w), `closing lacks ${w}`);
  for (const w of ["ref", "refs", "references", "part of", "contributes to", "toward", "towards"]) ok(DEFAULT_MAGIC_WORDS.non_closing.includes(w), `non_closing lacks ${w}`);
  for (const w of ["relates to", "related to"]) ok(DEFAULT_MAGIC_WORDS.relation.includes(w), `relation lacks ${w}`);
});

await check("magic words set the tier; multi-issue lists separated by commas, spaces or 'and' share the word", () => {
  const r = P.parseReferences({ body: "Fixes WEB-1, WEB-2 and API-9.\nPart of WEB-3\nRelates to OPS-4" });
  strictEqual(tierOf(r, "WEB-1"), "closing"); strictEqual(tierOf(r, "WEB-2"), "closing"); strictEqual(tierOf(r, "API-9"), "closing");
  strictEqual(tierOf(r, "WEB-3"), "non_closing"); strictEqual(tierOf(r, "OPS-4"), "relation");
  const parsed = r.refs.find((x) => x.identifier === "API-9"); strictEqual(parsed.project, "API"); strictEqual(parsed.sequence, 9);
});

await check("branch names and PR titles link (case-insensitive branch keys); a bare body mention is a relation; the strongest tier wins", () => {
  const r = P.parseReferences({ branch: "nathan/web-344-fix-login", title: "Improve login (WEB-345)", body: "see WEB-346, refs WEB-344" });
  strictEqual(tierOf(r, "WEB-344"), "closing"); strictEqual(tierOf(r, "WEB-345"), "closing"); strictEqual(tierOf(r, "WEB-346"), "relation");
  strictEqual(r.refs.filter((x) => x.identifier === "WEB-344").length, 1, "duplicates must collapse to one ref");
});

await check("commit messages are scanned; non-identifiers are ignored", () => {
  const r = P.parseReferences({ commits: ["closes QLL-12", "bump utf-8 and sha-256 and x-1"] });
  strictEqual(tierOf(r, "QLL-12"), "closing");
  ok(!r.refs.some((x) => /^(UTF|SHA)-/.test(x.identifier)), JSON.stringify(r.refs.map((x) => x.identifier)));
});

await check("skip/ignore in the PR body opts an identifier out entirely (§6)", () => {
  const r = P.parseReferences({ branch: "web-7-thing", body: "Fixes WEB-8\nskip WEB-7\nignore WEB-8" });
  deepStrictEqual(r.refs.map((x) => x.identifier), []);
  deepStrictEqual([...r.skipped].sort(), ["WEB-7", "WEB-8"]);
});

await check("{IDENTIFIER}-NEW requests a new work item and is not a reference", () => {
  const r = P.parseReferences({ body: "QLL-NEW and fixes QLL-3" });
  deepStrictEqual(r.createRequests, ["QLL"]);
  deepStrictEqual(r.refs.map((x) => x.identifier), ["QLL-3"]);
});

await check("configured word lists replace the defaults", () => {
  const r = P.parseReferences({ body: "squashes WEB-1 fixes WEB-2" }, { closing: ["squashes"], non_closing: [], relation: [] });
  strictEqual(tierOf(r, "WEB-1"), "closing"); strictEqual(tierOf(r, "WEB-2"), "relation");
});

await check("all linked PRs must merge before an item advances; PRs closed without merging do not block (§6)", () => {
  strictEqual(P.allLinkedPrsMerged([{ state: "merged" }, { state: "open" }]), false);
  strictEqual(P.allLinkedPrsMerged([{ state: "merged" }, { state: "merged" }]), true);
  strictEqual(P.allLinkedPrsMerged([{ state: "merged" }, { state: "closed_unmerged" }]), true);
  strictEqual(P.allLinkedPrsMerged([{ state: "closed_unmerged" }]), false);
  strictEqual(P.allLinkedPrsMerged([]), false);
});

// ---- A7 + storage additions -------------------------------------------------------------------
const db = new PGlite(); await db.waitReady; await migrate(db);
const calls = [];
// Plane A2 (src/sync/reconcile.ts): a 404 alone does not orphan. The sweep asks the project (archived?) and the
// item's activities (deleted or archived?): a confirmed delete orphans at once, an archived item stays linked
// (marked, no linkback), and an unexplained 404 orphans only when a second sweep agrees. Item paths are
// `work-items/` (A10); v1.4.2 serves the same views under the deprecated `issues/`, so the fake answers both.
// i1 visible, i2 deleted, i3 erroring, i4 archived, i5 unexplained 404.
const ITEM = { i1: 200, i2: 404, i3: 500, i4: 404, i5: 404 };
const ACTIVITIES = {
  i2: [{ verb: "updated", field: "name", created_at: "2026-10-01T00:00:00Z" }, { verb: "deleted", field: "issue", created_at: "2026-10-02T00:00:00Z" }],
  i4: [{ verb: "updated", field: "archived_at", new_value: "2026-10-02", created_at: "2026-10-02T00:00:00Z" }],
  i5: [],
};
const api = createServer((req, res) => {
  calls.push(`${req.method} ${req.url}`);
  const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const path = req.url.split("?")[0];
  const base = "/api/v1/workspaces/qelal/projects/p1/";
  if (req.method !== "GET") return send(405, { error: "read only" });
  if (path === base) return send(200, { id: "p1", archived_at: null });
  const m = /^\/api\/v1\/workspaces\/qelal\/projects\/p1\/(?:issues|work-items)\/(?:([^/]+)\/(activities\/)?)?$/.exec(path);
  if (!m) return send(404, { error: "Not found" });
  const [, id, activities] = m;
  if (!id) return send(200, { results: [{ id: "i1" }], next_cursor: null, next_page_results: false, total_pages: 1 });
  if (activities) return id in ACTIVITIES ? send(200, { results: ACTIVITIES[id], next_cursor: null, next_page_results: false }) : send(404, { error: "Not found" });
  const status = ITEM[id] ?? 404;
  send(status, status === 200 ? { id } : { error: status === 404 ? "Not found" : "boom" });
});
await new Promise((r) => api.listen(0, "127.0.0.1", r));
const client = new PlaneClient({ baseUrl: `http://127.0.0.1:${api.address().port}`, token: new SecretString("plane_api_x"), maxRetries: 0, rateLimitPerMinute: 0, sleep: async () => {} });
const linkRows = async () => Object.fromEntries((await db.query(`SELECT plane_issue_id, status, last_checked_at, plane_archived_at, missing_since FROM sync_links`)).rows.map((r) => [r.plane_issue_id, r]));
const auditKinds = async () => (await db.query(`SELECT kind, outcome, detail FROM audit_log WHERE kind LIKE 'sync_link_%' ORDER BY id`)).rows;

await check("reconciliation (A2): a confirmed delete orphans; an archived item stays linked with no linkback; one unexplained 404 waits; errors never orphan; nothing is written to Plane (§1.3)", async () => {
  for (const i of Object.keys(ITEM)) await L.upsertSyncLink(db, { planeWorkspaceSlug: "qelal", planeProjectId: "p1", planeIssueId: i, ghRepoId: 1, ghNumber: Number(i[1]), ghKind: "issue", tier: "closing", createdBy: "manual" });
  const orphans = [];
  const out = await R.reconcileOnce({ db, plane: client, onOrphan: async (l) => { orphans.push(String(l.plane_issue_id ?? l.planeIssueId)); } });
  deepStrictEqual(out, { checked: 5, orphaned: 1, archived: 1, errors: 1 });
  const st = await linkRows();
  strictEqual(st.i2.status, "orphaned", "a confirmed delete must orphan at once");
  for (const i of ["i1", "i3", "i4", "i5"]) strictEqual(st[i].status, "active", `${i} must stay active`);
  ok(st.i1.last_checked_at, "a successful check must stamp last_checked_at");
  ok(st.i4.plane_archived_at, "an archived item must be marked archived");
  ok(st.i5.missing_since, "an unexplained 404 must be remembered for the next sweep");
  strictEqual(st.i1.missing_since, null); strictEqual(st.i3.missing_since, null, "an error is not a 404");
  deepStrictEqual(orphans, ["i2"], "only the deleted item is reported (no linkback for archived or unconfirmed items)");
  const audit = await auditKinds();
  deepStrictEqual(audit.map((a) => [a.kind, a.outcome]).sort(), [["sync_link_archived", "archived"], ["sync_link_missing", "awaiting_confirmation"], ["sync_link_orphaned", "orphaned"]]);
  strictEqual(audit.find((a) => a.kind === "sync_link_orphaned").detail.reason, "deleted");
  ok(calls.every((c) => c.startsWith("GET ")), `reconcile wrote to Plane: ${calls.join(", ")}`);
});

await check("second sweep: the unexplained 404 is confirmed and orphaned; the archived item stays linked, unreported, with one read; orphaned links are not re-checked; pruning removes expired applied ops", async () => {
  calls.length = 0;
  const orphans = [];
  const out = await R.reconcileOnce({ db, plane: client, onOrphan: async (l) => { orphans.push(String(l.plane_issue_id ?? l.planeIssueId)); } });
  deepStrictEqual(out, { checked: 4, orphaned: 1, archived: 1, errors: 1 });
  deepStrictEqual(orphans, ["i5"]);
  const st = await linkRows();
  strictEqual(st.i5.status, "orphaned"); strictEqual(st.i4.status, "active");
  const orphaned = (await auditKinds()).filter((a) => a.kind === "sync_link_orphaned");
  strictEqual(orphaned.at(-1).detail.reason, "not_found_twice");
  strictEqual((await auditKinds()).filter((a) => a.kind === "sync_link_archived").length, 1, "an archived item is audited once, not every sweep");
  ok(!calls.some((c) => /\/i2\//.test(c)), `an orphaned link was re-checked: ${calls.join(", ")}`);
  ok(!calls.some((c) => /\/i4\/activities\//.test(c)), "a known-archived item was re-classified instead of read once");
  ok(calls.every((c) => c.startsWith("GET ")));
  await db.query(`INSERT INTO applied_ops (op_hash, direction, created_at) VALUES ('stale', 'to_plane', now() - interval '3 hours')`);
  const pruned = await R.pruneExpiredOps({ db, ttlMinutes: 30 });
  ok(pruned >= 1);
});

await check("audit entries can be scoped to a workspace (B3's workspace audit view, B8)", async () => {
  ok((await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'audit_log' AND column_name = 'workspace_slug'`)).rows.length === 1, "audit_log.workspace_slug missing");
  const id = await L.appendAudit(db, { kind: "rule_match", workspaceSlug: "qelal", outcome: "ok" });
  strictEqual((await db.query(`SELECT workspace_slug FROM audit_log WHERE id = $1`, [id])).rows[0].workspace_slug, "qelal");
});

await check("every inbound delivery is audited with its payload and outcome, so B8 can replay it (§7.6)", async () => {
  const job = { source: "github", deliveryId: "aud-1", event: "push", receivedAt: new Date().toISOString(), payload: { ref: "refs/heads/main", repository: { id: 9 } } };
  const out = await W.processInbound(job, { db, opTtlMinutes: 30, onPlaneEvent: async () => {}, onGithubEvent: async () => {} });
  strictEqual(out, "handled");
  const row = (await db.query(`SELECT kind, source, delivery_id, detail, outcome FROM audit_log WHERE delivery_id = 'aud-1'`)).rows[0];
  ok(row, "no audit row for the delivery");
  strictEqual(row.kind, "inbound_delivery");
  deepStrictEqual(row.detail.payload, job.payload); strictEqual(row.detail.event, "push");
  const failing = { ...job, deliveryId: "aud-2" };
  await W.processInbound(failing, { db, opTtlMinutes: 30, onPlaneEvent: async () => {}, onGithubEvent: async () => { throw new Error("reducer broke"); } }).catch(() => {});
  const bad = (await db.query(`SELECT outcome, error FROM audit_log WHERE delivery_id = 'aud-2' ORDER BY id DESC LIMIT 1`)).rows[0];
  ok(bad && bad.outcome !== "ok" && /reducer broke/.test(bad.error ?? ""), `failed delivery not audited as failed: ${JSON.stringify(bad)}`);
});

await check("dev-info links are stored per issue and key so B7 can update them in place", async () => {
  await L.upsertDevInfoLink(db, { planeIssueId: "i1", key: "pr:1:12", planeLinkId: "link-1" });
  await L.upsertDevInfoLink(db, { planeIssueId: "i1", key: "pr:1:12", planeLinkId: "link-1b" });
  strictEqual(await L.getDevInfoLink(db, "i1", "pr:1:12"), "link-1b");
  strictEqual(await L.getDevInfoLink(db, "i1", "pr:1:99"), null);
});

api.close(); await db.close();
let bad = 0;
for (const [, err] of results) if (err) bad++;
if (bad) process.exit(1);
console.log(`A5/A7 verification passed (${results.length} checks)`);
process.exit(0);
