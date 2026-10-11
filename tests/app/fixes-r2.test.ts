// Round-2 fixes F1, F12, F14, F15 (implementer SA): the production wiring, id-based actors, the commit-range
// lookup and the credential source. PGlite plus the A8 harness fakes; no Redis.
import test from "node:test";
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretString, encryptSecret } from "../../src/auth/identity.ts";
import { createCredentialSource } from "../../src/app/credentials.ts";
import { actorTokenFor } from "../../src/app/context.ts";
import { composeRoutes } from "../../src/app/main.ts";
import { createWebhookRoutes } from "../../src/api/handler.ts";
import { startServer } from "../../src/index.ts";
import { PUSH_PAYLOAD_COMMIT_LIMIT } from "../../src/github/smart-commits.ts";
import { migrate } from "../../src/db/migrate.ts";
import { PlaneClient } from "../../src/sync/plane.ts";
import { makeHarness, ghJob, sha } from "../a8/harness.ts";
import { ADM, KEY, ORIGIN, startFakePlane } from "../ui/harness.ts";

test("F1: the service's own routes refuse a project that is not in the workspace (422), and never skip the check", async () => {
  const db = new PGlite(); await db.waitReady; await migrate(db);
  const plane = await startFakePlane(); // session endpoints for the viewer; the service client below answers 404: it cannot see the project
  const planeClient = new PlaneClient({ baseUrl: plane.url, token: new SecretString("svc"), fetch: (async () => new Response("{}", { status: 404 })) as typeof fetch, sleep: async () => {}, maxRetries: 0 });
  const ghClient = { installationOctokit: async () => ({ request: async () => ({ data: {} }) }), installationIdFor: async () => { throw Object.assign(new Error("nf"), { status: 404 }); } };
  const credentials = { load: async () => { throw new Error("unused"); }, webhookSecret: async () => "s", describe: async () => ({ source: "environment" as const, decryptOk: true }) };
  const config: any = { PLANE_WEBHOOK_SECRET: "p", PLANE_BASE_URL: plane.url, PUBLIC_ORIGIN: ORIGIN };
  const routes = composeRoutes({ config, db, tokenKey: KEY, ctx: { db } as any, planeClient, ghClient, credentials, enqueue: async () => {} });
  const srv = await startServer({ port: 0, host: "127.0.0.1", routes });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/git-sync/api/workspaces/acme/mappings`, {
      method: "POST",
      headers: { cookie: ADM, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ ghRepoId: 555, ghRepoFullName: "acme/web", planeProjectId: "p-foreign", syncDirection: "bidirectional", smartCommitsEnabled: true, linkbackComments: true }),
    });
    strictEqual(res.status, 422);
    strictEqual((await db.query("SELECT 1 FROM repo_mappings")).rows.length, 0);
  } finally { await srv.close(); await plane.close(); await db.close(); }
});

test("F12: an event is attributed by the sender's GitHub id; a renamed login keeps its mapping and a re-registered login does not inherit it", async () => {
  const h = await makeHarness();
  try {
    await h.mapping();
    await h.db.query("INSERT INTO user_map (workspace_slug, plane_user_id, gh_login, gh_id) VALUES ('ws','pu-a','old-name',5)");
    const mapping = { workspaceSlug: "ws", ghRepoId: 555, owner: "acme", repo: "web", ghRepoFullName: "acme/web", installationId: 1 } as any;
    await h.ctx.vault.store("pu-a", "plane_pat", "pat-a");
    // renamed on GitHub: same id, new login
    const token = await actorTokenFor(h.ctx, mapping, { login: "new-name", id: 5, type: "User" }, "test");
    strictEqual(token?.reveal(), "pat-a");
    strictEqual((await h.db.query<any>("SELECT gh_login FROM user_map WHERE gh_id = 5")).rows[0].gh_login, "new-name");
    // someone registers the freed login: different id, no attribution
    strictEqual(await actorTokenFor(h.ctx, mapping, { login: "old-name", id: 99, type: "User" }, "test"), undefined);
    strictEqual((await h.audit("identity_fallback")).length, 1);
  } finally { await h.close(); }
});

test("F14: a push as large as GitHub's payload limit is completed from the compare API through the installation client", async () => {
  const h = await makeHarness();
  try {
    await h.mapping();
    const hex = (i: number) => i.toString(16).padStart(40, "0");
    const listed = Array.from({ length: PUSH_PAYLOAD_COMMIT_LIMIT }, (_, i) => ({ id: hex(i + 1), message: `chore ${i}` }));
    const full = Array.from({ length: PUSH_PAYLOAD_COMMIT_LIMIT + 5 }, (_, i) => ({ sha: hex(i + 1), commit: { message: `chore ${i}` }, html_url: `https://github.com/acme/web/commit/${i}` }));
    h.gh.respond(/GET \/repos\/\{owner\}\/\{repo\}\/compare\/\{basehead\}$/, () => ({ commits: full }));
    await h.feed(ghJob("push", { ref: "refs/heads/feature", created: false, before: sha("1"), after: sha("2"), commits: listed }));
    const compare = h.gh.calls.filter((c) => c.route.includes("/compare/"));
    ok(compare.length >= 1);
    strictEqual(compare[0]!.params.basehead, `${sha("1")}...${sha("2")}`);
    deepStrictEqual((await h.audit("smart_commit_truncated")).length, 0);
  } finally { await h.close(); }
});

test("F15: the credential source says where credentials come from and never falls back to the environment once a row was read", async () => {
  const db = new PGlite(); await db.waitReady; await migrate(db);
  const key = randomBytes(32);
  const keyFile = join(mkdtempSync(join(tmpdir(), "gh-key-")), "key.pem");
  writeFileSync(keyFile, "PEM-ENV");
  const config = { GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY_PATH: keyFile, GITHUB_WEBHOOK_SECRET: "leaked-env-secret", GITHUB_API_BASE_URL: "https://ghe.env/api/v3" };
  try {
    const src = createCredentialSource(db, key, config, 0);
    deepStrictEqual(await src.describe(), { source: "environment", decryptOk: true });
    await db.query("INSERT INTO github_app_config (id, app_id, private_key_v1, webhook_secret_v1, ghe_base_url) VALUES (1, 42, $1, $2, NULL)", [encryptSecret("PEM-1", key), encryptSecret("rotated", key)]);
    const creds = await src.load();
    deepStrictEqual([creds.source, creds.baseUrl], ["database", undefined]); // cleared URL means github.com, not the env URL
    deepStrictEqual(await src.describe(), { source: "database", decryptOk: true });
    // database outage: the last stored secret keeps verifying; the environment secret never comes back
    const broken: any = { query: async () => { throw new Error("db down"); } };
    const outage = createCredentialSource(broken, key, config, 0);
    strictEqual(await outage.webhookSecret(), "leaked-env-secret"); // cold start, no row ever seen
    // an undecryptable row is reported and refused, not replaced by the environment
    await db.query("UPDATE github_app_config SET webhook_secret_v1 = 'garbage' WHERE id = 1");
    deepStrictEqual(await src.describe(), { source: "database", decryptOk: false });
    let refused = false; try { await src.webhookSecret(); } catch { refused = true; }
    ok(refused);
  } finally { await db.close(); }
});

test("F15: the webhook route answers 503 when the stored secret cannot be read", async () => {
  const routes = createWebhookRoutes({ planeSecret: "p", githubSecret: async () => { throw new Error("cannot decrypt"); }, enqueue: async () => {} });
  const srv = await startServer({ port: 0, host: "127.0.0.1", routes });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/git-sync/webhooks/github`, { method: "POST", headers: { "content-type": "application/json", "x-github-event": "ping", "x-github-delivery": "d1", "x-hub-signature-256": "sha256=00" }, body: "{}" });
    strictEqual(res.status, 503);
  } finally { await srv.close(); }
});
