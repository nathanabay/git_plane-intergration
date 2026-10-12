// Round-3 fixes F5, F7, F8, F18 (implementer SA): wiring through composeRoutes and the live handlers.
import test from "node:test";
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { SecretString } from "../../src/auth/identity.ts";
import { composeRoutes } from "../../src/app/main.ts";
import { startServer } from "../../src/index.ts";
import { migrate } from "../../src/db/migrate.ts";
import { PlaneClient } from "../../src/sync/plane.ts";
import { createMappingVerifier, installationWorkspaceFromDb } from "../../src/ui/mapping-check.ts";
import { rememberInstallation } from "../../src/app/mappings.ts";
import { ghJob, makeHarness, planeJob, prPayload, sha } from "../a8/harness.ts";
import { ADM, KEY, ORIGIN, startFakePlane } from "../ui/harness.ts";

const comments = (h: Awaited<ReturnType<typeof makeHarness>>) => h.plane.writes().filter((c) => /\/comments\/$/.test(c.path));

test("F5: the service's own routes verify a manual user link against GitHub's account (id mismatch is 422)", async () => {
  const db = new PGlite(); await db.waitReady; await migrate(db);
  const plane = await startFakePlane();
  const planeClient = new PlaneClient({ baseUrl: plane.url, token: new SecretString("svc"), fetch: (async (url: string) => (/\/members\/$/.test(String(url)) ? new Response(JSON.stringify([{ member: "11111111-1111-4111-8111-111111111111" }]), { status: 200 }) : new Response("{}", { status: 404 }))) as unknown as typeof fetch, sleep: async () => {}, maxRetries: 0 });
  const ghClient = {
    installationOctokit: async () => ({ request: async () => ({ data: {} }) }),
    installationIdFor: async () => 1,
    appRequest: async () => ({ data: { id: 7, login: "Octo" } }),
  };
  const credentials = { load: async () => { throw new Error("unused"); }, webhookSecret: async () => "s", describe: async () => ({ source: "environment" as const, decryptOk: true }) };
  const config: any = { PLANE_WEBHOOK_SECRET: "p", PLANE_BASE_URL: plane.url, PUBLIC_ORIGIN: ORIGIN };
  const routes = composeRoutes({ config, db, tokenKey: KEY, ctx: { db } as any, planeClient, ghClient, credentials, enqueue: async () => {} });
  const srv = await startServer({ port: 0, host: "127.0.0.1", routes });
  try {
    const put = (githubId: number) => fetch(`http://127.0.0.1:${srv.port}/git-sync/api/workspaces/acme/user-links/11111111-1111-4111-8111-111111111111`, {
      method: "PUT", headers: { cookie: ADM, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ githubLogin: "octo", githubId }),
    });
    strictEqual((await put(999)).status, 422);
    strictEqual((await db.query("SELECT 1 FROM user_map")).rows.length, 0);
  } finally { await srv.close(); await plane.close(); await db.close(); }
});

test("F5: Smart Commits attribute by the sender's GitHub id, not by a login someone else now holds", async () => {
  const h = await makeHarness();
  try {
    await h.mapping();
    await h.db.query("INSERT INTO user_map (workspace_slug, plane_user_id, gh_login, gh_id) VALUES ('ws','pu-a','old-name',5)");
    await h.ctx.vault.store("pu-a", "plane_pat", "pat-a");
    const push = (sender: any, id: string) => ghJob("push", { ref: "refs/heads/main", sender, commits: [{ id, message: "QLL-1 #comment hello", distinct: true }], after: id, before: sha("0") });
    await h.feed(push({ login: "old-name", id: 99, type: "User" }, sha("1"))); // the freed login, registered by someone else
    await h.feed(push({ login: "renamed", id: 5, type: "User" }, sha("2")));    // the real user after a rename
    const keys = comments(h).map((c) => c.key);
    ok(!keys.slice(0, 1).includes("pat-a"), "a stranger holding the old login is not attributed");
    strictEqual(keys[keys.length - 1], "pat-a");
  } finally { await h.close(); }
});

test("F7: a transient installation-lookup failure fails the delivery (it retries); 'not installed' does not", async () => {
  const h = await makeHarness();
  try {
    const mappingId = await h.mapping({ installationId: null });
    await h.db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (1, 'ws')");
    h.gh.respond(/^GET \/repos\//, () => ({ id: 555, full_name: "acme/web" }));
    let verifiedId: number | undefined;
    const verify = createMappingVerifier({ plane: h.ctx.planeClient, github: h.ctx.ghClient, installationWorkspace: installationWorkspaceFromDb(h.db) });
    strictEqual(await verify({ slug: "ws", repo: { id: 555, fullName: "acme/web" }, onInstallationVerified: (id) => { verifiedId = id; } }), null);
    strictEqual(verifiedId, 1);
    await rememberInstallation(h.db, mappingId, verifiedId!);
    // Exercise lookup recovery for an already-admitted legacy snapshot. The SQL still checks the
    // actual verified installation/allow-list; only the hydrated snapshot forgets its cached ID.
    const originalQuery = h.db.query.bind(h.db);
    h.db.query = (async (sql: string, params?: any[]) => {
      const result = await originalQuery(sql, params);
      if (sql.includes("SELECT rm.*") && sql.includes("AS allowed")) {
        for (const row of result.rows as any[]) if (row.allowed) row.installation_id = null;
      }
      return result;
    }) as typeof h.db.query;
    await h.link("i1", 7);
    const upd = () => planeJob("issue", { workspace_slug: "ws", action: "update", data: { id: "i1", project: "p-qll", name: "x" }, activity: { field: "name", actor: { id: "u-h" } } });
    let lookups = 0;
    h.ctx.ghClient.installationIdFor = async () => { lookups++; throw Object.assign(new Error("bad gateway"), { status: 502 }); };
    await rejectsAsync(() => h.feed(upd()));
    h.ctx.ghClient.installationIdFor = async () => { lookups++; throw Object.assign(new Error("not found"), { status: 404 }); };
    strictEqual(await h.feed(upd()), "handled");
    strictEqual(lookups, 2, "both deliveries reach installation lookup through an authorized mapping");
    strictEqual(h.gh.writes().length, 0, "no write is made with an unavailable installation");
  } finally { await h.close(); }
});

async function rejectsAsync(fn: () => Promise<unknown>) {
  let threw = false;
  try { await fn(); } catch { threw = true; }
  ok(threw, "expected the delivery to fail so that it is retried");
}

const HEAD = sha("a");
async function readySetup(rules: string) {
  const h = await makeHarness();
  await h.mapping({ rules, smartCommits: false });
  await h.link("iss-1", 12, { kind: "pr" });
  const pr = { number: 12, title: "Fix QLL-1", draft: false, state: "open", merged: false, head: { ref: "octo/login", sha: HEAD }, base: { ref: "main" }, labels: [], user: { login: "octo" } };
  h.gh.respond(/commits\/\{commit_sha\}\/pulls$/, () => [pr]);
  h.gh.respond(/pulls\/\{pull_number\}\/reviews$/, () => [{ state: "APPROVED", user: { login: "rev", id: 9 } }]);
  h.gh.respond(/commits\/\{ref\}\/check-suites$/, () => ({ check_suites: [{ status: "completed", conclusion: "success" }] }));
  h.gh.respond(/commits\/\{ref\}\/check-runs$/, () => ({ check_runs: [] }));
  return h;
}

test("F8: with both 'approved' and 'ready for merge' mapped, the ready rule runs last", async () => {
  const h = await readySetup("- when: pull_request.approved\n  then: [{ comment: approved }]\n- when: pull_request.ready_for_merge\n  then: [{ comment: ready }]\n");
  try {
    await h.feed(ghJob("pull_request_review", { ...prPayload("submitted", {}, { title: "Fix QLL-1", head: { ref: "octo/login", sha: HEAD } }), review: { state: "approved", user: { login: "rev", id: 9 } } }));
    deepStrictEqual(comments(h).map((c) => c.body.comment_html), ["<p>approved</p>", "<p>ready</p>"]);
  } finally { await h.close(); }
});

test("F18: readiness costs no GitHub reads for a PR with no linked item, and a check_run does not evaluate it", async () => {
  const h = await readySetup("- when: pull_request.ready_for_merge\n  then: [{ comment: ready }]\n");
  try {
    await h.db.query("UPDATE sync_links SET status = 'orphaned'"); // no active link
    const readReads = () => h.gh.calls.filter((c) => /reviews$|check-suites$/.test(c.route)).length;
    await h.feed(ghJob("check_suite", { action: "completed", check_suite: { head_sha: HEAD, conclusion: "success", pull_requests: [{ number: 12 }] } }));
    strictEqual(readReads(), 0);
    await h.db.query("UPDATE sync_links SET status = 'active'");
    await h.feed(ghJob("check_run", { action: "completed", check_run: { head_sha: HEAD, conclusion: "success", pull_requests: [{ number: 12 }] } }));
    strictEqual(readReads(), 0);
    strictEqual(comments(h).length, 0);
    await h.feed(ghJob("check_suite", { action: "completed", check_suite: { head_sha: HEAD, conclusion: "success", pull_requests: [{ number: 12 }] } }));
    strictEqual(comments(h).length, 1);
  } finally { await h.close(); }
});

test("F1 wiring: the assignee-sync wrapper forwards the writer's optional plan method unchanged", async () => {
  const { assigneeSyncWriter } = await import("../../src/app/issues.ts");
  const plan = async () => ({ ok: true as const });
  const wrapped = assigneeSyncWriter({ github: { apply: async () => ({ ok: true as const }), plan } } as any, "ws");
  strictEqual(typeof wrapped.plan, "function");
  deepStrictEqual(await wrapped.plan!("k", []), { ok: true });
  strictEqual(assigneeSyncWriter({ github: { apply: async () => ({ ok: true as const }) } } as any, "ws").plan, undefined);
});
