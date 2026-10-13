import test, { afterEach } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../../src/db/migrate.ts";
import { strictEqual, deepStrictEqual, ok } from "node:assert/strict";
import { GATE_LABELS, defaultPolicy, onGithubIssue, onPlaneIssue, shouldApply } from "../../src/sync/mirror.ts";
import type { MirrorDeps, MirrorMapping } from "../../src/sync/mirror.ts";
import { upsertSyncLink } from "../../src/db/ledgers.ts";
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

test("policy: §7.3 defaults and the direction/policy matrix", () => {
  strictEqual(defaultPolicy("title"), "source_of_truth:github");
  strictEqual(defaultPolicy("description"), "source_of_truth:github");
  for (const f of ["state", "assignees", "labels", "comments"] as const) strictEqual(defaultPolicy(f), "last_write_wins");
  const s = (policy: any, from: any, direction: any) => shouldApply({ field: "title", policy, from, direction });
  strictEqual(s("last_write_wins", "plane", "bidirectional"), true);
  strictEqual(s("last_write_wins", "github", "github_to_plane"), true);
  strictEqual(s("last_write_wins", "plane", "github_to_plane"), false);
  strictEqual(s("source_of_truth:github", "plane", "bidirectional"), false);
  strictEqual(s("source_of_truth:plane", "github", "bidirectional"), false);
  strictEqual(s("source_of_truth:plane", "plane", "bidirectional"), true);
  strictEqual(s("source_of_truth:plane", "plane", "github_to_plane"), false);
});

const mapping = (over: Partial<MirrorMapping> = {}): MirrorMapping =>
  ({ id: 1, workspaceSlug: "qelal", planeProjectId: "p-qll", ghRepoId: 555, syncDirection: "bidirectional", installationId: 9, owner: "acme", repo: "web", ...over });

async function setup(over: Partial<MirrorMapping> = {}, extra: Partial<MirrorDeps> = {}) {
  const db = await freshDb();
  await db.query(`INSERT INTO repo_mappings (id, workspace_slug, gh_repo_id, gh_repo_full_name, plane_project_id, sync_direction) VALUES (1, 'qelal', 555, 'acme/web', 'p-qll', $1)`, [over.syncDirection ?? "bidirectional"]);
  await db.query(`INSERT INTO user_map (workspace_slug, plane_user_id, gh_login, gh_id) VALUES ('qelal', 'u-octo', 'octo', 1)`);
  const plane = fakePlaneWriter();
  const github = fakeGithubWriter();
  const deps: MirrorDeps = {
    db, plane, github, mapping: mapping(over),
    users: { planeUserIdForGithubLogin: async (l) => ({ octo: "u-octo" })[l] ?? null, githubLoginForPlaneUserId: async (id) => ({ "u-octo": "octo" })[id] ?? null },
    listStates: async () => QLL,
    planeIssueUrl: (slug, p, id) => `https://tasks.example/${slug}/projects/${p}/issues/${id}`,
    ...extra,
  };
  return { db, plane, github, deps };
}

const ghIssue = (o: object = {}) => ({ number: 41, title: "Mirror me", body: "line one\n\nline <two>", labels: [{ name: "plane" }, { name: "bug" }], state: "open", assignees: [{ id: 1, login: "octo" }, { id: 2, login: "stranger" }], html_url: "https://github.com/acme/web/issues/41", ...o });
const ghEvent = (action: string, o: object = {}, extra: object = {}) => ({ action, issue: ghIssue(o), repository: { id: 555 }, sender: { login: "octo" }, ...extra });

async function linked(db: any, ghNumber = 41, planeIssueId = "pi-1") {
  await upsertSyncLink(db, { planeWorkspaceSlug: "qelal", planeProjectId: "p-qll", planeIssueId, ghRepoId: 555, ghNumber, ghKind: "issue", tier: "relation", createdBy: "label_sync" });
}

test("github→plane: an unlabelled issue, a PR and another repository do nothing", async () => {
  const { plane, github, deps } = await setup();
  strictEqual((await onGithubIssue(ghEvent("opened", { labels: [{ name: "bug" }] }), deps)).action, "ignored");
  strictEqual((await onGithubIssue(ghEvent("labeled", {}, { label: { name: "bug" } }), deps)).action, "ignored");
  strictEqual((await onGithubIssue(ghEvent("opened", { pull_request: {} }), deps)).action, "ignored");
  strictEqual((await onGithubIssue({ ...ghEvent("opened"), repository: { id: 1 } }, deps)).action, "ignored");
  strictEqual(plane.writes.length + github.writes.length, 0);
});

test("github→plane: the `plane` label creates a linked, fully populated Plane item and cross-links both sides", async () => {
  const { db, plane, github, deps } = await setup();
  const r = await onGithubIssue(ghEvent("labeled", {}, { label: { name: "plane" } }), deps);
  strictEqual(r.action, "created");
  const create = plane.writes.find((w) => w.kind === "create_issue") as any;
  strictEqual(create.fields.name, "Mirror me");
  strictEqual(create.fields.description_html, "<p>line one</p><p>line &lt;two&gt;</p>");
  deepStrictEqual(create.fields.assignees, ["u-octo"]);
  strictEqual(create.fields.labels.length, 1, "the gate label must not become a Plane label");
  const upserts = plane.writes.filter((w) => w.kind === "upsert_label").map((w: any) => w.name);
  deepStrictEqual(upserts, ["github", "bug"]);
  const link = (await db.query<any>(`SELECT * FROM sync_links WHERE gh_number = 41`)).rows[0];
  strictEqual(link.created_by, "label_sync");
  strictEqual(link.plane_project_id, "p-qll");
  const comment = github.writes.find((w) => w.kind === "comment");
  ok(comment.body.includes("https://tasks.example/qelal/projects/p-qll/issues/"), comment.body);
  ok(plane.writes.some((w) => w.kind === "add_comment" && /Mirrored from GitHub/.test((w as any).commentHtml)));
});

test("github→plane: an issue opened with the label is created; a closed one lands in the completed state", async () => {
  const { plane, deps } = await setup();
  strictEqual((await onGithubIssue(ghEvent("opened", { state: "closed" }), deps)).action, "created");
  strictEqual((plane.writes.find((w) => w.kind === "create_issue") as any).fields.state, "s-done");
});

test("github→plane: a second delivery for an already linked issue does not create a duplicate", async () => {
  const { plane, deps } = await setup();
  await onGithubIssue(ghEvent("labeled", {}, { label: { name: "plane" } }), deps);
  await onGithubIssue(ghEvent("labeled", {}, { label: { name: "plane" } }), deps);
  strictEqual(plane.writes.filter((w) => w.kind === "create_issue").length, 1);
});

test("github→plane: title and body edits apply under the GitHub-wins defaults", async () => {
  const { db, plane, deps } = await setup();
  await linked(db);
  const r = await onGithubIssue(ghEvent("edited", { title: "New", body: "B" }, { changes: { title: { from: "Old" }, body: { from: "x" } } }), deps);
  deepStrictEqual(r.fields, ["title", "description"]);
  deepStrictEqual(plane.writes.map((w: any) => w.fields), [{ name: "New" }, { description_html: "<p>B</p>" }]);
  strictEqual((plane.writes[0] as any).issueId, "pi-1");
});

test("github→plane: a source_of_truth:plane title blocks the GitHub edit but not other fields", async () => {
  const { db, plane, deps } = await setup();
  await linked(db);
  await db.query(`INSERT INTO conflict_policies (mapping_id, field, policy) VALUES (1, 'title', 'source_of_truth:plane')`);
  const r = await onGithubIssue(ghEvent("edited", { title: "New", body: "B" }, { changes: { title: {}, body: {} } }), deps);
  deepStrictEqual(r.fields, ["description"]);
  strictEqual(plane.writes.length, 1);
  strictEqual((await onGithubIssue(ghEvent("edited", { title: "New" }, { changes: { title: {} } }), deps)).action, "ignored");
});

test("github→plane: close and reopen map to completed and unstarted states", async () => {
  const { db, plane, deps } = await setup();
  await linked(db);
  await onGithubIssue(ghEvent("closed", { state: "closed" }), deps);
  await onGithubIssue(ghEvent("reopened"), deps);
  deepStrictEqual(plane.writes.map((w: any) => w.fields.state), ["s-done", "s-todo"]);
});

test("github→plane: state changes are reported, not guessed, when no state lookup is configured", async () => {
  const { db, plane, deps } = await setup({}, { listStates: undefined });
  await linked(db);
  strictEqual((await onGithubIssue(ghEvent("closed"), deps)).action, "ignored");
  strictEqual(plane.writes.length, 0);
});

test("github→plane: label changes send the full mapped set and skip the gate label", async () => {
  const { db, plane, deps } = await setup();
  await linked(db);
  await onGithubIssue(ghEvent("labeled", {}, { label: { name: "bug" } }), deps);
  const update = plane.writes.find((w) => w.kind === "update_issue") as any;
  strictEqual(update.fields.labels.length, 1);
  strictEqual((await onGithubIssue(ghEvent("labeled", {}, { label: { name: "plane" } }), deps)).reason, "gate label");
});

test("github→plane: assignees map through the user map and unmapped users leave the field empty", async () => {
  const { db, plane, deps } = await setup();
  await linked(db);
  await onGithubIssue(ghEvent("assigned"), deps);
  deepStrictEqual((plane.writes.find((w) => w.kind === "update_issue") as any).fields, { assignees: ["u-octo"] });
  plane.writes.length = 0;
  await onGithubIssue(ghEvent("unassigned", { assignees: [{ login: "stranger" }] }), deps);
  deepStrictEqual((plane.writes[0] as any).fields, { assignees: [] });
});

test("github→plane: new comments are mirrored with escaped text; edits are not", async () => {
  const { db, plane, deps } = await setup();
  await linked(db);
  const c = { user: { login: "octo" }, body: "<script>x</script>", html_url: "https://github.com/acme/web/issues/41#c1" };
  await onGithubIssue(ghEvent("created", {}, { comment: c }), deps);
  const html = (plane.writes[0] as any).commentHtml as string;
  ok(!html.includes("<script>") && html.includes("&lt;script&gt;") && html.includes("octo"));
  strictEqual((await onGithubIssue(ghEvent("edited", {}, { comment: c }), deps)).action, "ignored");
  await onGithubIssue(ghEvent("created", { number: 99 }, { comment: c }), deps);
  strictEqual(plane.writes.length, 1, "a comment on an unlinked issue must not be mirrored");
});

test("github→plane: comments policy can switch comment mirroring off", async () => {
  const { db, plane, deps } = await setup();
  await linked(db);
  await db.query(`INSERT INTO conflict_policies (mapping_id, field, policy) VALUES (1, 'comments', 'source_of_truth:plane')`);
  strictEqual((await onGithubIssue(ghEvent("created", {}, { comment: { body: "x" } }), deps)).action, "ignored");
  strictEqual(plane.writes.length, 0);
});

// ---- Plane → GitHub ----------------------------------------------------------------------------------
const planeJob = (event: string, action: string, data: object, activity?: object) =>
  ({ event, payload: { event, action, data: { id: "pi-1", project: "p-qll", name: "Plane title", description_html: "<p>Hi <b>there</b></p>", labels: [], assignees: [], ...data }, ...(activity ? { activity } : {}) } });

test("plane→github: the `github` label creates a labelled GitHub issue, links it and cross-links", async () => {
  const { db, plane, github, deps } = await setup();
  const r = await onPlaneIssue(planeJob("issue", "create", { labels: [{ name: "github" }, { name: "ui" }] }), deps);
  strictEqual(r.action, "created");
  const create = github.writes[0];
  strictEqual(create.kind, "create_issue");
  strictEqual(create.title, "Plane title");
  deepStrictEqual(create.labels, ["plane", "ui"]);
  // C6: Plane's <b> becomes Markdown bold (the converter keeps formatting instead of flattening it).
  ok(create.body.startsWith("Hi **there**") && create.body.includes("Mirrored from Plane"), create.body);
  const link = (await db.query<any>(`SELECT * FROM sync_links WHERE plane_issue_id = 'pi-1'`)).rows[0];
  strictEqual(Number(link.gh_number), create.title ? 901 : 0);
  strictEqual(link.created_by, "label_sync");
  ok(plane.writes.some((w) => w.kind === "add_comment" && /acme\/web#901/.test((w as any).commentHtml)));
});

test("plane→github: unlabelled items, other projects and github_to_plane mappings do nothing", async () => {
  const { github, deps } = await setup();
  strictEqual((await onPlaneIssue(planeJob("issue", "create", {}), deps)).action, "ignored");
  strictEqual((await onPlaneIssue(planeJob("issue", "create", { project: "p-other", labels: [{ name: "github" }] }), deps)).action, "ignored");
  const g2 = await setup({ syncDirection: "github_to_plane" });
  strictEqual((await onPlaneIssue(planeJob("issue", "create", { labels: [{ name: "github" }] }), g2.deps)).reason, "mapping is github_to_plane");
  strictEqual(github.writes.length + g2.github.writes.length, 0);
});

test("plane→github: with the GitHub-wins default a Plane title edit is not applied, a state change is", async () => {
  const { db, github, deps } = await setup();
  await linked(db, 41);
  strictEqual((await onPlaneIssue(planeJob("issue", "update", {}, { field: "name" }), deps)).action, "ignored");
  await onPlaneIssue(planeJob("issue", "update", { state: { id: "s-done", group: "completed" } }, { field: "state" }), deps);
  // C4: a completed-group state closes the issue as completed (GitHub's `state_reason`).
  deepStrictEqual(github.writes.map((w) => [w.kind, w.fields]), [["update_issue", { state: "closed", state_reason: "completed" }]]);
  await onPlaneIssue(planeJob("issue", "update", { state: { id: "s-prog", group: "started" } }, { field: "state" }), deps);
  deepStrictEqual(github.writes[1].fields, { state: "open", state_reason: "reopened" });
});

test("plane→github: a source_of_truth:plane title and description are applied", async () => {
  const { db, github, deps } = await setup();
  await linked(db, 41);
  await db.query(`INSERT INTO conflict_policies (mapping_id, field, policy) VALUES (1, 'title', 'source_of_truth:plane'), (1, 'description', 'last_write_wins')`);
  await onPlaneIssue(planeJob("issue", "update", {}, { field: "name" }), deps);
  await onPlaneIssue(planeJob("issue", "update", {}, { field: "description_html" }), deps);
  // C6: the description is converted to Markdown, so Plane's <b> arrives as **bold**.
  deepStrictEqual(github.writes.map((w) => w.fields), [{ title: "Plane title" }, { body: "Hi **there**" }]);
  strictEqual(github.writes[0].number, 41);
});

test("plane→github: state is read from the project's states when the payload carries only an id", async () => {
  const { db, github, deps } = await setup();
  await linked(db, 41);
  await onPlaneIssue(planeJob("issue", "update", { state: "s-wont" }, { field: "state_id" }), deps);
  strictEqual(github.writes[0].fields.state, "closed");
});

const LABELS = [{ id: "l-ui", name: "ui" }, { id: "l-bug", name: "bug" }, { id: "l-gh", name: "github" }];

test("F4: plane→github labels from real payloads: id arrays under `labels` and `label_ids`, names from the label list", async () => {
  const { db, github, deps } = await setup({}, { labelNames: async () => LABELS });
  await linked(db, 41);
  // Shapes measured on Plane v1.4.2: old/new values are UUID arrays, in the API's `labels` and the web app's `label_ids`.
  await onPlaneIssue(planeJob("issue", "update", {}, { field: "labels", old_value: ["l-bug"], new_value: ["l-bug", "l-ui"] }), deps);
  await onPlaneIssue(planeJob("issue", "update", {}, { field: "label_ids", old_value: ["l-bug", "l-ui"], new_value: ["l-ui"] }), deps);
  deepStrictEqual(github.writes.map((w) => [w.kind, w.labels ?? w.label]), [["add_labels", ["ui"]], ["remove_label", "bug"]]);
});

test("F4: the `github` gate label is never mirrored, and an id that cannot be resolved is reported, not guessed", async () => {
  const { db, github, deps } = await setup({}, { labelNames: async () => LABELS });
  await linked(db, 41);
  const only = await onPlaneIssue(planeJob("issue", "update", {}, { field: "labels", old_value: [], new_value: ["l-gh"] }), deps);
  strictEqual(only.reason, "only the gate label changed");
  const unknown = await onPlaneIssue(planeJob("issue", "update", {}, { field: "label_ids", old_value: [], new_value: ["l-zzz"] }), deps);
  strictEqual(unknown.reason, "cannot resolve the label ids to names");
  strictEqual(github.writes.length, 0);
});

test("F4: names come from the webhook's expanded data.labels when it carries them, without a label lookup", async () => {
  let lookups = 0;
  const { db, github, deps } = await setup({}, { labelNames: async () => { lookups++; return []; } });
  await linked(db, 41);
  await onPlaneIssue(planeJob("issue", "update", { labels: [{ id: "l-ui", name: "ui" }] }, { field: "labels", old_value: [], new_value: ["l-ui"] }), deps);
  deepStrictEqual(github.writes.map((w) => [w.kind, w.labels]), [["add_labels", ["ui"]]]);
  strictEqual(lookups, 0);
});

test("F4/F5: assignee ids under `assignees` and `assignee_ids` map through the user map; unmapped users are dropped", async () => {
  const { db, github, deps } = await setup();
  await linked(db, 41);
  await onPlaneIssue(planeJob("issue", "update", { assignees: ["u-octo", "u-nobody"] }, { field: "assignees", old_value: [], new_value: ["u-octo", "u-nobody"] }), deps);
  await onPlaneIssue(planeJob("issue", "update", { assignees: [{ id: "u-octo" }] }, { field: "assignee_ids", old_value: [], new_value: ["u-octo"] }), deps);
  deepStrictEqual(github.writes.map((w) => w.assignees), [["octo"], ["octo"]]);
});

test("F5: emptying Plane's assignees is sent as an empty set so the mapped GitHub assignees are removed", async () => {
  const { db, github, deps } = await setup();
  await linked(db, 41);
  const r = await onPlaneIssue(planeJob("issue", "update", { assignees: [] }, { field: "assignee_ids", old_value: ["u-octo"], new_value: [] }), deps);
  strictEqual(r.action, "updated");
  deepStrictEqual(github.writes.map((w) => [w.kind, w.assignees]), [["add_assignees", []]]);
  // Only unmapped users left: also an empty mapped set.
  github.writes.length = 0;
  await onPlaneIssue(planeJob("issue", "update", { assignees: ["u-nobody"] }, { field: "assignees", old_value: ["u-octo", "u-nobody"], new_value: ["u-nobody"] }), deps);
  deepStrictEqual(github.writes.map((w) => w.assignees), [[]]);
});

test("F3: links not created by label sync (backfill) never mirror, in either direction", async () => {
  const { db, plane, github, deps } = await setup();
  await upsertSyncLink(db, { planeWorkspaceSlug: "qelal", planeProjectId: "p-qll", planeIssueId: "pi-1", ghRepoId: 555, ghNumber: 5, ghKind: "issue", tier: "relation", createdBy: "magic_word" });
  for (const action of ["edited", "closed", "labeled", "assigned"]) {
    strictEqual((await onGithubIssue(ghEvent(action, { number: 5, title: "see also WEB-12" }, { label: { name: "bug" } }), deps)).action, "ignored", action);
  }
  await onGithubIssue(ghEvent("created", { number: 5 }, { comment: { user: { login: "octo" }, body: "hi" } }), deps);
  strictEqual(plane.writes.length, 0, "nothing reaches Plane");
  strictEqual((await onPlaneIssue(planeJob("issue", "update", {}, { field: "name" }), deps)).action, "ignored");
  strictEqual((await onPlaneIssue(planeJob("issue_comment", "create", { id: "c1", issue: "pi-1", comment_html: "<p>x</p>" }), deps)).action, "ignored");
  strictEqual(github.writes.length, 0, "nothing reaches GitHub");
});

test("plane→github: comments are mirrored for linked items only and respect the comments policy", async () => {
  const { db, github, deps } = await setup();
  await linked(db, 41);
  const job = (issue: string) => planeJob("issue_comment", "create", { id: "c1", issue, comment_html: "<p>hello</p>", actor: { display_name: "Ann" } });
  await onPlaneIssue(job("pi-1"), deps);
  await onPlaneIssue(job("pi-unlinked"), deps);
  strictEqual(github.writes.length, 1);
  ok(github.writes[0].body.includes("**Ann** commented in Plane") && github.writes[0].body.includes("hello"));
  await db.query(`INSERT INTO conflict_policies (mapping_id, field, policy) VALUES (1, 'comments', 'source_of_truth:github')`);
  strictEqual((await onPlaneIssue(job("pi-1"), deps)).action, "ignored");
});

test("plane→github: unknown fields and events are ignored, never guessed", async () => {
  const { db, github, deps } = await setup();
  await linked(db, 41);
  strictEqual((await onPlaneIssue(planeJob("issue", "update", {}, { field: "priority" }), deps)).action, "ignored");
  strictEqual((await onPlaneIssue(planeJob("cycle", "update", {}, { field: "name" }), deps)).action, "ignored");
  strictEqual((await onPlaneIssue({ event: "issue", payload: {} }, deps)).action, "ignored");
  strictEqual(github.writes.length, 0);
});
