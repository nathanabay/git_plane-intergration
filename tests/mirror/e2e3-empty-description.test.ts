// E2E-3 regression (found by scripts/e2e S60 on the real Plane v1.4.2): an issue with an empty body was never mirrored,
// and clearing a linked issue's body never reached Plane. Plane parses `description_html` with lxml
// (`plane/api/serializers/issue.py`), which refuses an empty or whitespace-only document: `""` → 400 "Invalid HTML passed".
// The fake below refuses exactly that, as Plane does; Plane's own empty document is `<p></p>` (the model default).
import test, { afterEach } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { migrate } from "../../src/db/migrate.ts";
import { PLANE_EMPTY_DESCRIPTION, onGithubIssue } from "../../src/sync/mirror.ts";
import type { MirrorDeps } from "../../src/sync/mirror.ts";
import type { PlaneWrite } from "../../src/sync/plane.ts";
import { upsertSyncLink } from "../../src/db/ledgers.ts";
import { QLL, fakeGithubWriter, fakePlaneWriter } from "../github/fakes.ts";

const databases: PGlite[] = [];
afterEach(async () => { for (const db of databases.splice(0)) await db.close(); });

/** Plane v1.4.2's serializer: `html.fromstring` raises on an empty document, answered as 400. */
const planeRefusesEmptyHtml = (w: PlaneWrite): Error | null => {
  const fields = (w as { fields?: Record<string, unknown> }).fields;
  if (fields && "description_html" in fields && !String(fields.description_html ?? "").trim()) {
    return new Error(`Plane ${w.kind === "create_issue" ? "POST" : "PATCH"} …/work-items/ returned 400 (Invalid HTML passed)`);
  }
  return null;
};

async function setup(extra: Partial<MirrorDeps> = {}) {
  const db = new PGlite();
  databases.push(db);
  await db.waitReady;
  await migrate(db);
  await db.query(`INSERT INTO repo_mappings (id, workspace_slug, gh_repo_id, gh_repo_full_name, plane_project_id, sync_direction) VALUES (1, 'qelal', 555, 'acme/web', 'p-qll', 'bidirectional')`);
  const plane = fakePlaneWriter({ failOn: planeRefusesEmptyHtml });
  const deps: MirrorDeps = {
    db, plane, github: fakeGithubWriter(),
    mapping: { id: 1, workspaceSlug: "qelal", planeProjectId: "p-qll", ghRepoId: 555, syncDirection: "bidirectional", installationId: 9, owner: "acme", repo: "web" },
    users: { planeUserIdForGithubLogin: async () => null, githubLoginForPlaneUserId: async () => null },
    listStates: async () => QLL,
    planeIssueUrl: (slug, p, id) => `https://tasks.example/${slug}/projects/${p}/issues/${id}`,
    ...extra,
  };
  return { db, plane, deps };
}

const opened = (body: unknown) => ({
  action: "opened", repository: { id: 555 }, sender: { login: "octo" },
  issue: { number: 41, title: "No body", body, labels: [{ name: "plane" }], state: "open", assignees: [], html_url: "https://github.com/acme/web/issues/41" },
});

const EMPTY_BODIES: unknown[] = [null, undefined, "", "   ", "\n\n  \r\n"];

test("E2E-3: an issue with an empty body is created in Plane with Plane's empty document", async () => {
  for (const body of EMPTY_BODIES) {
    const { plane, deps } = await setup();
    const r = await onGithubIssue(opened(body), deps);
    strictEqual(r.action, "created", `body ${JSON.stringify(body)}`);
    const create = plane.writes.find((w) => w.kind === "create_issue") as any;
    strictEqual(create.fields.description_html, PLANE_EMPTY_DESCRIPTION, `body ${JSON.stringify(body)}`);
  }
  strictEqual(PLANE_EMPTY_DESCRIPTION, "<p></p>");
});

test("E2E-3: the durable (planned) create carries Plane's empty document too", async () => {
  let steps: any[] = [];
  const { deps } = await setup();
  deps.plane = { ...deps.plane, plan: async (_generation: unknown, s: any[]) => { steps = s; return { inserted: true }; } } as any;
  strictEqual((await onGithubIssue(opened(""), deps)).action, "created");
  const create = steps.find((s) => s.kind === "write" && s.write?.kind === "create_issue");
  strictEqual(create?.write.fields.description_html, PLANE_EMPTY_DESCRIPTION);
  strictEqual(planeRefusesEmptyHtml(create.write), null, "Plane would accept the planned create");
});

test("E2E-3: clearing a linked issue's body clears the Plane description", async () => {
  for (const body of EMPTY_BODIES) {
    const { db, plane, deps } = await setup();
    await upsertSyncLink(db, { planeWorkspaceSlug: "qelal", planeProjectId: "p-qll", planeIssueId: "pi-1", ghRepoId: 555, ghNumber: 41, ghKind: "issue", tier: "relation", createdBy: "label_sync" });
    const r = await onGithubIssue({ ...opened(body), action: "edited", changes: { body: { from: "to be cleared" } } }, deps);
    deepStrictEqual(r, { action: "updated", fields: ["description"] }, `body ${JSON.stringify(body)}`);
    deepStrictEqual(plane.writes.map((w: any) => w.fields), [{ description_html: PLANE_EMPTY_DESCRIPTION }]);
  }
});

test("E2E-3: a body with content is unchanged by the fix", async () => {
  const { plane, deps } = await setup();
  await onGithubIssue(opened("line one\n\nline <two>"), deps);
  strictEqual((plane.writes.find((w) => w.kind === "create_issue") as any).fields.description_html, "<p>line one</p><p>line &lt;two&gt;</p>");
});
