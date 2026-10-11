import test, { afterEach } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../../src/db/migrate.ts";
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { usersFor } from "../../src/app/context.ts";
import { upsertSyncLink } from "../../src/db/ledgers.ts";
import { backfill } from "../../src/operations/tooling.ts";
import { onGithubIssue, onPlaneIssue } from "../../src/sync/mirror.ts";
import type { MirrorDeps } from "../../src/sync/mirror.ts";
import { QLL, fakeGithubWriter, fakePlaneWriter } from "../github/fakes.ts";

const databases: PGlite[] = [];
// Release each test's WASM database before starting the next test on the live Plane host.
afterEach(async () => {
  for (const db of databases.splice(0)) await db.close();
});

async function freshDb() {
  const db = new PGlite();
  databases.push(db);
  await db.waitReady;
  await migrate(db);
  return db;
}

// Sanitized UUIDs retain the activity and expanded-data shapes measured on Plane v1.4.2.
const bug = "95a43702-1111-4111-8111-111111111111";
const ui = "1f10db54-2222-4222-8222-222222222222";
const gate = "33333333-3333-4333-8333-333333333333";
const member = "44444444-4444-4444-8444-444444444444";
const stranger = "55555555-5555-4555-8555-555555555555";
const labels = [{ id: bug, name: "bug" }, { id: ui, name: "ui" }, { id: gate, name: "github" }];
const mapping = { id: 1, workspaceSlug: "qelal", planeProjectId: "p-qll", ghRepoId: 555,
  syncDirection: "bidirectional" as const, installationId: 9, owner: "acme", repo: "web" };

async function setup() {
  const db = await freshDb();
  const plane = fakePlaneWriter(), github = fakeGithubWriter();
  await db.query(`INSERT INTO user_map (workspace_slug, plane_user_id, gh_login, gh_id)
    VALUES ('qelal', $1, 'octo', 1), ('other', $2, 'outsider', 2)`, [member, stranger]);
  const deps: MirrorDeps = { db, plane, github, mapping, users: usersFor(db, mapping.workspaceSlug),
    listStates: async () => QLL, labelNames: async () => labels };
  return { db, plane, github, deps };
}

const partner = { planeWorkspaceSlug: "qelal", planeProjectId: "p-qll", planeIssueId: "pi-12",
  ghRepoId: 555, ghNumber: 5, ghKind: "issue" as const, tier: "relation" as const, createdBy: "label_sync" as const };

function planeEvent(field: string, oldValue: unknown[], newValue: unknown[], data: object = {}) {
  return { event: "issue", payload: { event: "issue", action: "updated", workspace_slug: "qelal",
    data: { id: "pi-12", project: "p-qll", labels: [], ...data },
    activity: { field, old_value: oldValue, new_value: newValue, actor: { id: member, email: "octo@example.test" } } } };
}

test("F3: real backfill of issue #5 mentioning WEB-12 cannot edit or close its referenced Plane item", async () => {
  const { db, plane, github, deps } = await setup();
  const result = await backfill({ db, mapping,
    github: { request: async (route) => ({ data: route.includes("/issues")
      ? [{ number: 5, title: "A different bug", body: "see also WEB-12" }] : [] }) },
    resolveIssue: async (key) => key === "WEB-12" ? { projectId: "p-qll", issueId: "pi-12" } : null });
  strictEqual(result.linked, 1);
  const row = (await db.query<{ created_by: string; tier: string }>(`SELECT created_by, tier FROM sync_links WHERE gh_number = 5`)).rows[0];
  deepStrictEqual(row, { created_by: "magic_word", tier: "relation" });
  const issue = { number: 5, title: "Renamed unrelated bug", body: "New body", labels: [], assignees: [] };
  for (const action of ["edited", "closed"]) {
    strictEqual((await onGithubIssue({ action, repository: { id: 555 }, issue,
      changes: { title: { from: "Old" }, body: { from: "Old" } } }, deps)).action, "ignored");
  }
  await onGithubIssue({ action: "created", repository: { id: 555 }, issue, comment: { body: "Unrelated comment" } }, deps);
  strictEqual((await onPlaneIssue(planeEvent("state", [], [], { state: { group: "completed" } }), deps)).action, "ignored");
  strictEqual((await onPlaneIssue({ event: "issue_comment", payload: { action: "created",
    data: { id: "c1", issue: "pi-12", comment_html: "<p>Comment</p>" } } }, deps)).action, "ignored");
  deepStrictEqual([plane.writes, github.writes], [[], []]);

  // Positive control: the same events must write when this link was explicitly opted in.
  await upsertSyncLink(db, partner);
  await onGithubIssue({ action: "edited", repository: { id: 555 }, issue, changes: { title: {} } }, deps);
  await onGithubIssue({ action: "closed", repository: { id: 555 }, issue }, deps);
  await onPlaneIssue(planeEvent("state", [], [], { state: { group: "completed" } }), deps);
  deepStrictEqual(plane.writes.map((w) => w.kind === "update_issue" ? w.fields : null), [{ name: issue.title }, { state: "s-done" }]);
  deepStrictEqual(github.writes.map((w) => w.fields), [{ state: "closed" }]);
});

for (const field of ["labels", "label_ids"]) {
  test(`F4: ${field} UUID arrays add expanded labels and look up removed labels`, async () => {
    const { db, github, deps } = await setup();
    await upsertSyncLink(db, partner);
    const lookups: string[][] = [];
    deps.labelNames = async (slug, projectId) => { lookups.push([slug, projectId]); return labels; };
    const r = await onPlaneIssue(planeEvent(field, [bug], [ui, gate], { labels: labels.slice(1) }), deps);
    strictEqual(r.action, "updated");
    deepStrictEqual(lookups, [["qelal", "p-qll"]]);
    deepStrictEqual(github.writes.map((w) => [w.kind, w.labels ?? w.label]), [["add_labels", ["ui"]], ["remove_label", "bug"]]);
  });

  test(`F4: ${field} empty UUID set removes labels and skips the opt-in gate`, async () => {
    const { db, github, deps } = await setup();
    await upsertSyncLink(db, partner);
    await onPlaneIssue(planeEvent(field, [bug, gate], []), deps);
    deepStrictEqual(github.writes.map((w) => [w.kind, w.label]), [["remove_label", "bug"]]);
  });

  test(`F4: ${field} UUID order alone makes no GitHub write`, async () => {
    const { db, github, deps } = await setup();
    await upsertSyncLink(db, partner);
    strictEqual((await onPlaneIssue(planeEvent(field, [bug, ui], [ui, bug]), deps)).action, "ignored");
    deepStrictEqual(github.writes, []);
  });
}

for (const field of ["assignees", "assignee_ids"]) {
  test(`F4: ${field} maps delivered UUIDs through workspace user_map`, async () => {
    const { db, github, deps } = await setup();
    await upsertSyncLink(db, partner);
    // The expanded snapshot is absent: UUIDs still resolve via the workspace map, never another workspace.
    await onPlaneIssue(planeEvent(field, [], [member, stranger]), deps);
    deepStrictEqual(github.writes.map((w) => [w.kind, w.assignees]), [["add_assignees", ["octo"]]]);
  });

  test(`F5: ${field} clearing the last mapped UUID emits the empty reconciliation set`, async () => {
    const { db, github, deps } = await setup();
    await upsertSyncLink(db, partner);
    // A later snapshot must not override the activity's empty new_value.
    strictEqual((await onPlaneIssue(planeEvent(field, [member], [], { assignees: [{ id: member }] }), deps)).action, "updated");
    deepStrictEqual(github.writes.map((w) => [w.kind, w.assignees]), [["add_assignees", []]]);
  });

  test(`F5: ${field} leaving only an unmapped UUID also emits an empty reconciliation set`, async () => {
    const { db, github, deps } = await setup();
    await upsertSyncLink(db, partner);
    await onPlaneIssue(planeEvent(field, [member, stranger], [stranger]), deps);
    deepStrictEqual(github.writes.map((w) => w.assignees), [[]]);
  });
}
