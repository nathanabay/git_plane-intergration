// Installation: the service boots without GitHub App environment bootstrap (the App is added later in the admin UI),
// a partial bootstrap is rejected, and an unconfigured App fails closed with a clear error.
import test from "node:test";
import type { TestContext } from "node:test";
import { deepStrictEqual, match, rejects, strictEqual, throws } from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { database } from "../writers/outbox-fixture.ts";
import { encryptSecret } from "../../src/auth/identity.ts";
import { loadConfig } from "../../src/config/env.ts";
import { GithubAppNotConfiguredError, createCredentialSource } from "../../src/app/credentials.ts";
import { checkSetup } from "../../src/ui/setup-check.ts";
import type { SetupCheckDeps } from "../../src/ui/setup-check.ts";

const base = {
  DATABASE_URL: "postgres://x", REDIS_URL: "redis://x", PLANE_BASE_URL: "http://plane", PLANE_SERVICE_PAT: "p", PLANE_WEBHOOK_SECRET: "w",
  PLANE_SERVICE_USER_ID: "service-user", GITSYNC_TOKEN_KEY: "k",
};
const github = { GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY_PATH: "/k", GITHUB_WEBHOOK_SECRET: "g" };

function captureExit(fn: () => unknown): string {
  const realExit = process.exit, realError = console.error;
  let printed = "";
  process.exit = ((code?: number) => { throw new Error(`exit ${code}`); }) as typeof process.exit;
  console.error = (msg: string) => { printed += msg; };
  try { throws(fn, /exit 1/); } finally { process.exit = realExit; console.error = realError; }
  return printed;
}

test("config loads with no GitHub App environment at all", () => {
  const config = loadConfig(base);
  strictEqual(config.GITHUB_APP_ID, "");
  strictEqual(config.GITHUB_PRIVATE_KEY_PATH, "");
  strictEqual(config.GITHUB_WEBHOOK_SECRET, "");
});

test("config still loads a complete GitHub App bootstrap", () => {
  const config = loadConfig({ ...base, ...github });
  deepStrictEqual([config.GITHUB_APP_ID, config.GITHUB_PRIVATE_KEY_PATH, config.GITHUB_WEBHOOK_SECRET], ["1", "/k", "g"]);
});

test("a partial GitHub App bootstrap is rejected, naming exactly the missing variables", () => {
  const printed = captureExit(() => loadConfig({ ...base, GITHUB_APP_ID: "1" }));
  match(printed, /Missing required environment variables: GITHUB_PRIVATE_KEY_PATH, GITHUB_WEBHOOK_SECRET$/);
  match(captureExit(() => loadConfig({ ...base, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY_PATH: "/k" })), /: GITHUB_WEBHOOK_SECRET$/);
});

test("the non-GitHub variables are still required", () => {
  const { PLANE_SERVICE_PAT: _drop, ...rest } = base;
  match(captureExit(() => loadConfig(rest)), /Missing required environment variables: PLANE_SERVICE_PAT/);
});

const unconfigured = { GITHUB_APP_ID: "", GITHUB_PRIVATE_KEY_PATH: "", GITHUB_WEBHOOK_SECRET: "" };

async function fixture(t: TestContext) {
  const db = await database(t), tokenKey = randomBytes(32);
  const dir = await mkdtemp(join(tmpdir(), "install-cfg-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { db, tokenKey, marker: join(dir, "state", "retired"), dir };
}

test("an unconfigured App fails closed: load and the webhook secret reject, describe reports not configured", async (t) => {
  const f = await fixture(t);
  const credentials = createCredentialSource(f.db, f.tokenKey, { ...unconfigured, GITHUB_CREDENTIAL_MARKER_PATH: f.marker }, 0);
  await rejects(credentials.load(), GithubAppNotConfiguredError);
  await rejects(credentials.webhookSecret(), /No GitHub App is configured yet/);
  deepStrictEqual(await credentials.describe(), { source: "environment", decryptOk: false, configured: false });
});

test("an App saved in the admin UI is used when the environment has none", async (t) => {
  const f = await fixture(t);
  const credentials = createCredentialSource(f.db, f.tokenKey, { ...unconfigured, GITHUB_CREDENTIAL_MARKER_PATH: f.marker }, 0);
  await rejects(credentials.load(), GithubAppNotConfiguredError);
  await f.db.query(`INSERT INTO github_app_config (id, app_id, private_key_v1, webhook_secret_v1) VALUES (1, 77, $1, $2)`,
    [encryptSecret("stored-key", f.tokenKey), encryptSecret("stored-hook", f.tokenKey)]);
  const creds = await credentials.load();
  deepStrictEqual([creds.appId, creds.privateKey, creds.webhookSecret, creds.source], ["77", "stored-key", "stored-hook", "database"]);
  deepStrictEqual(await credentials.describe(), { source: "database", decryptOk: true });
});

test("a deleted stored App is still refused, not reported as merely unconfigured", async (t) => {
  const f = await fixture(t);
  const credentials = createCredentialSource(f.db, f.tokenKey, { ...unconfigured, GITHUB_CREDENTIAL_MARKER_PATH: f.marker }, 0);
  await f.db.query(`INSERT INTO github_app_config (id, app_id, private_key_v1, webhook_secret_v1) VALUES (1, 77, $1, $2)`,
    [encryptSecret("stored-key", f.tokenKey), encryptSecret("stored-hook", f.tokenKey)]);
  await credentials.load();
  await f.db.query(`DELETE FROM github_app_config`);
  await rejects(credentials.load(), /row is gone; refusing the environment fallback/);
  deepStrictEqual(await credentials.describe(), { source: "database", decryptOk: false });
});

test("the setup checklist tells the admin to add an App rather than blaming decryption", async (t) => {
  const f = await fixture(t);
  const credentials = createCredentialSource(f.db, f.tokenKey, { ...unconfigured, GITHUB_CREDENTIAL_MARKER_PATH: f.marker }, 0);
  const deps: SetupCheckDeps = { db: f.db, credentials, github: {}, plane: { rateLimitPerMinute: 60 }, config: { PLANE_API_RATE_PER_MINUTE: 60 } };
  const result = await checkSetup(deps);
  const item = result.checks.find((c) => c.id === "credentials")!;
  strictEqual(item.status, "fail");
  match(item.detail, /No GitHub App is configured yet/);
});
