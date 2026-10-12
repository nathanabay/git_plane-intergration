import test from "node:test";
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import type { Db } from "../../src/db/migrate.ts";
import { migrate } from "../../src/db/migrate.ts";
import { createDb } from "../../src/db/client.ts";
import { startPostgres } from "../../scripts/lib/postgres.mjs";
import type { AppContext } from "../../src/app/context.ts";
import { actorTokenFor } from "../../src/app/context.ts";
import type { Mapping } from "../../src/app/mappings.ts";
import { ensureLinkedByEmail, resetEmailLinkAttempts } from "../../src/app/identity.ts";
import { createCredentialSource } from "../../src/app/credentials.ts";
import { encryptSecret } from "../../src/auth/identity.ts";
import { DEFAULT_CREDENTIAL_MARKER_PATH } from "../../src/config/env.ts";
import { addUserLinkTombstone, isUserLinkTombstoned, withUserLinkTransaction } from "../../src/db/ledgers.ts";
import { createWebhookRoutes } from "../../src/api/handler.ts";
import { startServer } from "../../src/index.ts";
import { ADM, INST, KEY, MAPPING, setup } from "./harness.ts";

const sender = { id: 41, login: "octo", type: "User" } as const;
const mapping = { workspaceSlug: "acme", installationId: 1 } as Mapping;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};
const turn = () => new Promise<void>((r) => setImmediate(r));

function emailContext(db: Db, listMembers: () => Promise<any[]> = async () => [{ id: "u-1", email: "octo@example.test" }]): AppContext {
  return {
    db,
    ghClient: { installationOctokit: async () => ({ request: async () => ({ data: { id: 41, email: "octo@example.test" } }) }) },
    planeClient: { listAll: listMembers },
  } as unknown as AppContext;
}

const putLink = (h: Awaited<ReturnType<typeof setup>>) => h.call("PUT", "/workspaces/acme/user-links/u-1", {
  cookie: ADM, body: { githubLogin: "octo", githubId: 41 },
});

test("F7: unlink waits for the final suppression check and insert, then removes the account and tokens", async () => {
  resetEmailLinkAttempts();
  const h = await setup([], undefined, undefined, { lookupGithubUser: async () => sender });
  const query = h.db.query.bind(h.db);
  const exec = h.db.exec.bind(h.db);
  const checked = deferred(), release = deferred();
  let checks = 0;
  h.db.query = (async (sql: string, params?: any[]) => {
    const result = await query(sql, params);
    if (sql.startsWith("SELECT 1 FROM user_link_tombstones") && ++checks === 2) {
      strictEqual(result.rows.length, 0);
      checked.resolve(); await release.promise;
    }
    return result;
  }) as typeof h.db.query;
  // Observe when DELETE tries to enter its transaction, before the in-engine fallback lock is taken.
  const ctx = emailContext(h.db);
  try {
    await query("INSERT INTO user_tokens VALUES ('u-1', 'plane_pat', 'encrypted')");
    const auto = ensureLinkedByEmail(ctx, mapping, sender);
    await checked.promise;
    let unlinked = false;
    const deletion = h.call("DELETE", "/workspaces/acme/user-links/u-1", { cookie: ADM }).then((r) => { unlinked = true; return r; });
    // Wait until authorization has finished. The shared lock must still keep DELETE outside BEGIN.
    while (!h.plane.calls.some((c) => c.url.includes("workspace-members"))) await turn();
    await turn(); await turn();
    strictEqual(unlinked, false);
    release.resolve();
    strictEqual(await auto, "u-1");
    strictEqual((await deletion).status, 204);
    strictEqual((await query("SELECT 1 FROM user_map")).rows.length, 0);
    strictEqual((await query("SELECT 1 FROM user_tokens")).rows.length, 0);
    strictEqual(await isUserLinkTombstoned(h.db, "acme", 41), true);
    resetEmailLinkAttempts();
    strictEqual(await ensureLinkedByEmail(ctx, mapping, sender), null);
    strictEqual((await putLink(h)).status, 200);
    strictEqual(await isUserLinkTombstoned(h.db, "acme", 41), false);
  } finally { release.resolve(); h.db.query = query as typeof h.db.query; h.db.exec = exec; await h.close(); }
});

test("F7: auto-link cannot insert while unlink has deleted the map but not written the tombstone", async () => {
  resetEmailLinkAttempts();
  const h = await setup([], undefined, undefined, { lookupGithubUser: async () => sender });
  const query = h.db.query.bind(h.db);
  const lookup = deferred(), finishLookup = deferred(), deleted = deferred(), finishDelete = deferred();
  const ctx = emailContext(h.db, async () => { lookup.resolve(); await finishLookup.promise; return [{ id: "u-1", email: "octo@example.test" }]; });
  try {
    const auto = ensureLinkedByEmail(ctx, mapping, sender);
    await lookup.promise;
    strictEqual((await putLink(h)).status, 200);
    h.db.query = (async (sql: string, params?: any[]) => {
      const result = await query(sql, params);
      if (sql.startsWith("DELETE FROM user_map")) { deleted.resolve(); await finishDelete.promise; }
      return result;
    }) as typeof h.db.query;
    const deletion = h.call("DELETE", "/workspaces/acme/user-links/u-1", { cookie: ADM });
    await deleted.promise;
    let autoFinished = false;
    const completion = auto.then((value) => { autoFinished = true; return value; });
    finishLookup.resolve(); await turn(); await turn();
    strictEqual(autoFinished, false, "final check must wait for the unlink transaction");
    finishDelete.resolve();
    strictEqual((await deletion).status, 204);
    strictEqual(await completion, null);
    strictEqual((await query("SELECT 1 FROM user_map")).rows.length, 0);
    strictEqual(await isUserLinkTombstoned(h.db, "acme", 41), true);
  } finally { finishLookup.resolve(); finishDelete.resolve(); h.db.query = query as typeof h.db.query; await h.close(); }
});

test("F7: unlink rolls back each map, tombstone, token and commit failure", async () => {
  const h = await setup([], undefined, undefined, { lookupGithubUser: async () => sender });
  const query = h.db.query.bind(h.db), exec = h.db.exec.bind(h.db);
  try {
    strictEqual((await putLink(h)).status, 200);
    await query("INSERT INTO user_tokens VALUES ('u-1', 'plane_pat', 'encrypted')");
    for (const failure of ["DELETE FROM user_map", "INSERT INTO user_link_tombstones", "DELETE FROM user_tokens", "COMMIT"]) {
      h.db.query = (async (sql: string, params?: any[]) => {
        if (sql.startsWith(failure)) throw new Error("injected unlink failure");
        return query(sql, params);
      }) as typeof h.db.query;
      h.db.exec = async (sql: string) => { if (sql === failure) throw new Error("injected commit failure"); return exec(sql); };
      strictEqual((await h.call("DELETE", "/workspaces/acme/user-links/u-1", { cookie: ADM })).status, 500);
      strictEqual((await query("SELECT 1 FROM user_map")).rows.length, 1);
      strictEqual((await query("SELECT 1 FROM user_tokens")).rows.length, 1);
      strictEqual((await query("SELECT 1 FROM user_link_tombstones")).rows.length, 0);
    }
  } finally { h.db.query = query as typeof h.db.query; h.db.exec = exec; await h.close(); }
});

test("F7: manual relink rolls back the map when clearing suppression fails", async () => {
  const h = await setup([], undefined, undefined, { lookupGithubUser: async () => sender });
  const query = h.db.query.bind(h.db);
  try {
    await query("INSERT INTO user_link_tombstones VALUES ('acme', 41, now())");
    h.db.query = (async (sql: string, params?: any[]) => {
      if (sql.startsWith("DELETE FROM user_link_tombstones")) throw new Error("injected clear failure");
      return query(sql, params);
    }) as typeof h.db.query;
    strictEqual((await putLink(h)).status, 500);
    strictEqual((await query("SELECT 1 FROM user_map")).rows.length, 0);
    strictEqual((await query("SELECT 1 FROM user_link_tombstones")).rows.length, 1);
  } finally { h.db.query = query as typeof h.db.query; await h.close(); }
});

test("F7: suppression precedes existing rows and suppression-read errors fail closed", async () => {
  resetEmailLinkAttempts();
  const h = await setup();
  const query = h.db.query.bind(h.db);
  let networkCalls = 0;
  const ctx = emailContext(h.db, async () => { networkCalls++; return []; });
  try {
    await query("INSERT INTO user_map (workspace_slug, plane_user_id, gh_login, gh_id) VALUES ('acme', 'u-1', 'octo', 41)");
    await query("INSERT INTO user_tokens VALUES ('u-1', 'plane_pat', 'encrypted')");
    await query("INSERT INTO user_link_tombstones VALUES ('acme', 41, now())");
    strictEqual(await ensureLinkedByEmail(ctx, mapping, sender), null);
    strictEqual((await query("SELECT 1 FROM user_map")).rows.length, 0, "the stale map cannot leak into actor or assignee lookup");
    strictEqual((await query("SELECT 1 FROM user_tokens")).rows.length, 0);
    strictEqual(await actorTokenFor(ctx, mapping, sender, "suppression regression"), undefined);
    h.db.query = (async (sql: string, params?: any[]) => {
      if (sql.startsWith("SELECT 1 FROM user_link_tombstones")) throw new Error("suppression unavailable");
      return query(sql, params);
    }) as typeof h.db.query;
    await rejects(actorTokenFor(ctx, mapping, sender, "authority-error regression"), /User-link authority unavailable/);
    strictEqual(networkCalls, 0);
    const audit = (await query<{ outcome: string; detail: { reason: string } }>("SELECT outcome, detail FROM audit_log WHERE kind = 'identity_email_match' ORDER BY id")).rows;
    deepStrictEqual(audit.map((r) => [r.outcome, r.detail.reason]), [["skipped", "unlinked_by_admin"], ["skipped", "unlinked_by_admin"], ["failed", "lookup_failed"]]);
  } finally { h.db.query = query as typeof h.db.query; await h.close(); }
});

test("F7: production identity transactions use only their leased connection and share the workspace lock", async () => {
  const calls: Array<[string, unknown[] | undefined]> = [];
  const connection: Db = {
    exec: async (sql) => { calls.push([sql, undefined]); },
    query: async (sql, params) => { calls.push([sql, params]); return { rows: [] }; },
  };
  const pool: Db = {
    exec: async () => { throw new Error("transaction escaped to pool"); },
    query: async () => { throw new Error("query escaped to pool"); },
    withConnection: async (fn) => fn(connection),
  };
  strictEqual(await withUserLinkTransaction(pool, "acme", async (conn) => { strictEqual(conn, connection); return 42; }), 42);
  deepStrictEqual(calls.map(([sql]) => sql), ["BEGIN", "INSERT INTO user_link_locks (workspace_slug) VALUES ($1) ON CONFLICT DO NOTHING", "SELECT workspace_slug FROM user_link_locks WHERE workspace_slug = $1 FOR UPDATE", "COMMIT"]);
  deepStrictEqual(calls[2]![1], ["acme"]);
});

const APP = { appId: 42, privateKey: "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----", webhookSecret: "rotated-secret-123456" };
function credentialConfig(dir: string) {
  const secretDir = join(dir, "secrets"), stateDir = join(dir, "credential-state");
  mkdirSync(secretDir); mkdirSync(stateDir);
  const pem = join(secretDir, "github-app.pem");
  writeFileSync(pem, "ENV-PEM");
  chmodSync(pem, 0o444); chmodSync(secretDir, 0o555); chmodSync(stateDir, 0o700);
  return { GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY_PATH: pem, GITHUB_WEBHOOK_SECRET: "retired-env-secret", GITHUB_CREDENTIAL_MARKER_PATH: join(stateDir, "bootstrap-retired") };
}
const unavailable: Db = { query: async () => { throw new Error("database unavailable"); }, exec: async () => { throw new Error("database unavailable"); } };

async function rejectRetiredSignature(source: ReturnType<typeof createCredentialSource>, secret: string) {
  const queued: unknown[] = [];
  const server = await startServer({ port: 0, host: "127.0.0.1", routes: createWebhookRoutes({ planeSecret: "p", githubSecret: source.webhookSecret, enqueue: async (job) => { queued.push(job); } }) });
  try {
    const body = JSON.stringify({ action: "opened" });
    const response = await fetch(`http://127.0.0.1:${server.port}/git-sync/webhooks/github`, {
      method: "POST", body, headers: { "content-type": "application/json", "x-github-event": "issues", "x-github-delivery": "forged", "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` },
    });
    strictEqual(response.status, 503);
    strictEqual(queued.length, 0);
  } finally { await server.close(); }
}

test("F8: production mount supports non-root writes with a read-only secret and survives process recreation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "r5-ce-"));
  const config = credentialConfig(dir);
  try {
    const uid = process.getuid?.() ?? 1000;
    if (uid === 0) for (const path of [dir, join(dir, "secrets"), config.GITHUB_PRIVATE_KEY_PATH, join(dir, "credential-state")]) chownSync(path, 1000, 1000);
    const run = promisify(execFile);
    const script = `
      import { strictEqual, ok, rejects, throws } from 'node:assert/strict';
      import { existsSync, writeFileSync } from 'node:fs';
      import { dirname, join } from 'node:path';
      import { createCredentialSource } from ${JSON.stringify(resolve("src/app/credentials.ts"))};
      import { encryptSecret } from ${JSON.stringify(resolve("src/auth/identity.ts"))};
      const config = ${JSON.stringify(config)};
      const key = Buffer.alloc(32, 7);
      strictEqual(process.getuid() === 0, false);
      throws(() => writeFileSync(join(dirname(config.GITHUB_PRIVATE_KEY_PATH), '.gitsync-db-credentials'), 'x'), /EACCES|EROFS/);
      const db = { query: async (sql) => ({ rows: sql.startsWith('SELECT app_id') ? [{ app_id: 42, private_key_v1: encryptSecret('DB-PEM', key), webhook_secret_v1: encryptSecret('rotated', key) }] : [] }) };
      strictEqual(await createCredentialSource(db, key, config, 0).webhookSecret(), 'rotated');
      ok(existsSync(config.GITHUB_CREDENTIAL_MARKER_PATH));
      const unwritable = createCredentialSource(db, key, { ...config, GITHUB_CREDENTIAL_MARKER_PATH: join(dirname(config.GITHUB_PRIVATE_KEY_PATH), 'cannot-persist') }, 0);
      await rejects(unwritable.webhookSecret(), /EACCES|EROFS/);
      strictEqual((await unwritable.describe()).decryptOk, false);
    `;
    await run(process.execPath, ["--input-type=module", "-e", script], { ...(uid === 0 ? { uid: 1000, gid: 1000 } : {}) });
    ok(existsSync(config.GITHUB_CREDENTIAL_MARKER_PATH));
    const restarted = createCredentialSource(unavailable, KEY, config, 0);
    await rejects(restarted.webhookSecret(), /database unavailable/);
    deepStrictEqual(await restarted.describe(), { source: "database", decryptOk: false });
    await rejectRetiredSignature(restarted, config.GITHUB_WEBHOOK_SECRET);
    // Recreate another process with no cached value, retaining only the bind-mounted state.
    await run(process.execPath, ["--input-type=module", "-e", `
      import { rejects } from 'node:assert/strict';
      import { createCredentialSource } from ${JSON.stringify(resolve("src/app/credentials.ts"))};
      const db = { query: async () => { throw new Error('database unavailable'); } };
      await rejects(createCredentialSource(db, Buffer.alloc(32, 7), ${JSON.stringify(config)}, 0).webhookSecret(), /database unavailable/);
    `], { ...(uid === 0 ? { uid: 1000, gid: 1000 } : {}) });
  } finally { chmodSync(join(dir, "secrets"), 0o755); rmSync(dir, { recursive: true, force: true }); }
});

test("F8: cold outage with no marker rejects old-secret signatures and never queues them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "r5-ce-hook-"));
  const config = credentialConfig(dir);
  const source = createCredentialSource(unavailable, KEY, config, 0);
  try {
    await rejectRetiredSignature(source, config.GITHUB_WEBHOOK_SECRET);
  } finally { chmodSync(join(dir, "secrets"), 0o755); rmSync(dir, { recursive: true, force: true }); }
});

test("F8: bootstrap requires healthy retirement authority; warm database credentials survive outages", async () => {
  const h = await setup();
  const dir = mkdtempSync(join(tmpdir(), "r5-ce-source-"));
  const config = credentialConfig(dir);
  const query = h.db.query.bind(h.db);
  try {
    const source = createCredentialSource(h.db, KEY, config, 0);
    strictEqual(await source.webhookSecret(), config.GITHUB_WEBHOOK_SECRET, "positive bootstrap control");
    h.db.query = unavailable.query as typeof h.db.query;
    await rejects(source.webhookSecret(), /database unavailable/, "a warm environment cache must not authorize outage fallback");
    h.db.query = (async (sql: string, params?: any[]) => {
      if (sql.startsWith("SELECT 1 FROM github_credential_state")) throw new Error("retirement unavailable");
      return query(sql, params);
    }) as typeof h.db.query;
    await rejects(source.webhookSecret(), /retirement unavailable/);
    h.db.query = query as typeof h.db.query;
    await query("INSERT INTO github_app_config VALUES (1, 42, $1, $2, NULL)", [encryptSecret("DB-PEM", KEY), encryptSecret("rotated", KEY)]);
    strictEqual(await source.webhookSecret(), "rotated");
    h.db.query = unavailable.query as typeof h.db.query;
    strictEqual(await source.webhookSecret(), "rotated", "warm process retains only its verified database secret");
  } finally { h.db.query = query as typeof h.db.query; await h.close(); chmodSync(join(dir, "secrets"), 0o755); rmSync(dir, { recursive: true, force: true }); }
});

test("F8: mandatory marker write failure is visible and never restores bootstrap fallback", async () => {
  const h = await setup();
  const dir = mkdtempSync(join(tmpdir(), "r5-ce-failure-"));
  const config = credentialConfig(dir);
  const query = h.db.query.bind(h.db);
  try {
    await query("INSERT INTO github_app_config VALUES (1, 42, $1, $2, NULL)", [encryptSecret("DB-PEM", KEY), encryptSecret("rotated", KEY)]);
    writeFileSync(join(dir, "not-directory"), "x");
    const source = createCredentialSource(h.db, KEY, { ...config, GITHUB_CREDENTIAL_MARKER_PATH: join(dir, "not-directory", "retired") }, 0);
    await rejects(source.webhookSecret(), /ENOTDIR|EEXIST/);
    deepStrictEqual(await source.describe(), { source: "database", decryptOk: false });
    h.db.query = unavailable.query as typeof h.db.query;
    await rejects(source.webhookSecret(), /database unavailable/);
  } finally { h.db.query = query as typeof h.db.query; await h.close(); chmodSync(join(dir, "secrets"), 0o755); rmSync(dir, { recursive: true, force: true }); }
});

test("F8: admin save retires bootstrap before any source read, and state survives config deletion", async () => {
  const h = await setup();
  const dir = mkdtempSync(join(tmpdir(), "r5-ce-save-"));
  const config = credentialConfig(dir);
  try {
    strictEqual((await h.call("PUT", "/instance/github-app", { cookie: INST, body: APP })).status, 200);
    strictEqual((await h.db.query("SELECT 1 FROM github_credential_state WHERE db_row_seen")).rows.length, 1);
    ok(!existsSync(config.GITHUB_CREDENTIAL_MARKER_PATH), "save-before-first-read control");
    await rejects(createCredentialSource(unavailable, KEY, config, 0).webhookSecret());
    await h.db.query("DELETE FROM github_app_config");
    await rejects(createCredentialSource(h.db, KEY, config, 0).webhookSecret(), /row is gone/);
  } finally { await h.close(); chmodSync(join(dir, "secrets"), 0o755); rmSync(dir, { recursive: true, force: true }); }
});

test("F8: compose and runbook provide persistent writable state separately from the read-only PEM", () => {
  const compose = parse(readFileSync("docker-compose.override.yaml", "utf8"));
  const service = compose.services["git-sync"];
  strictEqual(service.environment.GITHUB_CREDENTIAL_MARKER_PATH, DEFAULT_CREDENTIAL_MARKER_PATH);
  ok(service.volumes.includes("./git-sync/github-app.pem:/run/secrets/github-app.pem:ro"));
  ok(service.volumes.includes("./git-sync/credential-state:/var/lib/gitsync/credentials"));
  ok(readFileSync("deploy/APPLY.md", "utf8").includes("install -d -m 700 -o 1000 -g 1000 /root/plane/git-sync/credential-state"));
  ok(readFileSync("deploy/git-sync.env.example", "utf8").includes(`GITHUB_CREDENTIAL_MARKER_PATH=${DEFAULT_CREDENTIAL_MARKER_PATH}`));
});

test("F3 relay: mapping POST and every PATCH verify the effective repository and persist installation authority", async () => {
  const calls: unknown[] = [];
  let verifiedId = 7;
  const h = await setup([], undefined, async (check) => {
    calls.push({ slug: check.slug, planeProjectId: check.planeProjectId, repo: check.repo });
    if (!verifiedId) return "installation revoked";
    check.onInstallationVerified?.(verifiedId);
    return null;
  });
  try {
    const creation = await h.call("POST", "/workspaces/acme/mappings", { cookie: ADM, body: MAPPING });
    strictEqual(creation.status, 201);
    const { id } = await creation.json() as { id: number };
    strictEqual((await h.db.query<{ installation_id: number }>("SELECT installation_id FROM repo_mappings WHERE id = $1", [id])).rows[0]!.installation_id, 7);
    verifiedId = 9;
    for (const body of [{ smartCommitsEnabled: false }, { planeProjectId: "p2" }]) {
      strictEqual((await h.call("PATCH", `/workspaces/acme/mappings/${id}`, { cookie: ADM, body })).status, 200);
    }
    deepStrictEqual(calls, [
      { slug: "acme", planeProjectId: "p1", repo: { id: 555, fullName: "acme/web" } },
      { slug: "acme", planeProjectId: "p1", repo: { id: 555, fullName: "acme/web" } },
      { slug: "acme", planeProjectId: "p2", repo: { id: 555, fullName: "acme/web" } },
    ]);
    strictEqual((await h.db.query<{ installation_id: number }>("SELECT installation_id FROM repo_mappings WHERE id = $1", [id])).rows[0]!.installation_id, 9);
    verifiedId = 0;
    strictEqual((await h.call("PATCH", `/workspaces/acme/mappings/${id}`, { cookie: ADM, body: { autolinks: true } })).status, 422);
    strictEqual((await h.db.query<{ autolinks_enabled: boolean }>("SELECT autolinks_enabled FROM repo_mappings WHERE id = $1", [id])).rows[0]!.autolinks_enabled, false);
  } finally { await h.close(); }
});

test("F3 relay: a verifier returning success without verified installation authority cannot create a NULL mapping", async () => {
  const h = await setup([], undefined, async () => null);
  try {
    strictEqual((await h.call("POST", "/workspaces/acme/mappings", { cookie: ADM, body: MAPPING })).status, 503);
    strictEqual((await h.db.query("SELECT 1 FROM repo_mappings")).rows.length, 0);
  } finally { await h.close(); }
});

test("F8 migration: Postgres 15.7 applies 001-008 fresh and upgrades an existing 001-007 database", async () => {
  const pg = await startPostgres();
  const fresh = createDb(pg.url);
  const oldDir = mkdtempSync(join(tmpdir(), "r5-ce-migrations-"));
  let upgrade: ReturnType<typeof createDb> | undefined;
  try {
    strictEqual((await fresh.query("SHOW server_version_num")).rows[0].server_version_num, "150007");
    const all = readdirSync("src/db/migrations").filter((f) => f.endsWith(".sql")).sort();
    deepStrictEqual((await migrate(fresh)).applied, all);
    ok((await fresh.query("SELECT to_regclass('workspace_installations')::text AS name")).rows[0].name);
    ok((await fresh.query("SELECT to_regclass('user_link_locks')::text AS name")).rows[0].name);
    deepStrictEqual((await migrate(fresh)).applied, []);
    // Real pooled connections exercise the same final-check/insert boundary across replicas.
    const replica = createDb(pg.url);
    const checked = deferred(), resume = deferred();
    try {
      await fresh.query("INSERT INTO user_link_locks VALUES ('acme')");
      const auto = withUserLinkTransaction(fresh, "acme", async (conn) => {
        strictEqual(await isUserLinkTombstoned(conn, "acme", 41), false);
        checked.resolve(); await resume.promise;
        await conn.query("INSERT INTO user_map (workspace_slug, plane_user_id, gh_login, gh_id) VALUES ('acme', 'u-1', 'octo', 41)");
      });
      await checked.promise;
      const unlink = withUserLinkTransaction(replica, "acme", async (conn) => {
        strictEqual((await conn.query("DELETE FROM user_map WHERE workspace_slug = 'acme' AND gh_id = 41 RETURNING id")).rows.length, 1);
        await addUserLinkTombstone(conn, "acme", 41);
      });
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        blocked = Number((await fresh.query("SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%user_link_locks%'")).rows[0].n) > 0;
        if (blocked) break;
        await new Promise<void>((r) => setTimeout(r, 10));
      }
      ok(blocked, "the independent replica must wait on PostgreSQL's workspace row lock");
      resume.resolve(); await auto; await unlink;
      strictEqual((await fresh.query("SELECT 1 FROM user_map")).rows.length, 0);
      strictEqual(await isUserLinkTombstoned(fresh, "acme", 41), true);
    } finally { resume.resolve(); await replica.close(); }
    await fresh.exec("CREATE DATABASE r5_upgrade");
    const upgradeUrl = new URL(pg.url); upgradeUrl.pathname = "/r5_upgrade";
    upgrade = createDb(upgradeUrl.toString());
    const old = all.filter((f) => /^00[1-7]-/.test(f));
    for (const file of old) writeFileSync(join(oldDir, file), readFileSync(join("src/db/migrations", file)));
    deepStrictEqual((await migrate(upgrade, { dir: oldDir })).applied, old);
    await upgrade.query("INSERT INTO github_app_config (id, app_id, private_key_v1, webhook_secret_v1) VALUES (1, 42, 'stored-key', 'stored-hook')");
    strictEqual((await upgrade.query("SELECT 1 FROM github_credential_state")).rows.length, 0);
    await upgrade.query("INSERT INTO workspace_installations VALUES (7, 'acme', 'account', now())");
    await upgrade.query("INSERT INTO user_map (workspace_slug, plane_user_id, gh_login, gh_id) VALUES ('acme', 'u-old', 'octo', 41)");
    await upgrade.query("INSERT INTO user_link_tombstones VALUES ('acme', 41, now())");
    await upgrade.query("INSERT INTO user_tokens VALUES ('u-old', 'plane_pat', 'encrypted')");
    deepStrictEqual((await migrate(upgrade)).applied, all.filter((f) => f.startsWith("008-")));
    strictEqual((await upgrade.query("SELECT 1 FROM github_credential_state WHERE db_row_seen")).rows.length, 1, "upgrade backfills existing credentials");
    strictEqual((await upgrade.query("SELECT 1 FROM workspace_installations WHERE installation_id = 7")).rows.length, 1, "allow-list survives migration");
    strictEqual((await upgrade.query("SELECT 1 FROM user_map")).rows.length, 0, "upgrade removes a map contradicted by suppression");
    strictEqual((await upgrade.query("SELECT 1 FROM user_tokens")).rows.length, 0, "upgrade also revokes its tokens");
    await upgrade.query("DELETE FROM github_app_config");
    strictEqual((await upgrade.query("SELECT 1 FROM github_credential_state WHERE db_row_seen")).rows.length, 1);
    await upgrade.query("DELETE FROM github_credential_state");
    await upgrade.query("INSERT INTO github_app_config (id, app_id, private_key_v1, webhook_secret_v1) VALUES (1, 42, 'new-key', 'new-hook')");
    strictEqual((await upgrade.query("SELECT 1 FROM github_credential_state WHERE db_row_seen")).rows.length, 1, "trigger retires new saves atomically");
    await upgrade.exec("ALTER TABLE github_credential_state ADD CONSTRAINT forced_retirement_failure CHECK (NOT db_row_seen) NOT VALID");
    await rejects(upgrade.query("UPDATE github_app_config SET webhook_secret_v1 = 'failed-rotation' WHERE id = 1"), /forced_retirement_failure/);
    strictEqual((await upgrade.query("SELECT webhook_secret_v1 FROM github_app_config WHERE id = 1")).rows[0].webhook_secret_v1, "new-hook", "retirement failure rolls back the credential rotation");
    deepStrictEqual((await migrate(upgrade)).applied, []);
  } finally { await fresh.close(); await upgrade?.close(); await pg.stop(); rmSync(oldDir, { recursive: true, force: true }); }
});
