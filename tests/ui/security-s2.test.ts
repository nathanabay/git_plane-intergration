// Security audit S2: Plane frees a deleted workspace's slug, and git-sync kept everything by slug, so whoever created a
// new workspace with that slug inherited its installation, mappings, links and private-repo audit payloads.
import test from "node:test";
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { appendAudit } from "../../src/db/ledgers.ts";
import { ADM, INST, MEM, setup } from "./harness.ts";

test("S2: a new Plane workspace reusing a slug sees none of the old workspace's data until an instance admin purges it", async () => {
  const h = await setup();
  try {
    // Positive control: the original workspace binds its slug on first use and reads its own data.
    strictEqual((await h.call("GET", "/workspaces/acme/mappings", { cookie: ADM })).status, 200);
    await h.db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (7, 'acme')");
    await h.db.query(`INSERT INTO repo_mappings (workspace_slug, gh_repo_id, gh_repo_full_name, plane_project_id, sync_direction, installation_id)
      VALUES ('acme', 555, 'acme/private', 'p1', 'bidirectional', 7)`);
    await appendAudit(h.db, { kind: "inbound_delivery", source: "github", workspaceSlug: "acme", outcome: "handled", detail: { payload: { secret: "PRIVATE-PAYLOAD" } } });
    ok((await (await h.call("GET", "/workspaces/acme/audit", { cookie: ADM })).text()).includes("PRIVATE-PAYLOAD"));

    // Plane deletes acme and someone creates a new workspace with the same slug.
    h.plane.workspaceIds.acme = "ws-id-new-acme";
    for (const path of ["/audit", "/mappings", "/github/connection", "/user-links"]) {
      const response = await h.call("GET", `/workspaces/acme${path}`, { cookie: ADM });
      strictEqual(response.status, 409, path);
      ok(!(await response.text()).includes("PRIVATE-PAYLOAD"), path);
    }
    strictEqual((await h.call("GET", "/workspaces/acme/github/account", { cookie: MEM })).status, 409, "member routes are bound too");

    // The purge is refused while the slug still belongs to the data's owner, and for non-admins.
    strictEqual((await h.call("DELETE", "/instance/workspaces/acme/stale-data", { cookie: ADM })).status, 401);
    const purged = await h.call("DELETE", "/instance/workspaces/acme/stale-data", { cookie: INST });
    strictEqual(purged.status, 204);
    deepStrictEqual((await h.db.query("SELECT 1 FROM repo_mappings UNION ALL SELECT 1 FROM workspace_installations")).rows, []);
    strictEqual((await h.db.query("SELECT 1 FROM audit_log WHERE detail::text LIKE '%PRIVATE-PAYLOAD%'")).rows.length, 0);

    // The new workspace then starts clean under the same slug.
    const fresh = await h.call("GET", "/workspaces/acme/mappings", { cookie: ADM });
    strictEqual(fresh.status, 200);
    ok(!(await (await h.call("GET", "/workspaces/acme/audit", { cookie: ADM })).text()).includes("PRIVATE-PAYLOAD"));
    strictEqual((await h.db.query<{ plane_workspace_id: string }>("SELECT plane_workspace_id FROM workspace_identity WHERE workspace_slug = 'acme'")).rows[0]!.plane_workspace_id, "ws-id-new-acme");
  } finally { await h.close(); }
});

test("S2: the purge is refused while the slug still belongs to the workspace that owns the data", async () => {
  const h = await setup();
  try {
    strictEqual((await h.call("GET", "/workspaces/acme/mappings", { cookie: ADM })).status, 200);
    h.plane.state.instanceWorkspaces = [{ id: "ws-id-acme", slug: "acme", name: "Acme" }];
    strictEqual((await h.call("DELETE", "/instance/workspaces/acme/stale-data", { cookie: INST })).status, 409);
    strictEqual((await h.db.query("SELECT 1 FROM workspace_identity WHERE workspace_slug = 'acme'")).rows.length, 1);
    strictEqual((await h.call("DELETE", "/instance/workspaces/never-seen/stale-data", { cookie: INST })).status, 404);
  } finally { await h.close(); }
});
