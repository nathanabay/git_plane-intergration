import test from "node:test";
import { strictEqual, ok, deepStrictEqual, rejects } from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../../src/db/migrate.ts";
import {
  readGithubAppClient, saveGithubAppClient,
  hashStateNonce, createOAuthState, consumeOAuthState, pruneOAuthStates,
  getGithubOAuthToken, putGithubOAuthToken, markGithubOAuthNeedsReauth, deleteGithubOAuthToken, withGithubOAuthRefreshLock,
  readMappingParity, updateMappingParity, isValidBranchTemplate,
  readRequireVerifiedCommits, writeRequireVerifiedCommits,
} from "../../src/db/parity.ts";
import { PgTokenStore } from "../../src/db/token-store.ts";

async function fresh() { const db = new PGlite(); await db.waitReady; await migrate(db); return db; }
const appRow = (db: PGlite, base: string | null = null) =>
  db.query("INSERT INTO github_app_config (id, app_id, private_key_v1, webhook_secret_v1, ghe_base_url) VALUES (1, 42, 'k', 'h', $1)", [base]);
const mapping = async (db: PGlite) => (await db.query<{ id: number }>(
  `INSERT INTO repo_mappings (workspace_slug, gh_repo_id, gh_repo_full_name, plane_project_id, sync_direction)
   VALUES ('acme', 1, 'o/r', 'p1', 'bidirectional') RETURNING id`)).rows[0]!.id;

// ---- migration upgrade --------------------------------------------------------------------------------------

test("parity-g4: 010 upgrades existing rows; ghe_base_url becomes an edition", async () => {
  const all = readdirSync("src/db/migrations").filter((f) => f.endsWith(".sql")).sort();
  ok(all.some((f) => f.startsWith("010-")), "migration 010 exists");
  const old = all.filter((f) => !f.startsWith("010-") && f < "010-");
  for (const [base, edition, sub] of [
    [null, "github", null],
    ["https://api.octocorp.ghe.com", "ghe_cloud", "octocorp"],
    ["https://API.Octo-Corp.ghe.com/", "ghe_cloud", "octo-corp"],
    ["https://ghes.example.com/api/v3", "ghes", null],
  ] as const) {
    const db = new PGlite(); await db.waitReady;
    const dir = mkdtempSync(join(tmpdir(), "mig010-"));
    try {
      for (const f of old) writeFileSync(join(dir, f), readFileSync(join("src/db/migrations", f)));
      await migrate(db, { dir });
      await appRow(db, base);
      await mapping(db);
      await db.query("INSERT INTO user_tokens VALUES ('u1', 'github_oauth', 'old-blob')");
      await db.query("INSERT INTO instance_settings (id) VALUES (1)");
      // Security S2 added 011-workspace-identity.sql after 010, so a pre-010 database applies 010 and every later file.
      deepStrictEqual((await migrate(db)).applied, all.filter((f) => f >= "010-"));
      const cfg = await readGithubAppClient(db);
      strictEqual(cfg?.edition, edition, String(base));
      strictEqual(cfg?.gheSubdomain, sub, String(base));
      const t = await getGithubOAuthToken(db, "u1");
      strictEqual(t?.accessCiphertext, "old-blob");
      strictEqual(t?.refreshCiphertext, null);
      strictEqual(t?.needsReauth, false);
      const m = await readMappingParity(db, 1);
      deepStrictEqual(m, { openStateId: null, closedStateId: null, reportProblems: false, branchTemplate: null });
      strictEqual(await readRequireVerifiedCommits(db, true), true, "unset follows the env default");
    } finally { rmSync(dir, { recursive: true, force: true }); await db.close(); }
  }
});

// ---- github_app_config -------------------------------------------------------------------------------------

test("parity-g4: App client fields save, keep the secret when omitted, and enforce the edition rules", async () => {
  const db = await fresh();
  strictEqual(await saveGithubAppClient(db, { clientId: "Iv1.x" }), false, "no App row yet");
  strictEqual(await readGithubAppClient(db), null);
  await appRow(db);
  ok(await saveGithubAppClient(db, { clientId: "Iv1.abc", clientSecretCiphertext: "v1:s", appSlug: "git-sync" }));
  ok(await saveGithubAppClient(db, { appSlug: "git-sync-2" }));
  const cfg = await readGithubAppClient(db);
  strictEqual(cfg?.clientId, "Iv1.abc");
  strictEqual(cfg?.clientSecretCiphertext, "v1:s", "secret kept when not resent");
  strictEqual(cfg?.appSlug, "git-sync-2");
  strictEqual(cfg?.edition, "github");
  await rejects(saveGithubAppClient(db, { edition: "ghe_cloud" }), "ghe_cloud needs a subdomain");
  await rejects(saveGithubAppClient(db, { edition: "gitlab" as any }));
  await rejects(saveGithubAppClient(db, { edition: "ghe_cloud", gheSubdomain: "Bad.Sub" }));
  ok(await saveGithubAppClient(db, { edition: "ghe_cloud", gheSubdomain: "octocorp" }));
  strictEqual((await readGithubAppClient(db))?.gheSubdomain, "octocorp");
  strictEqual((await db.query("SELECT 1 FROM github_credential_state WHERE db_row_seen")).rows.length, 1, "008 trigger still fires");
  await db.close();
});

// ---- oauth_states ------------------------------------------------------------------------------------------

test("parity-g4: a state is single use, purpose bound, and only its hash is stored", async () => {
  const db = await fresh();
  await createOAuthState(db, { nonce: "n-1", purpose: "oauth", workspaceSlug: "acme", planeUserId: "u1", ttlSeconds: 600, pkceVerifierCiphertext: "v1:pkce", installationId: 77 });
  const stored = (await db.query<{ nonce_hash: string }>("SELECT nonce_hash FROM oauth_states")).rows;
  deepStrictEqual(stored.map((r) => r.nonce_hash), [hashStateNonce("n-1")]);
  ok(!JSON.stringify(stored).includes("n-1"));
  strictEqual(await consumeOAuthState(db, "n-1", "install"), null, "wrong purpose refused");
  const s = await consumeOAuthState(db, "n-1", "oauth");
  strictEqual(s?.workspaceSlug, "acme");
  strictEqual(s?.planeUserId, "u1");
  strictEqual(s?.pkceVerifierCiphertext, "v1:pkce");
  strictEqual(s?.installationId, 77);
  strictEqual(await consumeOAuthState(db, "n-1", "oauth"), null, "replay refused");
  strictEqual(await consumeOAuthState(db, "unknown", "oauth"), null);
  await db.close();
});

test("parity-g4: an expired state is refused; oauth needs a PKCE verifier; prune removes old rows", async () => {
  const db = await fresh();
  await createOAuthState(db, { nonce: "old", purpose: "install", workspaceSlug: "acme", planeUserId: "u1", ttlSeconds: 60 });
  await db.query("UPDATE oauth_states SET created_at = NOW() - INTERVAL '2 hours', expires_at = NOW() - INTERVAL '1 hour'");
  strictEqual(await consumeOAuthState(db, "old", "install"), null, "expired refused");
  await rejects(createOAuthState(db, { nonce: "x", purpose: "oauth", workspaceSlug: "acme", planeUserId: "u1", ttlSeconds: 60 }));
  await rejects(createOAuthState(db, { nonce: "y", purpose: "install", workspaceSlug: "acme", planeUserId: "u1", ttlSeconds: 0 }));
  await createOAuthState(db, { nonce: "live", purpose: "install", workspaceSlug: "acme", planeUserId: "u1", ttlSeconds: 600 });
  strictEqual(await pruneOAuthStates(db, 60), 1);
  ok(await consumeOAuthState(db, "live", "install"), "live state survives the prune");
  await db.close();
});

test("parity-g4: concurrent consumers of one state: exactly one wins", async () => {
  const db = await fresh();
  await createOAuthState(db, { nonce: "race", purpose: "install", workspaceSlug: "acme", planeUserId: "u1", ttlSeconds: 600 });
  const got = await Promise.all([1, 2, 3, 4].map(() => consumeOAuthState(db, "race", "install")));
  strictEqual(got.filter(Boolean).length, 1);
  await db.close();
});

// ---- user_tokens (github_oauth) ----------------------------------------------------------------------------

test("parity-g4: GitHub tokens store, rotate, flag re-auth, and disconnect leaves the Plane token", async () => {
  const db = await fresh();
  const store = new PgTokenStore(db);
  await store.put("u1", "plane_pat", "v1:pat");
  const exp = new Date(Date.now() + 8 * 3600_000);
  const rexp = new Date(Date.now() + 15897600_000);
  await putGithubOAuthToken(db, "u1", { accessCiphertext: "v1:a1", refreshCiphertext: "v1:r1", accessExpiresAt: exp, refreshExpiresAt: rexp });
  let t = await getGithubOAuthToken(db, "u1");
  strictEqual(t?.accessCiphertext, "v1:a1");
  strictEqual(t?.refreshCiphertext, "v1:r1");
  strictEqual(t?.accessExpiresAt?.getTime(), exp.getTime());
  strictEqual(t?.refreshExpiresAt?.getTime(), rexp.getTime());
  strictEqual(await store.get("u1", "github_oauth"), "v1:a1", "existing TokenVault path reads the access token");
  ok(await markGithubOAuthNeedsReauth(db, "u1"));
  strictEqual((await getGithubOAuthToken(db, "u1"))?.needsReauth, true);
  strictEqual(await markGithubOAuthNeedsReauth(db, "nobody"), false);
  await putGithubOAuthToken(db, "u1", { accessCiphertext: "v1:a2", refreshCiphertext: null, accessExpiresAt: null, refreshExpiresAt: null });
  t = await getGithubOAuthToken(db, "u1");
  strictEqual(t?.needsReauth, false, "a new token clears the flag");
  strictEqual(t?.refreshCiphertext, null, "expiration disabled: no refresh token");
  ok(await deleteGithubOAuthToken(db, "u1"));
  strictEqual(await getGithubOAuthToken(db, "u1"), null);
  strictEqual(await store.get("u1", "plane_pat"), "v1:pat", "Plane token untouched");
  strictEqual(await deleteGithubOAuthToken(db, "u1"), false);
  await db.close();
});

test("parity-g4: refresh lock serializes refreshes; the waiter sees the winner's rotation", async () => {
  const db = await fresh();
  await putGithubOAuthToken(db, "u1", { accessCiphertext: "v1:a0", refreshCiphertext: "v1:r0", accessExpiresAt: new Date(Date.now() - 1000), refreshExpiresAt: null });
  let refreshes = 0;
  const refresh = () => withGithubOAuthRefreshLock(db, "u1", async (conn, current) => {
    if (current && current.accessExpiresAt && current.accessExpiresAt.getTime() > Date.now()) return current.accessCiphertext;
    refreshes++;
    await new Promise((r) => setTimeout(r, 20));
    await putGithubOAuthToken(conn, "u1", { accessCiphertext: `v1:a${refreshes}`, refreshCiphertext: `v1:r${refreshes}`, accessExpiresAt: new Date(Date.now() + 3600_000), refreshExpiresAt: null });
    return `v1:a${refreshes}`;
  });
  const results = await Promise.all([refresh(), refresh(), refresh()]);
  strictEqual(refreshes, 1, "single-flight");
  deepStrictEqual(results, ["v1:a1", "v1:a1", "v1:a1"]);
  await rejects(withGithubOAuthRefreshLock(db, "u1", async (conn) => {
    await putGithubOAuthToken(conn, "u1", { accessCiphertext: "v1:lost", refreshCiphertext: null, accessExpiresAt: null, refreshExpiresAt: null });
    throw new Error("refresh failed");
  }));
  strictEqual((await getGithubOAuthToken(db, "u1"))?.accessCiphertext, "v1:a1", "a failed refresh rolls back");
  strictEqual(await withGithubOAuthRefreshLock(db, "nobody", async (_c, cur) => cur), null);
  await db.close();
});

// ---- repo_mappings -----------------------------------------------------------------------------------------

test("parity-g4: mapping states, report_problems and branch template", async () => {
  const db = await fresh();
  const id = await mapping(db);
  ok(await updateMappingParity(db, id, { openStateId: "s-open", closedStateId: "s-done", reportProblems: true, branchTemplate: "{key}-{title-slug}" }));
  deepStrictEqual(await readMappingParity(db, id), { openStateId: "s-open", closedStateId: "s-done", reportProblems: true, branchTemplate: "{key}-{title-slug}" });
  ok(await updateMappingParity(db, id, { closedStateId: null }));
  strictEqual((await readMappingParity(db, id))?.closedStateId, null, "null clears, others kept");
  strictEqual((await readMappingParity(db, id))?.openStateId, "s-open");
  await rejects(updateMappingParity(db, id, { closedStateId: "s-open" }), "open and closed must differ");
  await rejects(updateMappingParity(db, id, { branchTemplate: "feature-{title-slug}" }), "template needs {key}");
  strictEqual(isValidBranchTemplate("{key}"), true);
  strictEqual(isValidBranchTemplate("{title-slug}"), false);
  strictEqual(await updateMappingParity(db, 9999, { reportProblems: true }), false);
  strictEqual(await readMappingParity(db, 9999), null);
  await db.close();
});

// ---- instance_settings -------------------------------------------------------------------------------------

test("parity-g4: require_verified_commits overrides the env default; null restores it", async () => {
  const db = await fresh();
  strictEqual(await readRequireVerifiedCommits(db, false), false, "no settings row: env default");
  await writeRequireVerifiedCommits(db, true);
  strictEqual(await readRequireVerifiedCommits(db, false), true);
  await writeRequireVerifiedCommits(db, false);
  strictEqual(await readRequireVerifiedCommits(db, true), false, "an explicit false beats env true");
  await writeRequireVerifiedCommits(db, null);
  strictEqual(await readRequireVerifiedCommits(db, true), true);
  const s = (await db.query<any>("SELECT smart_commits_default, op_ttl_minutes FROM instance_settings WHERE id = 1")).rows[0];
  strictEqual(s.smart_commits_default, true, "upsert keeps other defaults");
  await db.close();
});
