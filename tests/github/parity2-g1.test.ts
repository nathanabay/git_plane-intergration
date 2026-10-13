import test from "node:test";
import type { TestContext } from "node:test";
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { database } from "../writers/outbox-fixture.ts";
import { makeHarness, planeJob, LABELS } from "../a8/harness.ts";
import { encryptSecret } from "../../src/auth/identity.ts";
import { createCredentialSource } from "../../src/app/credentials.ts";
import type { CredentialSource, GithubCredentials } from "../../src/app/credentials.ts";
import { createGithubClient } from "../../src/app/github.ts";
import { githubHostsFor } from "../../src/app/context.ts";
import { handlePlaneIssue } from "../../src/app/issues.ts";
import { saveGithubAppClient } from "../../src/db/parity.ts";
import { deriveGithubHosts } from "../../src/github/hosts.ts";
import { checkSetup, createSetupCheckHandler, REQUIRED_APP_EVENTS, REQUIRED_APP_PERMISSIONS } from "../../src/ui/setup-check.ts";
import type { SetupCheckDeps, SetupCheckResult } from "../../src/ui/setup-check.ts";
import type { Db } from "../../src/db/migrate.ts";

const NOW = Date.UTC(2026, 9, 12, 12);
const getCheck = (result: SetupCheckResult, id: string) => result.checks.find((check) => check.id === id)!;
const source = (load: () => Promise<GithubCredentials>): CredentialSource => ({ load,
  webhookSecret: async () => (await load()).webhookSecret,
  describe: async () => ({ source: (await load()).source, decryptOk: true }),
});

async function credentialFixture(t: TestContext) {
  const db = await database(t), tokenKey = randomBytes(32);
  const dir = await mkdtemp(join(tmpdir(), "parity2-g1-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pem = join(dir, "app.pem");
  await writeFile(pem, "bootstrap-private-key");
  const config = { GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY_PATH: pem, GITHUB_WEBHOOK_SECRET: "bootstrap-hook",
    GITHUB_CREDENTIAL_MARKER_PATH: join(dir, "state", "retired"),
    GITHUB_EDITION: "ghe_cloud" as const, GITHUB_GHE_SUBDOMAIN: "bootstrap" };
  const insert = async () => db.query(`INSERT INTO github_app_config
    (id, app_id, private_key_v1, webhook_secret_v1, edition, ghe_base_url)
    VALUES (1, 42, $1, $2, 'ghes', 'https://server.example:8443/api/v3')`,
  [encryptSecret("stored-private-key", tokenKey), encryptSecret("stored-hook", tokenKey)]);
  return { db, tokenKey, config, insert };
}

test("C8: stored edition/subdomain from parity readers overrides bootstrap and follows host edits", async (t) => {
  const f = await credentialFixture(t);
  const credentials = createCredentialSource(f.db, f.tokenKey, f.config, 0);
  strictEqual((await credentials.load()).hosts!.webOrigin, "https://bootstrap.ghe.com");
  await f.insert();
  const server = await credentials.load();
  deepStrictEqual([server.source, server.privateKey, server.webhookSecret, server.baseUrl, server.hosts!.webOrigin],
    ["database", "stored-private-key", "stored-hook", "https://server.example:8443/api/v3", "https://server.example:8443"]);
  await saveGithubAppClient(f.db, { edition: "ghe_cloud", gheSubdomain: "stored", gheBaseUrl: null });
  const cloud = await credentials.load();
  strictEqual(cloud.baseUrl, "https://api.stored.ghe.com");
  strictEqual(cloud.hosts!.webOrigin, "https://stored.ghe.com");
  await saveGithubAppClient(f.db, { edition: "github", gheSubdomain: null, gheBaseUrl: null });
  const publicHost = await credentials.load();
  strictEqual(publicHost.baseUrl, undefined, "a stored public edition must not inherit an Enterprise bootstrap");
  strictEqual(publicHost.hosts!.webOrigin, "https://github.com");
});

test("C8: host wiring retains the last stored credentials during outages and never revives retired bootstrap", async (t) => {
  const f = await credentialFixture(t);
  await f.insert();
  let unavailable = false;
  const db: Db = { exec: (sql) => f.db.exec(sql), query: async (sql, params) => {
    if (unavailable) throw new Error("database unavailable");
    return f.db.query(sql, params);
  } };
  const credentials = createCredentialSource(db, f.tokenKey, f.config, 0);
  await credentials.load();
  unavailable = true;
  strictEqual((await credentials.load()).hosts!.webOrigin, "https://server.example:8443");
  await rejects(createCredentialSource(db, f.tokenKey, f.config, 0).load(), /database unavailable/);
  unavailable = false;
  await f.db.query("UPDATE github_app_config SET webhook_secret_v1 = 'invalid-ciphertext' WHERE id = 1");
  deepStrictEqual(await credentials.describe(), { source: "database", decryptOk: false });
  await rejects(credentials.load());
  await f.db.query("DELETE FROM github_app_config WHERE id = 1");
  await rejects(credentials.load(), /refusing the environment fallback/);
});

test("C8: real Octokit App, installation and public clients all follow resolved API host changes", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  let hosts = deriveGithubHosts();
  const calls: { url: string; authorization: string | null }[] = [];
  const fetchFake: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), authorization: new Headers(init?.headers).get("authorization") });
    const body = url.pathname.endsWith("/access_tokens") ? { token: `installation-${url.host}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() }
      : url.pathname.endsWith("/installation") ? { id: 90001 }
      : url.pathname.endsWith("/app") ? { id: 42, permissions: REQUIRED_APP_PERMISSIONS, events: REQUIRED_APP_EVENTS }
      : { id: 5, login: "user" };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = createGithubClient(source(async () => ({ appId: "42", privateKey, webhookSecret: "hook", hosts,
    baseUrl: "https://obsolete.example/api/v3", source: "database" })), undefined, { fetch: fetchFake });
  for (const next of [deriveGithubHosts(), deriveGithubHosts({ edition: "ghe_cloud", gheSubdomain: "active" }),
    deriveGithubHosts({ edition: "ghes", gheBaseUrl: "https://server.example:8443" })]) {
    hosts = next;
    const start = calls.length;
    deepStrictEqual(await client.hosts!(), hosts);
    await client.appRequest!("GET /app", {});
    strictEqual(await client.installationIdFor("acme", "web"), 90001);
    await (await client.installationOctokit(90001)).request("GET /repos/{owner}/{repo}/issues/{issue_number}", { owner: "acme", repo: "web", issue_number: 3 });
    await client.publicRequest!("GET /users/{username}", { username: "user" });
    const requests = calls.slice(start);
    strictEqual(requests.length, 5);
    ok(requests.every((call) => call.url.startsWith(`${hosts.apiBaseUrl}/`)));
    const jwt = requests.find((call) => call.url.endsWith("/app"))!.authorization!;
    strictEqual(jwt.replace(/^bearer /i, "").split(".").length, 3, "GET /app must use the App JWT");
    strictEqual(requests.find((call) => call.url.endsWith("/issues/3"))!.authorization!.endsWith(`installation-${new URL(hosts.apiBaseUrl).host}`), true);
    strictEqual(requests.find((call) => call.url.endsWith("/users/user"))!.authorization, null);
  }
});

test("C8: context reads stored parity hosts and mirror cross-links use the current client web origin", async () => {
  const h = await makeHarness();
  try {
    await h.mapping({ linkback: true });
    await h.db.query(`INSERT INTO github_app_config (id, app_id, private_key_v1, webhook_secret_v1, edition, ghe_subdomain)
      VALUES (1, 42, 'unused', 'unused', 'ghe_cloud', 'stored')`);
    strictEqual((await githubHostsFor(h.ctx)).webOrigin, "https://stored.ghe.com");
    h.ctx.ghClient = { ...h.ctx.ghClient, hosts: async () => deriveGithubHosts({ edition: "ghes", gheBaseUrl: "https://active.example:8443" }) };
    strictEqual((await githubHostsFor(h.ctx)).webOrigin, "https://active.example:8443", "the active client is the authority when present");
    await handlePlaneIssue(h.ctx, planeJob("issue", { action: "created", data: {
      id: "iss-enterprise", project: "p-qll", name: "Enterprise mirror", description_html: "<p>Body</p>", labels: [LABELS[0]],
    } }));
    const posts = h.plane.writes().filter((call) => /\/links\/$/.test(call.path));
    strictEqual(posts.length, 1);
    const link = (await h.db.query<{ gh_number: number }>("SELECT gh_number FROM sync_links WHERE plane_issue_id = 'iss-enterprise'")).rows[0]!;
    strictEqual(posts[0]!.body.url, `https://active.example:8443/acme/web/issues/${link.gh_number}`);
  } finally { await h.close(); }
});

async function setupFixture(t: TestContext) {
  const db = await database(t);
  await db.query(`INSERT INTO webhook_deliveries (source, delivery_id, received_at) VALUES
    ('github', 'signed-github', $1), ('plane', 'signed-plane', $2)`, [new Date(NOW - 30_000), new Date(NOW - 20_000)]);
  const app = { permissions: { ...REQUIRED_APP_PERMISSIONS } as Record<string, string>, events: [...REQUIRED_APP_EVENTS] };
  const calls: string[] = [];
  const deps: SetupCheckDeps = { db, credentials: { describe: async () => ({ source: "database", decryptOk: true }) },
    github: { appRequest: async (route, params) => { calls.push(route); deepStrictEqual(params, {}); return { data: app }; } },
    plane: { rateLimitPerMinute: 60 }, config: { PLANE_API_RATE_PER_MINUTE: 60 }, readPlaneRateLimit: async () => 60, now: () => NOW,
  };
  return { db, app, calls, deps };
}

test("N7: exported handler reports all prerequisites and reads only App-JWT GET /app", async (t) => {
  const f = await setupFixture(t);
  const result = await createSetupCheckHandler(f.deps)();
  strictEqual(result.ok, true);
  strictEqual(result.checkedAt, new Date(NOW).toISOString());
  strictEqual(result.checks.length, 6);
  ok(result.checks.every((check) => check.status === "pass" && !!check.runbookAnchor));
  deepStrictEqual(f.calls, ["GET /app"]);
  strictEqual((getCheck(result, "github_permissions").data.required as Record<string, string>).statuses, "read");
  strictEqual((getCheck(result, "github_events").data.required as string[]).includes("installation"), false);
});

test("N7: Checks write cannot replace Commit statuses read, and missing subscriptions fail separately", async (t) => {
  const f = await setupFixture(t);
  delete f.app.permissions.statuses;
  f.app.permissions.checks = "write";
  f.app.events = f.app.events.filter((event) => event !== "status");
  const result = await checkSetup(f.deps);
  strictEqual(result.ok, false);
  strictEqual(getCheck(result, "github_permissions").status, "fail");
  deepStrictEqual(getCheck(result, "github_permissions").data.missing, [{ permission: "statuses", required: "read", granted: null }]);
  deepStrictEqual(getCheck(result, "github_events").data.missing, ["status"]);
});

test("N7: higher grants satisfy reads while Administration is required only for configured autolinks", async (t) => {
  const f = await setupFixture(t);
  f.app.permissions.statuses = "write";
  strictEqual(getCheck(await checkSetup(f.deps), "github_permissions").status, "pass");
  // Fixture correction: permission checks need a valid mapping, including its required direction.
  await f.db.query(`INSERT INTO repo_mappings (workspace_slug, gh_repo_id, gh_repo_full_name, plane_project_id, sync_direction, autolinks_enabled)
    VALUES ('ws', 7, 'acme/web', 'project', 'bidirectional', true)`);
  deepStrictEqual(getCheck(await checkSetup(f.deps), "github_permissions").data.missing,
    [{ permission: "administration", required: "write", granted: null }]);
  f.app.permissions.administration = "read";
  strictEqual(getCheck(await checkSetup(f.deps), "github_permissions").status, "fail");
  f.app.permissions.administration = "write";
  strictEqual(getCheck(await checkSetup(f.deps), "github_permissions").status, "pass");
  await f.db.query("UPDATE repo_mappings SET autolinks_enabled = false WHERE gh_repo_id = 7");
  delete f.app.permissions.administration;
  const disabled = getCheck(await checkSetup(f.deps), "github_permissions");
  strictEqual(disabled.status, "pass");
  strictEqual(Object.hasOwn(disabled.data.required as Record<string, string>, "administration"), false);
});

test("N7: malformed permission/event responses and unrecognized grant strings fail closed", async (t) => {
  const f = await setupFixture(t);
  f.app.permissions.statuses = "constructor";
  strictEqual(getCheck(await checkSetup(f.deps), "github_permissions").status, "fail");
  f.deps.github = { appRequest: async () => ({ data: { permissions: [], events: {} } }) };
  const malformed = await checkSetup(f.deps);
  strictEqual(getCheck(malformed, "github_permissions").status, "fail");
  strictEqual(getCheck(malformed, "github_events").status, "fail");
});

test("N7: unreadable credentials skip App requests and never expose decrypt errors", async (t) => {
  const f = await setupFixture(t);
  f.deps.credentials = { describe: async () => { throw new Error("private-key-super-secret"); } };
  const result = await checkSetup(f.deps);
  strictEqual(getCheck(result, "credentials").status, "fail");
  strictEqual(getCheck(result, "github_permissions").status, "unknown");
  deepStrictEqual(f.calls, []);
  strictEqual(JSON.stringify(result).includes("private-key-super-secret"), false);
});

test("N7: GitHub throttling returns its full retry deadline without false success or secret leakage", async (t) => {
  const f = await setupFixture(t);
  f.deps.github = { appRequest: async () => { throw Object.assign(new Error("jwt-super-secret"), { status: 429, response: { headers: { "retry-after": "900" } } }); } };
  const result = await checkSetup(f.deps);
  strictEqual(result.ok, false);
  strictEqual(getCheck(result, "github_permissions").status, "unknown");
  strictEqual(getCheck(result, "github_permissions").data.retryAt, NOW + 900_000);
  strictEqual(getCheck(result, "github_events").data.retryAt, NOW + 900_000);
  strictEqual(JSON.stringify(result).includes("jwt-super-secret"), false);
});

test("N7: genuine failed and spooled deliveries count; cooldowns, claims, replay and future rows do not", async (t) => {
  const f = await setupFixture(t);
  await f.db.query(`INSERT INTO webhook_deliveries (source, delivery_id, received_at) VALUES
    ('github', 'github-rate-limit:installation:1', $1), ('github', 'replay-4-5', $1),
    ('plane', 'content:plane-comment-claim', $1), ('plane', 'backfill-synthetic', $1), ('github', 'future', $2)`,
  [new Date(NOW - 1000), new Date(NOW + 900_000)]);
  await f.db.query(`INSERT INTO audit_log (kind, source, delivery_id, outcome, created_at) VALUES
    ('inbound_delivery', 'github', 'signed-but-failed', 'failed', $1),
    ('inbound_delivery', 'github', 'replay-9-10', 'handled', $2)`, [new Date(NOW - 5000), new Date(NOW - 500)]);
  await f.db.query(`INSERT INTO inbound_spool (source, delivery_id, event, received_at, payload)
    VALUES ('plane', 'signed-spooled', 'issue', $1, '{}')`, [new Date(NOW - 2000)]);
  const result = await checkSetup(f.deps);
  strictEqual(getCheck(result, "github_delivery").data.lastDeliveryAt, new Date(NOW - 5000).toISOString());
  strictEqual(getCheck(result, "plane_delivery").data.lastDeliveryAt, new Date(NOW - 2000).toISOString());
});

test("N7: an empty delivery history and inaccessible storage are reported as unknown", async (t) => {
  const f = await setupFixture(t);
  await f.db.query("DELETE FROM webhook_deliveries");
  const empty = await checkSetup(f.deps);
  strictEqual(getCheck(empty, "github_delivery").status, "unknown");
  strictEqual(getCheck(empty, "plane_delivery").data.lastDeliveryAt, null);
  f.deps.db = { exec: async () => {}, query: async () => { throw new Error("database-password-super-secret"); } };
  const failed = await checkSetup(f.deps);
  strictEqual(getCheck(failed, "github_delivery").status, "unknown");
  strictEqual(getCheck(failed, "github_permissions").status, "unknown", "optional autolink requirements cannot be guessed during DB failure");
  strictEqual(JSON.stringify(failed).includes("database-password-super-secret"), false);
});

test("N7: Plane rate comparisons fail mismatches and never infer its total rate from remaining quota", async (t) => {
  const f = await setupFixture(t);
  f.deps.readPlaneRateLimit = undefined;
  const unavailable = getCheck(await checkSetup(f.deps), "plane_rate_limit");
  strictEqual(unavailable.status, "unknown");
  strictEqual(unavailable.data.serverVerified, false);
  strictEqual(unavailable.data.planePerMinute, null);
  f.deps.plane = { rateLimitPerMinute: 30 };
  strictEqual(getCheck(await checkSetup(f.deps), "plane_rate_limit").status, "fail");
  f.deps.plane = { rateLimitPerMinute: 60 };
  f.deps.readPlaneRateLimit = async () => 600;
  strictEqual(getCheck(await checkSetup(f.deps), "plane_rate_limit").status, "fail");
  f.deps.readPlaneRateLimit = async () => 0;
  strictEqual(getCheck(await checkSetup(f.deps), "plane_rate_limit").status, "fail");
  f.deps.readPlaneRateLimit = async () => 60;
  strictEqual(getCheck(await checkSetup(f.deps), "plane_rate_limit").status, "pass");
  f.deps.readPlaneRateLimit = () => { throw new Error("deployment-reader-super-secret"); };
  const failedReader = await checkSetup(f.deps);
  strictEqual(getCheck(failedReader, "plane_rate_limit").status, "unknown");
  strictEqual(JSON.stringify(failedReader).includes("deployment-reader-super-secret"), false);
});
