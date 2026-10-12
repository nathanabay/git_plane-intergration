// Round-4 fixes F11 (unlink tombstone) and prev F15 (durable credential state), implementer SB.
import test from "node:test";
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptSecret } from "../../src/auth/identity.ts";
import { createCredentialSource } from "../../src/app/credentials.ts";
import { ensureLinkedByEmail, resetEmailLinkAttempts } from "../../src/app/identity.ts";
import { mappingsForProject } from "../../src/app/mappings.ts";
import { addUserLinkTombstone, clearUserLinkTombstone, isUserLinkTombstoned } from "../../src/db/ledgers.ts";
import { migrate } from "../../src/db/migrate.ts";
import { makeHarness } from "../a8/harness.ts";
import { ADM, INST, MEM, setup } from "./harness.ts";

test("F11: unlinking writes a tombstone and a manual link lifts it", async () => {
  const h = await setup([], undefined, undefined, { lookupGithubUser: async (login) => ({ login, id: 41 }) });
  try {
    const put = () => h.call("PUT", "/workspaces/acme/user-links/u-1", { cookie: ADM, body: { githubLogin: "octo", githubId: 41 } });
    strictEqual((await put()).status, 200);
    strictEqual(await isUserLinkTombstoned(h.db, "acme", 41), false);
    strictEqual((await h.call("DELETE", "/workspaces/acme/user-links/u-1", { cookie: ADM })).status, 204);
    strictEqual(await isUserLinkTombstoned(h.db, "acme", 41), true);
    strictEqual(await isUserLinkTombstoned(h.db, "other", 41), false, "a tombstone is per workspace");
    strictEqual((await put()).status, 200);
    strictEqual(await isUserLinkTombstoned(h.db, "acme", 41), false, "an explicit manual link clears it");
  } finally { await h.close(); }
});

async function emailHarness() {
  resetEmailLinkAttempts();
  const h = await makeHarness();
  await h.mapping();
  await h.db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (1, 'ws') ON CONFLICT DO NOTHING"); // mappings are served only for allow-listed installations
  h.gh.respond(/GET \/users\/\{username\}$/, () => ({ id: 1, login: "octo", email: "octo@corp.io" }));
  (h.ctx.planeClient as any).listAll = async () => [{ member: { id: "pu-1", email: "octo@corp.io" } }];
  const mapping = (await mappingsForProject(h.db, "p-qll", "ws"))[0]!;
  return { h, mapping };
}

test("F11: after an unlink the next event does not re-link by email, and the service fallback is audited", async () => {
  const { h, mapping } = await emailHarness();
  try {
    const sender = { login: "octo", id: 1, type: "User" } as const;
    strictEqual(await ensureLinkedByEmail(h.ctx, mapping, sender), "pu-1", "control: without a tombstone the email links");
    await h.db.query("DELETE FROM user_map WHERE gh_id = 1");
    await addUserLinkTombstone(h.db, "ws", 1);
    resetEmailLinkAttempts();
    strictEqual(await ensureLinkedByEmail(h.ctx, mapping, sender), null);
    strictEqual((await h.db.query("SELECT 1 FROM user_map")).rows.length, 0, "no row was re-inserted");
    const row = (await h.audit("identity_email_match")).at(-1)!;
    deepStrictEqual([row.outcome, row.detail.reason], ["skipped", "unlinked_by_admin"]);
    await clearUserLinkTombstone(h.db, "ws", 1);
    resetEmailLinkAttempts();
    strictEqual(await ensureLinkedByEmail(h.ctx, mapping, sender), "pu-1", "lifting the tombstone allows linking again");
  } finally { await h.close(); }
});

async function credentialRig() {
  const db = new PGlite(); await db.waitReady; await migrate(db);
  const key = randomBytes(32);
  const dir = mkdtempSync(join(tmpdir(), "gh-key-"));
  const keyFile = join(dir, "key.pem");
  writeFileSync(keyFile, "PEM-ENV");
  const config = { GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY_PATH: keyFile, GITHUB_WEBHOOK_SECRET: "leaked-env-secret", GITHUB_CREDENTIAL_MARKER_PATH: join(dir, "credential-state", "bootstrap-retired") };
  const storeRow = () => db.query("INSERT INTO github_app_config (id, app_id, private_key_v1, webhook_secret_v1) VALUES (1, 42, $1, $2) ON CONFLICT (id) DO NOTHING", [encryptSecret("PEM-1", key), encryptSecret("rotated", key)]);
  return { db, key, dir, config, storeRow };
}

test("prev F15: after a restart with the database down, the environment secret is still refused once a row was ever read", async () => {
  const { db, key, dir, config, storeRow } = await credentialRig();
  try {
    await storeRow();
    const first = createCredentialSource(db, key, config, 0);
    strictEqual(await first.webhookSecret(), "rotated");
    ok(existsSync(config.GITHUB_CREDENTIAL_MARKER_PATH), "a durable marker is left at the configured path");
    // a new process (no in-memory state) while the database is unreachable
    const broken: any = { query: async () => { throw new Error("db down"); } };
    const restarted = createCredentialSource(broken, key, config, 0);
    let refused = false;
    try { await restarted.webhookSecret(); } catch { refused = true; }
    ok(refused, "the leaked environment secret must not come back after a restart");
    deepStrictEqual(await restarted.describe(), { source: "database", decryptOk: false });
  } finally { await db.close(); }
});

test("prev F15: the database remembers a row was seen, so a deleted row does not reopen the environment secret on a fresh process", async () => {
  const { db, key, config, storeRow } = await credentialRig();
  try {
    await storeRow();
    await createCredentialSource(db, key, config, 0).webhookSecret();
    strictEqual((await db.query("SELECT db_row_seen FROM github_credential_state WHERE id = 1")).rows.length, 1);
    await db.query("DELETE FROM github_app_config WHERE id = 1");
    const fresh = createCredentialSource(db, key, { ...config, GITHUB_PRIVATE_KEY_PATH: join(tmpdir(), "no-such-dir", "key.pem") }, 0);
    let refused = false;
    try { await fresh.webhookSecret(); } catch { refused = true; }
    ok(refused);
  } finally { await db.close(); }
});

test("prev F15: a database that never held a row still falls back to the environment", async () => {
  const { db, key, config } = await credentialRig();
  try {
    const src = createCredentialSource(db, key, config, 0);
    strictEqual(await src.webhookSecret(), "leaked-env-secret");
    deepStrictEqual(await src.describe(), { source: "environment", decryptOk: true });
  } finally { await db.close(); }
});

test("prev F15: saving credentials in the admin UI marks the state durably, and health reports the live credential source", async () => {
  const seen: string[] = [];
  const h = await setup([], undefined, undefined, { credentialStatus: async () => { seen.push("asked"); return { source: "database", decryptOk: false }; } });
  try {
    const r = await h.call("PUT", "/instance/github-app", { cookie: INST, body: { appId: 9, privateKey: "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----", webhookSecret: "s3cret-value-123456" } });
    strictEqual(r.status, 200);
    strictEqual((await h.db.query("SELECT 1 FROM github_credential_state WHERE id = 1")).rows.length, 1);
    const health = await (await h.call("GET", "/instance/health", { cookie: INST })).json() as any;
    deepStrictEqual(health.githubAppCredentials, { source: "database", decryptOk: false });
    deepStrictEqual(seen, ["asked"]);
  } finally { await h.close(); }
});

test("F3 (CB): POST /outbound-writes/:id/retry is workspace-admin only, scoped by workspace, 202 on success, 503 when unwired", async () => {
  const calls: Array<[string, string]> = [];
  const ops = (retryFailed?: (id: string, slug: string) => Promise<any>) => ({
    enqueue: async () => {}, githubFor: async () => ({ request: async () => ({ data: [] }) }), resolveIssue: async () => null,
    ...(retryFailed ? { retryFailed } : {}),
  });
  const wired = await setup([], ops(async (id, slug) => { calls.push([id, slug]); return { ok: true, retried: id === "w-ok" || id === "w-fine" }; }));
  const unwired = await setup([], ops());
  const none = await setup();
  try {
    const retry = (h: typeof wired, id: string, cookie: string | null = ADM) => h.call("POST", `/workspaces/acme/outbound-writes/${id}/retry`, { ...(cookie ? { cookie } : {}) });
    const r = await retry(wired, "w-ok");
    strictEqual(r.status, 202);
    deepStrictEqual(await r.json(), { id: "w-ok", status: "retry_scheduled" });
    strictEqual((await retry(wired, "w-fine")).status, 202, "a callback that returns nothing succeeded");
    deepStrictEqual(calls, [["w-ok", "acme"], ["w-fine", "acme"]], "the workspace from the path is what scopes the retry");
    calls.length = 0;
    strictEqual((await retry(wired, "w-foreign")).status, 404, "retried:false is not found (a row of another workspace looks the same)");
    strictEqual((await retry(wired, "w-pending")).status, 404, "not failed (retried:false) is also not found");
    strictEqual((await retry(wired, "bad id!")).status, 404);
    strictEqual((await retry(wired, "w-ok", null)).status, 401, "no Plane session");
    strictEqual((await wired.call("POST", "/workspaces/acme/outbound-writes/w-ok/retry", { cookie: MEM })).status, 403, "a plain member cannot retry");
    strictEqual((await wired.call("POST", "/workspaces/acme/outbound-writes/w-ok/retry", { cookie: ADM, origin: null })).status, 403, "CSRF guard applies");
    strictEqual((await retry(unwired, "w-ok")).status, 503);
    strictEqual((await retry(none, "w-ok")).status, 503);
    deepStrictEqual(calls, [["w-foreign", "acme"], ["w-pending", "acme"]], "malformed ids, other roles, CSRF failures and unwired routes never reach the outbox");
  } finally { await wired.close(); await unwired.close(); await none.close(); }
});

test("F4 (CC): only ACTIVE label_sync links are unique, so a replacement can be created after the old one is orphaned", async () => {
  const db = new PGlite(); await db.waitReady; await migrate(db);
  try {
    const ins = (status: string) => db.query(
      `INSERT INTO sync_links (plane_workspace_slug, plane_project_id, plane_issue_id, gh_repo_id, gh_number, gh_kind, tier, created_by, status)
       VALUES ('ws', 'p', $1, 5, 7, 'issue', 'relation', 'label_sync', $2)`, [`i-${Math.random()}`, status]);
    await ins("orphaned");
    await ins("active");
    let refused = false;
    try { await ins("active"); } catch { refused = true; }
    ok(refused, "two active label_sync links for one GitHub item are still refused");
  } finally { await db.close(); }
});
