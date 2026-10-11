import test, { after, before } from "node:test";
import { strictEqual, ok, deepStrictEqual } from "node:assert/strict";
import { INST, KEY, setup } from "./harness.ts";
import type { Harness } from "./harness.ts";
import { decryptSecret } from "../../src/auth/identity.ts";
import { DEFAULT_MAGIC_WORDS } from "../../src/ui/validate.ts";

let h: Harness;
before(async () => { h = await setup(); });
after(async () => { await h.close(); });

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nSECRETKEYMATERIAL\n-----END RSA PRIVATE KEY-----";
const APP = { appId: 4242, privateKey: PEM, webhookSecret: "whsec_TOPSECRET", gheBaseUrl: null };

test("github app: unconfigured GET says so; first save needs both secrets", async () => {
  deepStrictEqual(await (await h.call("GET", "/instance/github-app", { cookie: INST })).json(), { appId: null, gheBaseUrl: null, configured: false });
  strictEqual((await h.call("PUT", "/instance/github-app", { cookie: INST, body: { appId: 1, gheBaseUrl: null } })).status, 422);
  strictEqual((await h.call("PUT", "/instance/github-app", { cookie: INST, body: { ...APP, privateKey: "not a key" } })).status, 422);
  strictEqual((await h.call("PUT", "/instance/github-app", { cookie: INST, body: { ...APP, appId: "x" } })).status, 422);
});

test("github app: secrets are stored encrypted (v1 blobs that decrypt) and never returned", async () => {
  strictEqual((await h.call("PUT", "/instance/github-app", { cookie: INST, body: APP })).status, 200);
  const text = await (await h.call("GET", "/instance/github-app", { cookie: INST })).text();
  ok(!text.includes("SECRETKEYMATERIAL") && !text.includes("TOPSECRET"));
  deepStrictEqual(JSON.parse(text), { appId: 4242, gheBaseUrl: null, configured: true });
  const row = (await h.db.query<any>(`SELECT * FROM github_app_config`)).rows[0];
  ok(row.private_key_v1.startsWith("v1:") && row.webhook_secret_v1.startsWith("v1:"));
  strictEqual(decryptSecret(row.private_key_v1, KEY), PEM);
  strictEqual(decryptSecret(row.webhook_secret_v1, KEY), "whsec_TOPSECRET");
});

test("github app: omitting the secrets keeps the stored ones while other fields change", async () => {
  const before = (await h.db.query<any>(`SELECT * FROM github_app_config`)).rows[0];
  strictEqual((await h.call("PUT", "/instance/github-app", { cookie: INST, body: { appId: 77, gheBaseUrl: "https://ghe.example.com/" } })).status, 200);
  const after = (await h.db.query<any>(`SELECT * FROM github_app_config`)).rows[0];
  strictEqual(Number(after.app_id), 77);
  strictEqual(after.ghe_base_url, "https://ghe.example.com");
  strictEqual(after.private_key_v1, before.private_key_v1);
  strictEqual(after.webhook_secret_v1, before.webhook_secret_v1);
});

test("github app: the GHE URL must be plain https", async () => {
  for (const u of ["http://ghe.example.com", "ftp://x", "https://u:p@ghe.example.com", "https://ghe.example.com/?a=b", "nonsense"]) {
    strictEqual((await h.call("PUT", "/instance/github-app", { cookie: INST, body: { appId: 77, gheBaseUrl: u } })).status, 422, u);
  }
});

test("magic words: defaults are the spec §6 lists; saved lists are normalised and returned", async () => {
  deepStrictEqual(await (await h.call("GET", "/instance/magic-words", { cookie: INST })).json(), DEFAULT_MAGIC_WORDS);
  const r = await h.call("PUT", "/instance/magic-words", { cookie: INST, body: { closing: ["Fixes", " closes "], non_closing: ["refs"], relation: ["relates  to"] } });
  strictEqual(r.status, 200);
  deepStrictEqual(await r.json(), { closing: ["fixes", "closes"], non_closing: ["refs"], relation: ["relates to"] });
  deepStrictEqual(await (await h.call("GET", "/instance/magic-words", { cookie: INST })).json(), { closing: ["fixes", "closes"], non_closing: ["refs"], relation: ["relates to"] });
});

test("magic words: empty tiers, unknown tiers, bad words and cross-tier duplicates are 422", async () => {
  const ok3 = { closing: ["fixes"], non_closing: ["refs"], relation: ["relates to"] };
  const bad: unknown[] = [
    { ...ok3, closing: [] }, { ...ok3, bogus: ["x"] }, { closing: ["fixes"] }, { ...ok3, closing: ["fix; drop"] },
    { ...ok3, closing: [3] }, { ...ok3, relation: ["fixes"] },
  ];
  for (const body of bad) strictEqual((await h.call("PUT", "/instance/magic-words", { cookie: INST, body })).status, 422, JSON.stringify(body));
});

test("settings: defaults, partial updates merge, out-of-range values are 422", async () => {
  deepStrictEqual(await (await h.call("GET", "/instance/settings", { cookie: INST })).json(),
    { smartCommitsDefault: true, reconciliationIntervalMinutes: 60, opTtlMinutes: 10 });
  const r = await h.call("PUT", "/instance/settings", { cookie: INST, body: { reconciliationIntervalMinutes: 15 } });
  strictEqual(r.status, 200);
  deepStrictEqual(await r.json(), { smartCommitsDefault: true, reconciliationIntervalMinutes: 15, opTtlMinutes: 10 });
  for (const body of [{}, { opTtlMinutes: 0 }, { opTtlMinutes: 1.5 }, { opTtlMinutes: 99999999 }, { smartCommitsDefault: "no" }, { nope: 1 }]) {
    strictEqual((await h.call("PUT", "/instance/settings", { cookie: INST, body })).status, 422, JSON.stringify(body));
  }
});

test("health: reports configuration and recent failures from the local database", async () => {
  await h.db.query(`INSERT INTO audit_log (kind, outcome, error) VALUES ('webhook', 'failed', 'boom')`);
  const health = await (await h.call("GET", "/instance/health", { cookie: INST })).json() as any;
  strictEqual(health.database, true);
  strictEqual(health.githubAppConfigured, true);
  strictEqual(health.failuresLast24h, 1);
  ok(health.lastActivityAt);
});

test("instance writes need the Origin check too", async () => {
  strictEqual((await h.call("PUT", "/instance/settings", { cookie: INST, body: { opTtlMinutes: 5 }, origin: "https://evil.example" })).status, 403);
  strictEqual((await h.call("PUT", "/instance/settings", { cookie: INST, body: "x=1", type: "text/plain" })).status, 415);
});

test("r2 F15: health reports which credentials are in use and whether the stored row decrypts", async () => {
  const health = async () => await (await h.call("GET", "/instance/health", { cookie: INST })).json() as any;
  const saved = (await h.db.query<any>(`SELECT * FROM github_app_config WHERE id = 1`)).rows[0];
  try {
    deepStrictEqual((await health()).githubAppCredentials, { source: "database", decryptOk: true });
    await h.db.query(`UPDATE github_app_config SET webhook_secret_v1 = 'not-decryptable' WHERE id = 1`);
    deepStrictEqual((await health()).githubAppCredentials, { source: "database", decryptOk: false });
    await h.db.query(`DELETE FROM github_app_config WHERE id = 1`);
    deepStrictEqual((await health()).githubAppCredentials, { source: "environment", decryptOk: true });
  } finally {
    if (saved) await h.db.query(`INSERT INTO github_app_config (id, app_id, private_key_v1, webhook_secret_v1, ghe_base_url) VALUES (1, $1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`, [saved.app_id, saved.private_key_v1, saved.webhook_secret_v1, saved.ghe_base_url]);
  }
});

test("r3 F4: the instance admin manages the installation allow-list; one installation belongs to one workspace", async () => {
  const call = (method: string, path: string, body?: unknown, cookie: string | null = INST) => h.call(method, path, { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { body }) });
  strictEqual((await call("GET", "/instance/installations", undefined, null)).status, 401);
  strictEqual((await call("PUT", "/instance/installations/10", { workspaceSlug: "acme" }, null)).status, 401);
  deepStrictEqual(await (await call("GET", "/instance/installations")).json(), []);

  let r = await call("PUT", "/instance/installations/10", { workspaceSlug: "acme", accountLogin: "acme-org" });
  strictEqual(r.status, 200);
  const first = await r.json() as any;
  deepStrictEqual([first.installationId, first.workspaceSlug, first.accountLogin], [10, "acme", "acme-org"]);
  strictEqual((await call("PUT", "/instance/installations/10", { workspaceSlug: "acme", accountLogin: "renamed" })).status, 200, "same workspace is idempotent and relabels");
  strictEqual((await call("PUT", "/instance/installations/10", { workspaceSlug: "other" })).status, 409, "an installation cannot serve two workspaces");
  strictEqual((await call("PUT", "/instance/installations/11", { workspaceSlug: "other" })).status, 200);
  for (const [path, body] of [["/instance/installations/abc", { workspaceSlug: "a" }], ["/instance/installations/0", { workspaceSlug: "a" }]] as const) {
    strictEqual((await call("PUT", path, body)).status, 404, path);
  }
  for (const body of [{}, { workspaceSlug: "bad slug" }, { workspaceSlug: "a", extra: 1 }, { workspaceSlug: "a", accountLogin: 5 }]) {
    strictEqual((await call("PUT", "/instance/installations/12", body)).status, 422, JSON.stringify(body));
  }
  const list = await (await call("GET", "/instance/installations")).json() as any[];
  deepStrictEqual(list.map((e) => [e.installationId, e.workspaceSlug, e.accountLogin]), [[10, "acme", "renamed"], [11, "other", null]]);
  strictEqual((await call("DELETE", "/instance/installations/10")).status, 204);
  strictEqual((await call("DELETE", "/instance/installations/10")).status, 404);
  strictEqual((await call("DELETE", "/instance/installations/11")).status, 204);
});
