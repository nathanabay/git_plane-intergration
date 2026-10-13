// Security audit S5: backfill took an installation token without checking the calling workspace's allow-list, so a
// workspace whose installation was disconnected, removed or claimed by another workspace kept reading the repository.
import test from "node:test";
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { ADM, setup } from "./harness.ts";

test("S5: backfill uses only the mapping's own installation, and only while this workspace allow-lists it", async () => {
  const used: number[] = [];
  const h = await setup([], { enqueue: async () => {}, resolveIssue: async () => null,
    githubFor: async (repo) => { used.push(repo.installationId); return { request: async () => ({ data: [], headers: {} }) }; } });
  try {
    const id = Number((await h.db.query<{ id: number }>(`INSERT INTO repo_mappings
      (workspace_slug, gh_repo_id, gh_repo_full_name, plane_project_id, sync_direction, installation_id)
      VALUES ('acme', 42, 'o/r', 'p1', 'bidirectional', 7) RETURNING id`)).rows[0]!.id);
    const backfill = () => h.call("POST", `/workspaces/acme/mappings/${id}/backfill`, { cookie: ADM });

    // Installation 7 now belongs to another workspace: the stale acme mapping must not use it.
    await h.db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (7, 'other')");
    strictEqual((await backfill()).status, 403);
    // Another workspace's allowed mapping of the same repository lends no authority either.
    await h.db.query(`INSERT INTO repo_mappings (workspace_slug, gh_repo_id, gh_repo_full_name, plane_project_id, sync_direction, installation_id)
      VALUES ('other', 42, 'o/r', 'p9', 'bidirectional', 7)`);
    strictEqual((await backfill()).status, 403);
    // A legacy mapping with no installation at all is refused too.
    await h.db.query("UPDATE repo_mappings SET installation_id = NULL WHERE id = $1", [id]);
    strictEqual((await backfill()).status, 403);
    deepStrictEqual(used, [], "no installation token was requested");
    strictEqual((await h.db.query("SELECT 1 FROM sync_links")).rows.length, 0);

    // Positive control: once this workspace allow-lists its own installation, backfill runs through exactly that one.
    await h.db.query("UPDATE repo_mappings SET installation_id = 8 WHERE id = $1", [id]);
    await h.db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (8, 'acme')");
    strictEqual((await backfill()).status, 200);
    deepStrictEqual(used, [8]);
  } finally { await h.close(); }
});
