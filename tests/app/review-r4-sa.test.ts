// Round-4 fixes F1, F5 (implementer SA): the installation allow-list through composeRoutes and runtime lookups.
import test from "node:test";
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { SecretString } from "../../src/auth/identity.ts";
import { composeRoutes } from "../../src/app/main.ts";
import { mappingsForProject, mappingsForRepo } from "../../src/app/mappings.ts";
import { startServer } from "../../src/index.ts";
import { migrate } from "../../src/db/migrate.ts";
import { PlaneClient } from "../../src/sync/plane.ts";
import { ADM, KEY, ORIGIN, startFakePlane } from "../ui/harness.ts";

test("F1: composeRoutes accepts an allow-listed installation, refuses an unlisted one and another workspace's", async () => {
  const db = new PGlite(); await db.waitReady; await migrate(db);
  const plane = await startFakePlane();
  const planeClient = new PlaneClient({ baseUrl: plane.url, token: new SecretString("svc"), fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch, sleep: async () => {}, maxRetries: 0 });
  const installs: Record<string, number> = { "acme/web": 123, "acme/other": 456, "acme/theirs": 789 };
  const ghClient = {
    installationOctokit: async () => ({ request: async (_r: string, p: any) => ({ data: { id: p.repo === "web" ? 555 : p.repo === "other" ? 556 : 557, full_name: `${p.owner}/${p.repo}` } }) }),
    installationIdFor: async (o: string, r: string) => installs[`${o}/${r}`]!,
  };
  const credentials = { load: async () => { throw new Error("unused"); }, webhookSecret: async () => "s", describe: async () => ({ source: "environment" as const, decryptOk: true }) };
  const config: any = { PLANE_WEBHOOK_SECRET: "p", PLANE_BASE_URL: plane.url, PUBLIC_ORIGIN: ORIGIN };
  const routes = composeRoutes({ config, db, tokenKey: KEY, ctx: { db } as any, planeClient, ghClient, credentials, enqueue: async () => {} });
  const srv = await startServer({ port: 0, host: "127.0.0.1", routes });
  try {
    await db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (123, 'acme'), (789, 'elsewhere')");
    const post = (ghRepoId: number, name: string, project: string) => fetch(`http://127.0.0.1:${srv.port}/git-sync/api/workspaces/acme/mappings`, {
      method: "POST", headers: { cookie: ADM, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ ghRepoId, ghRepoFullName: name, planeProjectId: project, syncDirection: "bidirectional", smartCommitsEnabled: true, linkbackComments: true }),
    });
    strictEqual((await post(555, "acme/web", "p1")).status, 201);
    strictEqual((await post(556, "acme/other", "p2")).status, 422); // installation 456 is not allow-listed
    strictEqual((await post(557, "acme/theirs", "p3")).status, 422); // installation 789 belongs to another workspace
  } finally { await srv.close(); await plane.close(); await db.close(); }
});

test("F5: de-listing or moving an installation stops runtime mapping lookups, and each miss is audited", async () => {
  const db = new PGlite(); await db.waitReady; await migrate(db);
  try {
    await db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (1, 'ws')");
    await db.query(`INSERT INTO repo_mappings (workspace_slug, gh_repo_id, gh_repo_full_name, plane_project_id, sync_direction, installation_id)
                    VALUES ('ws', 555, 'acme/web', 'p1', 'bidirectional', 1), ('other', 555, 'acme/web', 'p9', 'bidirectional', 1)`);
    // the 'other' workspace's mapping uses installation 1, which is allow-listed for 'ws' only
    deepStrictEqual((await mappingsForRepo(db, 555)).map((m) => m.workspaceSlug), ["ws"]);
    deepStrictEqual((await mappingsForProject(db, "p9")).length, 0);
    strictEqual((await db.query("SELECT 1 FROM audit_log WHERE kind = 'installation_not_allowed' AND workspace_slug = 'other'")).rows.length, 2);

    await db.query("DELETE FROM workspace_installations WHERE installation_id = 1");
    deepStrictEqual(await mappingsForRepo(db, 555), []);
    deepStrictEqual(await mappingsForProject(db, "p1", "ws"), []);
  } finally { await db.close(); }
});
