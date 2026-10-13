import test from "node:test";
import { deepStrictEqual, match, rejects, strictEqual } from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { encryptSecret, SecretString } from "../../src/auth/identity.ts";
import { migrate } from "../../src/db/migrate.ts";
import { composeRoutes } from "../../src/app/main.ts";
import { createCredentialSource } from "../../src/app/credentials.ts";
import { installationFor } from "../../src/app/context.ts";
import { assertInstallationAllowed, createOutboundAuthoriser, disabledMappings, mappingsForProject, mappingsForRepo, rememberInstallation } from "../../src/app/mappings.ts";
import { createOrderedOutbox, deliveryScope } from "../../src/app/writers.ts";
import { intentJob, queue } from "../writers/outbox-fixture.ts";
import { createMappingVerifier, installationWorkspaceFromDb } from "../../src/ui/mapping-check.ts";
import { PlaneClient } from "../../src/sync/plane.ts";
import { startServer } from "../../src/index.ts";
import { ADM, INST, KEY, ORIGIN, startFakePlane } from "../ui/harness.ts";
import { GITHUB_OAUTH_CONFIG, linkGithubUser, withGithubListing } from "../ui/linked-github.ts";

test("round 5 CD installation authority and composed health", async (t) => {
  const db = new PGlite(); await db.waitReady; await migrate(db);
  const fake = await startFakePlane();
  const dir = await mkdtemp(join(tmpdir(), "gitsync-r5-cd-"));
  const keyPath = join(dir, "app.pem"); await writeFile(keyPath, "bootstrap-key");
  const config: any = { PLANE_WEBHOOK_SECRET: "p", PLANE_BASE_URL: fake.url, PUBLIC_ORIGIN: ORIGIN,
    GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY_PATH: keyPath, GITHUB_WEBHOOK_SECRET: "bootstrap",
    GITHUB_CREDENTIAL_MARKER_PATH: join(dir, "retired"), ...GITHUB_OAUTH_CONFIG };
  const credentials = createCredentialSource(db, KEY, config, 0, join(dir, "retired"));
  const planeClient = new PlaneClient({ baseUrl: fake.url, token: new SecretString("svc"),
    fetch: (async () => new Response("{}", { status: 200 })) as typeof fetch, maxRetries: 0 });
  let installation = 123;
  let onRepoRead = async () => {};
  const ghClient = {
    installationIdFor: async () => installation,
    installationOctokit: async () => ({ request: async () => { await onRepoRead(); return { data: { id: 555, full_name: "acme/web" } }; } }),
  };
  const ctx: any = { db, ghClient };
  const srv = await startServer({ port: 0, host: "127.0.0.1", routes: composeRoutes({
    config, db, tokenKey: KEY, ctx, planeClient, ghClient, credentials, enqueue: async () => {},
  }) });
  const call = (method: string, path: string, cookie = INST, body?: unknown) => fetch(`http://127.0.0.1:${srv.port}/git-sync/api${path}`, {
    method, headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  try {
    await db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (123, 'acme'), (456, 'elsewhere')");
    const inserted = await db.query<{ id: number }>(`INSERT INTO repo_mappings
      (workspace_slug, gh_repo_id, gh_repo_full_name, plane_project_id, sync_direction)
      VALUES ('acme', 555, 'acme/web', 'p1', 'bidirectional') RETURNING id`);
    const mappingId = Number(inserted.rows[0]!.id);

    await t.test("F3: unresolved first-use mappings fail closed and resolved authority cannot cross workspaces", async () => {
      deepStrictEqual(await mappingsForRepo(db, 555), []);
      deepStrictEqual(await mappingsForProject(db, "p1", "acme"), []);
      await rejects(() => rememberInstallation(db, mappingId, 456), /not allowed/);
      strictEqual((await db.query<{ installation_id: number | null }>("SELECT installation_id FROM repo_mappings WHERE id = $1", [mappingId])).rows[0]!.installation_id, null);
      const verifier = createMappingVerifier({ plane: planeClient, github: ghClient, installationWorkspace: installationWorkspaceFromDb(db) });
      const verified: number[] = [];
      const recordVerified = (id: number) => { verified.push(id); };
      installation = 456;
      strictEqual(typeof await verifier({ slug: "acme", repo: { id: 555, fullName: "acme/web" }, onInstallationVerified: recordVerified }), "string");
      deepStrictEqual(verified, []);
      installation = 123;
      onRepoRead = async () => { await db.query("DELETE FROM workspace_installations WHERE installation_id = 123"); };
      strictEqual(typeof await verifier({ slug: "acme", repo: { id: 555, fullName: "acme/web" }, onInstallationVerified: recordVerified }), "string");
      deepStrictEqual(verified, []);
      onRepoRead = async () => {};
      await db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (123, 'acme')");
      strictEqual(await verifier({ slug: "acme", repo: { id: 555, fullName: "acme/web" }, onInstallationVerified: recordVerified }), null);
      deepStrictEqual(verified, [123]);
      await rememberInstallation(db, mappingId, 123);
      const mapping = (await mappingsForRepo(db, 555))[0]!;
      // G14 resolves current installation access; make the API agree with this replacement delivery.
      installation = 456;
      await rejects(() => installationFor(ctx, mapping, { installation: { id: 456 } }), /not allowed/);
      strictEqual(mapping.installationId, 123);
      installation = 123;
    });

    await t.test("F3: the composed admin inventory exposes unresolved and revoked mappings only to instance admins", async () => {
      strictEqual((await call("GET", "/instance/disabled-mappings", ADM)).status, 401);
      await db.query("UPDATE repo_mappings SET installation_id = NULL WHERE id = $1", [mappingId]);
      const unresolved = await call("GET", "/instance/disabled-mappings");
      strictEqual(unresolved.status, 200);
      strictEqual((await unresolved.json())[0].reason, "unresolved");
      await rememberInstallation(db, mappingId, 123);
      await db.query("UPDATE workspace_installations SET workspace_slug = 'elsewhere' WHERE installation_id = 123");
      strictEqual((await disabledMappings(db))[0]!.reason, "installation_not_allowed");
      await rejects(() => assertInstallationAllowed(db, 123, "acme"), /not allowed/);
      deepStrictEqual(await mappingsForRepo(db, 555), []);
      await db.query("UPDATE workspace_installations SET workspace_slug = 'acme' WHERE installation_id = 123");
      await assertInstallationAllowed(db, 123, "acme");
      deepStrictEqual(await disabledMappings(db), []);
    });

    await t.test("F10: composed health reports retired database credentials after the authoritative row disappears", async () => {
      await db.query(`INSERT INTO github_app_config (id, app_id, private_key_v1, webhook_secret_v1)
        VALUES (1, 1, $1, $2)`, [encryptSecret("stored-key", KEY), encryptSecret("stored-secret", KEY)]);
      strictEqual(await credentials.webhookSecret(), "stored-secret");
      await db.query("DELETE FROM github_app_config WHERE id = 1");
      await rejects(() => credentials.webhookSecret());
      const response = await call("GET", "/instance/health");
      strictEqual(response.status, 200);
      deepStrictEqual((await response.json()).githubAppCredentials, { source: "database", decryptOk: false });
    });

    await t.test("F3: composed mapping writes persist verified installations and reverify settings-only saves", async () => {
      const input = { ghRepoId: 555, ghRepoFullName: "acme/web", planeProjectId: "p2" };
      installation = 123;
      // Parity C3: a create re-checks the admin's own GitHub listing first; the admin is linked and sees acme/web.
      await linkGithubUser(db, KEY, "u-adm");
      const created = await withGithubListing({ 123: [{ id: 555, full_name: "acme/web" }] }, () => call("POST", "/workspaces/acme/mappings", ADM, input));
      strictEqual(created.status, 201);
      const id = (await created.json()).id;
      const saved = await db.query<{ installation_id: string | number }>("SELECT installation_id FROM repo_mappings WHERE id = $1", [id]);
      strictEqual(Number(saved.rows[0]!.installation_id), 123);
      await db.query("UPDATE repo_mappings SET installation_id = NULL WHERE id = $1", [mappingId]);
      strictEqual((await call("PATCH", `/workspaces/acme/mappings/${mappingId}`, ADM, { linkbackComments: true })).status, 200);
      strictEqual((await mappingsForRepo(db, 555)).length, 2);
      installation = 456;
      strictEqual((await call("PATCH", `/workspaces/acme/mappings/${mappingId}`, ADM, { linkbackComments: false })).status, 422);
      const unchanged = await db.query<{ linkback_enabled: boolean }>("SELECT linkback_enabled FROM repo_mappings WHERE id = $1", [mappingId]);
      strictEqual(unchanged.rows[0]!.linkback_enabled, true);
      installation = 123;
    });

    await t.test("F3: already queued writes and explicit retries cannot execute after installation revocation", async () => {
      const writes: string[] = [];
      const authoriseWrite = createOutboundAuthoriser(db);
      const outbox = createOrderedOutbox({ db, authoriseWrite,
        plane: { preflight: async () => {}, apply: async () => { writes.push("plane"); return { ok: true }; } },
        github: { apply: async () => { writes.push("github"); return { ok: true }; } },
        queues: { plane: queue(), github: queue() }, loadActorToken: async () => null,
      });
      const create = { kind: "create_issue" as const, installationId: 123, owner: "acme", repo: "web", repoId: 555, title: "private Plane content", body: "sensitive" };
      await deliveryScope.run({ deliveryId: "plane-revoked", workspaceSlug: "acme" }, () => outbox.github.apply(create));
      const githubJob = await intentJob(db);
      await deliveryScope.run({ deliveryId: "github-revoked", workspaceSlug: "acme" }, () => outbox.plane.apply({ kind: "add_comment", slug: "acme", projectId: "p1", issueId: "i1", commentHtml: "private GitHub content" }));
      const planeJob = await intentJob(db);
      await deliveryScope.run({ deliveryId: "github-cross-project", workspaceSlug: "acme" }, () => outbox.plane.plan!("cross-project-authority", [
        // A cross-project create names its target in its own sync-link step ({ID}-NEW); audit S1 refuses an unnamed, unmapped project.
        { kind: "write", side: "plane", bind: "created", write: { kind: "create_issue", slug: "acme", projectId: "other-project", fields: { name: "from authorized repo" } } },
        { kind: "sync_link", link: { planeWorkspaceSlug: "acme", planeProjectId: "other-project", planeIssueId: { $result: "created.id" }, ghRepoId: 555, ghNumber: 9, ghKind: "pr", tier: "closing", createdBy: "magic_word" } },
        { kind: "write", side: "github", write: { kind: "comment", installationId: 123, owner: "acme", repo: "web", repoId: 555, number: 9, body: "created" } },
      ]));
      const workflow = await db.query<{ write: unknown }>("SELECT write FROM outbound_writes WHERE write->'_plan'->>'root' IS NOT NULL AND side = 'plane' ORDER BY sequence DESC LIMIT 1");
      await authoriseWrite("plane", workflow.rows[0]!.write, "acme");
      const sha = "a".repeat(40);
      await db.query("INSERT INTO processed_commits (sha, repo_id, workspace_slug) VALUES ($1, 555, 'acme')", [sha]);
      const smartCommit = { kind: "add_comment", slug: "acme", projectId: "other-project", issueId: "other-issue", commentHtml: "command", _smartCommit: { sha } };
      await authoriseWrite("plane", smartCommit, "acme");
      await db.query("DELETE FROM workspace_installations WHERE installation_id = 123");
      await rejects(() => outbox.executeGithub(githubJob));
      await rejects(() => outbox.executePlane(planeJob));
      deepStrictEqual(writes, []);
      const failed = await db.query<{ status: string }>("SELECT status FROM outbound_writes WHERE id = $1", [githubJob.id]);
      strictEqual(failed.rows[0]!.status, "failed");
      await rejects(() => authoriseWrite("plane", workflow.rows[0]!.write, "acme"), /not allowed|revoked/);
      await rejects(() => authoriseWrite("plane", smartCommit, "acme"), /not allowed|revoked/);
      // A manual reset may either refuse immediately or requeue; dispatch must always recheck authority.
      try { await outbox.retryFailed(githubJob.id, "acme"); } catch (error) { match(String(error), /not allowed|revoked/); }
      await rejects(() => outbox.executeGithub(githubJob));
      deepStrictEqual(writes, []);
      await db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (123, 'elsewhere')");
      await rejects(() => authoriseWrite("github", create, "acme"), /not allowed|revoked/);
      await rejects(() => authoriseWrite("github", create, undefined), /revoked/);
      await db.query("UPDATE workspace_installations SET workspace_slug = 'acme' WHERE installation_id = 123");
      await authoriseWrite("github", create, "acme");
      await authoriseWrite("plane", { kind: "create_issue", slug: "acme", projectId: "p1", fields: {} }, "acme");
      strictEqual((await outbox.retryFailed(githubJob.id, "acme")).retried, true);
      await outbox.executeGithub(githubJob);
      deepStrictEqual(writes, ["github"]);
    });
  } finally { await srv.close(); await fake.close(); await db.close(); await rm(dir, { recursive: true, force: true }); }
});
