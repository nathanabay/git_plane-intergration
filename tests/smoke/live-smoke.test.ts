// Live smoke test (spec §10): drives the real A4 Plane write path against a real Plane, in a throwaway
// project. Runs only when SMOKE_PLANE_URL, SMOKE_PLANE_PAT, SMOKE_WORKSPACE and SMOKE_PROJECT are set;
// otherwise every test here is skipped. It creates one work item and deletes it again.
import test from "node:test";
import { strictEqual, ok, deepStrictEqual } from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { SecretString } from "../../src/auth/identity.ts";
import { migrate } from "../../src/db/migrate.ts";
import { PlaneClient, PlaneWritePath, TriageWriteRejected } from "../../src/sync/plane.ts";
import { opHash } from "../../src/sync/ophash.ts";

const { SMOKE_PLANE_URL, SMOKE_PLANE_PAT, SMOKE_WORKSPACE, SMOKE_PROJECT } = process.env;
const configured = Boolean(SMOKE_PLANE_URL && SMOKE_PLANE_PAT && SMOKE_WORKSPACE && SMOKE_PROJECT);
const skip = configured ? false : "set SMOKE_PLANE_URL, SMOKE_PLANE_PAT, SMOKE_WORKSPACE and SMOKE_PROJECT to run";

test("live Plane: create, update, comment, link, label and clean up through the write path", { skip, timeout: 120_000 }, async () => {
  const slug = SMOKE_WORKSPACE!, projectId = SMOKE_PROJECT!;
  const db = new PGlite();
  await db.waitReady;
  await migrate(db);
  const client = new PlaneClient({ baseUrl: SMOKE_PLANE_URL!, token: new SecretString(SMOKE_PLANE_PAT!) });
  const writer = new PlaneWritePath({ client, db });
  const base = `/workspaces/${slug}/projects/${projectId}`;
  let issueId: string | undefined;
  try {
    const states = await client.listStates(slug, projectId);
    ok(states.length > 0, "the project has no states");

    const created = await writer.apply({ kind: "create_issue", slug, projectId, fields: { name: `git-sync smoke ${new Date().toISOString()}` } });
    issueId = created.id;
    ok(issueId, "create_issue returned no id");
    strictEqual((await db.query("SELECT 1 FROM applied_ops WHERE op_hash = $1", [opHash("plane", issueId!, "created", null)])).rows.length, 1);

    const issue: any = await client.getIssue(slug, projectId, issueId!);
    strictEqual(issue.id, issueId);

    const target = states.find((s) => s.group === "started") ?? states.find((s) => s.group !== "triage")!;
    await writer.apply({ kind: "update_issue", slug, projectId, issueId: issueId!, fields: { state: target.id, name: "git-sync smoke (renamed)" } });
    const after: any = await client.getIssue(slug, projectId, issueId!);
    strictEqual(after.name, "git-sync smoke (renamed)");
    strictEqual(after.state?.id ?? after.state, target.id);

    ok((await writer.apply({ kind: "add_comment", slug, projectId, issueId: issueId!, commentHtml: "<p>smoke comment</p>" })).id);

    const url = `https://example.com/git-sync-smoke/${Date.now()}`;
    const first = await writer.apply({ kind: "add_link", slug, projectId, issueId: issueId!, url, title: "[PR] smoke" });
    ok(first.id, "add_link returned no id");
    deepStrictEqual(await writer.apply({ kind: "add_link", slug, projectId, issueId: issueId!, url, title: "[PR] smoke" }), { ok: true, duplicate: true });
    await writer.apply({ kind: "update_link", slug, projectId, issueId: issueId!, linkId: first.id!, url, title: "[PR] smoke · MERGED" });

    const label = await writer.apply({ kind: "upsert_label", slug, projectId, name: "git-sync-smoke" });
    strictEqual((await writer.apply({ kind: "upsert_label", slug, projectId, name: "git-sync-smoke" })).id, label.id);

    const triage = states.find((s) => s.group === "triage");
    if (triage) await assertRejects(writer.apply({ kind: "update_issue", slug, projectId, issueId: issueId!, fields: { state: triage.id } }));

    const unknownProject = await client.getIssueByIdentifier(slug, "ZZZZ-999999").then(() => "found", (e: { status?: number }) => e.status);
    strictEqual(unknownProject, 403);
    const projects = await client.listAll<{ id: string; identifier: string }>(`/workspaces/${slug}/projects/`);
    const project = projects.find((p) => p.id === projectId);
    const projIdent = project?.identifier ?? "QLL";
    const unknownSequence = await client.getIssueByIdentifier(slug, `${projIdent}-999999`).then(() => "found", (e: { status?: number }) => e.status);
    strictEqual(unknownSequence, 404);
  } finally {
    if (issueId) await client.request("DELETE", `${base}/issues/${issueId}/`).catch(() => undefined);
    await db.close();
  }
});

async function assertRejects(p: Promise<unknown>): Promise<void> {
  try { await p; } catch (e) { ok(e instanceof TriageWriteRejected, "expected TriageWriteRejected"); return; }
  throw new Error("expected the write into the triage group to be rejected");
}
