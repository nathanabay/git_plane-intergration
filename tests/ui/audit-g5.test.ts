import test from "node:test";
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createGithubClient } from "../../src/app/github.ts";
import type { CredentialSource, GithubCredentials } from "../../src/app/credentials.ts";
import { composeRoutes } from "../../src/app/main.ts";
import { installationFor, refreshInstallationMappings } from "../../src/app/context.ts";
import { mappingsForRepo } from "../../src/app/mappings.ts";
import { createRouter } from "../../src/app/reducers.ts";
import { loadConfig } from "../../src/config/env.ts";
import { startServer } from "../../src/index.ts";
import { authenticateWorkspaceAdmin } from "../../src/ui/plane-auth.ts";
import { createMappingVerifier } from "../../src/ui/mapping-check.ts";
import { HttpError } from "../../src/ui/http.ts";
import { lookupRepo, lookupUser } from "../../src/ui/client/github.ts";
import { build } from "esbuild";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { makeHarness, ghJob } from "../a8/harness.ts";
import { ADM, INST, KEY, ORIGIN, setup, startFakePlane } from "./harness.ts";
import { encryptSecret } from "../../src/auth/identity.ts";
import { putGithubOAuthToken } from "../../src/db/parity.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
const request = (cookie: string) => ({ headers: { cookie } }) as IncomingMessage;
const status = (err: unknown, expected: number) => err instanceof HttpError && err.status === expected;

async function fakeGithub(limitedUntil?: number) {
  const seen: { path: string; authorization: string | undefined }[] = [];
  const server = createServer((req, res) => {
    seen.push({ path: req.url!, authorization: req.headers.authorization });
    res.writeHead(limitedUntil ? 403 : 200, { "content-type": "application/json",
      ...(limitedUntil ? { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(limitedUntil) } : {}) });
    res.end(JSON.stringify(limitedUntil ? { message: "API rate limit exceeded" } : { id: 42, login: "Octo" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    seen, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v3`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

function credentials(load: () => Promise<GithubCredentials>): CredentialSource {
  return { load, webhookSecret: async () => "secret", describe: async () => ({ source: "database", decryptOk: true }) };
}

test("G1: real public profile client needs no installation or private key and follows credential host changes", async () => {
  const first = await fakeGithub();
  const second = await fakeGithub();
  let baseUrl = first.baseUrl;
  const client = createGithubClient(credentials(async () => ({
    appId: "1", privateKey: "not a private key", webhookSecret: "secret", baseUrl, source: "database",
  })));
  try {
    strictEqual((await client.publicRequest!("GET /users/{username}", { username: "octo" })).data.id, 42);
    baseUrl = second.baseUrl;
    strictEqual((await client.publicRequest!("GET /users/{username}", { username: "octo" })).data.login, "Octo");
    deepStrictEqual(first.seen, [{ path: "/api/v3/users/octo", authorization: undefined }]);
    deepStrictEqual(second.seen, first.seen);
  } finally { await first.close(); await second.close(); }
});

test("G1 shared retry policy: public profile requests honor a full cooldown without another HTTP request", async () => {
  const reset = Math.ceil(Date.now() / 1000) + 900;
  const host = await fakeGithub(reset);
  const client = createGithubClient(credentials(async () => ({
    appId: "1", privateKey: "unused", webhookSecret: "secret", baseUrl: host.baseUrl, source: "database",
  })));
  try {
    const isDeadline = (err: unknown) => typeof err === "object" && err !== null && (err as { retryAt?: unknown }).retryAt === reset * 1000;
    await rejects(client.publicRequest!("GET /users/{username}", { username: "octo" }), isDeadline);
    await rejects(client.publicRequest!("GET /users/{username}", { username: "another" }), isDeadline);
    strictEqual(host.seen.length, 1, "the second request fails immediately and is not sent before the deadline");
  } finally { await host.close(); }
});

test("G1/G11 with C3: composed profiles use the public client and repository lookups use the viewer's approved installation access", async (t) => {
  const h = await makeHarness();
  const plane = await startFakePlane();
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  const seen: string[] = [];
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.hostname !== "api.github.com") return nativeFetch(url, init);
    strictEqual(new Headers(init?.headers).get("authorization"), "Bearer ghu-viewer");
    strictEqual(u.pathname, "/user/installations/1/repositories");
    seen.push(`user:${u.pathname}`);
    return json({ total_count: 1, repositories: [{ id: 555, full_name: "Acme/Web", permissions: { triage: true } }] });
  });
  try {
    await h.mapping({ slug: "acme" });
    h.ctx.config.PLANE_BASE_URL = plane.url;
    h.ctx.config.PUBLIC_ORIGIN = ORIGIN;
    h.ctx.config.GITHUB_CLIENT_ID = "Iv1.fixture";
    h.ctx.config.GITHUB_CLIENT_SECRET = "fixture-secret";
    await putGithubOAuthToken(h.db, "u-adm", { accessCiphertext: encryptSecret("ghu-viewer", KEY), refreshCiphertext: null, accessExpiresAt: null, refreshExpiresAt: null });
    h.ctx.ghClient = {
      appRequest: async () => { throw new Error("App JWT must not be used for profiles"); },
      publicRequest: async (route) => { seen.push(route); return { data: { id: 42, login: "Octo" } }; },
      installationIdFor: async () => 1,
      installationOctokit: async (id) => ({ request: async (route: string) => {
        seen.push(`${id}:${route}`); return { data: { id: 555, full_name: "Acme/Web" } };
      } }),
    };
    h.ctx.planeClient.request = (async () => [{ member: { id: "u-adm" } }]) as typeof h.ctx.planeClient.request;
    server = await startServer({ port: 0, host: "127.0.0.1", routes: composeRoutes({
      config: h.ctx.config, db: h.db, tokenKey: KEY, ctx: h.ctx, planeClient: h.ctx.planeClient,
      ghClient: h.ctx.ghClient, credentials: credentials(async () => { throw new Error("unused"); }), enqueue: async () => {},
    }) });
    const call = (method: string, path: string, body?: unknown) => fetch(`http://127.0.0.1:${server!.port}/git-sync/api${path}`, {
      method, headers: { cookie: ADM, origin: ORIGIN, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const linked = await call("PUT", "/workspaces/acme/user-links/u-adm", { githubLogin: "octo", githubId: 42 });
    strictEqual(linked.status, 200);
    deepStrictEqual(await linked.json(), { planeUserId: "u-adm", githubLogin: "Octo", githubId: 42 });
    const repo = await call("GET", "/workspaces/acme/github/repository?name=acme%2Fweb");
    strictEqual(repo.status, 200);
    deepStrictEqual(await repo.json(), { id: 555, fullName: "Acme/Web" });
    ok(seen.includes("GET /users/{username}"));
    ok(seen.includes("user:/user/installations/1/repositories"));
    ok(!seen.includes("1:GET /repos/{owner}/{repo}"), "App-only repository visibility cannot replace the viewer's C3 access check");
    plane.roles["u-adm"]!.third = 20;
    const before = seen.length;
    strictEqual((await call("GET", "/workspaces/third/github/repository?name=acme%2Fweb")).status, 403);
    strictEqual(seen.length, before, "no repository read through another workspace's installation");
    await h.db.query("DELETE FROM workspace_installations WHERE installation_id = 1");
    strictEqual((await call("GET", "/workspaces/acme/github/repository?name=acme%2Fweb")).status, 403);
  } finally { await server?.close(); await plane.close(); await h.close(); }
});

test("G11: browser lookups use workspace service URLs and same-origin credentials", async (t) => {
  const calls: { url: string; credentials: RequestCredentials | undefined }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, credentials: init.credentials });
    return json(url.includes("/repository") ? { id: 555, fullName: "Acme/Web" } : { id: 42, login: "Octo" });
  });
  deepStrictEqual(await lookupRepo("my-team", "acme/web"), { id: 555, fullName: "Acme/Web" });
  deepStrictEqual(await lookupUser("my-team", "octo"), { id: 42, login: "Octo" });
  deepStrictEqual(calls, [
    { url: "/git-sync/api/workspaces/my-team/github/repository?name=acme%2Fweb", credentials: "same-origin" },
    { url: "/git-sync/api/workspaces/my-team/github/user?login=octo", credentials: "same-origin" },
  ]);
  await rejects(lookupRepo("my-team", "acme/web/extra"));
  await rejects(lookupUser("my-team", "../admin"));
  strictEqual(calls.length, 2);
});

test("G11: lookup routes authenticate, validate names, and retain GitHub retry deadlines", async () => {
  let lookups = 0;
  const deadline = Math.ceil(Date.now() / 1000) + 900;
  const h = await setup([], undefined, undefined, {
    lookupGithubRepo: async () => { throw new Error("legacy App-only lookup must not be used for C3"); },
    lookupGithubUser: async () => { throw { status: 403, response: { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(deadline) }, data: { message: "API rate limit exceeded" } } }; },
    githubOAuthConfig: { GITHUB_CLIENT_ID: "Iv1.fixture", GITHUB_CLIENT_SECRET: "fixture-secret" },
    appRequest: async () => ({ data: [] }),
    fetch: (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.hostname !== "api.github.com") return fetch(url, init);
      strictEqual(new Headers(init?.headers).get("authorization"), "Bearer ghu-viewer");
      strictEqual(u.pathname, "/user/installations/1/repositories"); lookups++;
      return json({ total_count: 1, repositories: [{ id: 555, full_name: "acme/web", permissions: { triage: true } }] });
    }) as typeof fetch,
  });
  try {
    await h.db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (1,'acme')");
    await putGithubOAuthToken(h.db, "u-adm", { accessCiphertext: encryptSecret("ghu-viewer", KEY), refreshCiphertext: null, accessExpiresAt: null, refreshExpiresAt: null });
    strictEqual((await h.call("GET", "/workspaces/acme/github/repository?name=acme%2Fweb")).status, 401);
    strictEqual((await h.call("GET", "/workspaces/acme/github/repository?name=acme%2Fweb%2Fbad", { cookie: ADM })).status, 422);
    strictEqual(lookups, 0);
    strictEqual((await h.call("GET", "/workspaces/acme/github/repository?name=acme%2Fweb", { cookie: ADM })).status, 200);
    strictEqual(lookups, 1);
    const limited = await h.call("GET", "/workspaces/acme/github/user?login=octo", { cookie: ADM });
    strictEqual(limited.status, 429);
    strictEqual((await limited.json() as { retryAt: number }).retryAt, deadline * 1000);
    ok(Number(limited.headers.get("retry-after")) > 850);
  } finally { await h.close(); }
});

test("G12: autolinks are unavailable and unchecked in the rendered mapping form", async () => {
  // Node's type stripping cannot load TSX; bundle the actual component before rendering it.
  const dir = await mkdtemp(join(tmpdir(), "audit-g5-ui-"));
  try {
    await symlink(resolve(import.meta.dirname, "../../node_modules"), join(dir, "node_modules"), "dir");
    const outfile = join(dir, "workspace.mjs");
    await build({ entryPoints: [resolve(import.meta.dirname, "../../src/ui/client/Workspace.tsx")],
      outfile, bundle: true, packages: "external", platform: "node", format: "esm", jsx: "automatic", logLevel: "silent" });
    const { MappingForm } = await import(pathToFileURL(outfile).href) as typeof import("../../src/ui/client/Workspace.tsx");
    // C1 added browser navigation hooks to the page; this assertion concerns the actual mapping form.
    const html = renderToStaticMarkup(createElement(MappingForm, { slug: "acme", onSaved() {} }));
    ok(/<input[^>]+type="checkbox"[^>]+disabled=""[^>]*\/><span>GitHub autolink references \(unavailable\)/.test(html));
    ok(!html.includes("Create GitHub autolink references"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("P7: loadConfig supplies the default or configured Plane web cookie", () => {
  const env = {
    DATABASE_URL: "db", REDIS_URL: "redis", PLANE_BASE_URL: "http://plane", PLANE_SERVICE_PAT: "pat", PLANE_SERVICE_USER_ID: "svc",
    PLANE_WEBHOOK_SECRET: "hook", GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY_PATH: "/key", GITHUB_WEBHOOK_SECRET: "hook", GITSYNC_TOKEN_KEY: "key",
  };
  strictEqual(loadConfig(env).PLANE_SESSION_COOKIE_NAME, "session-id");
  strictEqual(loadConfig({ ...env, PLANE_SESSION_COOKIE_NAME: "custom-session" }).PLANE_SESSION_COOKIE_NAME, "custom-session");
});

test("P7/P8: membership aliases the verified custom web session for instances slugs, never a different admin", async () => {
  const calls: { path: string; cookie: string }[] = [];
  const deps = { planeInternalUrl: "http://plane", planeSessionCookieName: "custom-session", fetch: (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const cookie = (init.headers as Record<string, string>).cookie!;
    calls.push({ path, cookie });
    if (path === "/api/users/me/") return cookie === "custom-session=web-user" ? json({ id: "u-web" }) : json({}, 401);
    // Reproduce Plane v1.4.2's substring cookie selector and role check.
    const selected = path.includes("instances") ? /admin-session-id=([^;]+)/.exec(cookie)?.[1] : /custom-session=([^;]+)/.exec(cookie)?.[1];
    return selected === "web-user" ? json({ role: 20 }) : json({ role: 5 });
  }) as typeof fetch };
  const viewer = await authenticateWorkspaceAdmin(deps, request("custom-session=web-user; admin-session-id=other-admin; session-id=wrong; tracking=x"), "instances-team");
  strictEqual(viewer.id, "u-web");
  deepStrictEqual(calls, [
    { path: "/api/users/me/", cookie: "custom-session=web-user" },
    { path: "/api/workspaces/instances-team/workspace-members/me/", cookie: "custom-session=web-user; admin-session-id=web-user" },
  ]);
  await authenticateWorkspaceAdmin(deps, request("custom-session=web-user; admin-session-id=other-admin"), "acme");
  strictEqual(calls.at(-1)!.cookie, "custom-session=web-user");
  await rejects(authenticateWorkspaceAdmin(deps, request("session-id=wrong"), "acme"), (err) => status(err, 401));
});

test("P7: configured cookie is forwarded by config API routes", async () => {
  const h = await setup([], undefined, undefined, {
    planeSessionCookieName: "custom-session",
    fetch: (async (_url: string, init: RequestInit) => {
      strictEqual((init.headers as Record<string, string>).cookie, "custom-session=admin");
      return json({ id: "u-adm", role: 20, workspace: "ws-id-acme" }); // the membership row names its workspace (audit S2)
    }) as typeof fetch,
  });
  try {
    strictEqual((await h.call("GET", "/workspaces/acme/mappings", { cookie: "custom-session=admin" })).status, 200);
    strictEqual((await h.call("GET", "/workspaces/acme/mappings", { cookie: ADM })).status, 401);
  } finally { await h.close(); }
});

test("G14: lifecycle router invalidates deleted/removed mappings and refreshes approved replacements", async () => {
  const h = await makeHarness();
  const invalidated: number[] = [];
  let current = 1;
  h.ctx.ghClient = {
    installationIdFor: async () => current,
    installationOctokit: async () => ({ request: async () => ({ data: { id: 555, full_name: "acme/web" } }) }),
    invalidateInstallation: (id) => { invalidated.push(id); },
  };
  try {
    const id = await h.mapping();
    const router = createRouter(h.ctx);
    const installed = async () => (await h.db.query<{ installation_id: number | string | null }>("SELECT installation_id FROM repo_mappings WHERE id = $1", [id])).rows[0]!.installation_id;
    strictEqual(await router.dispatch(ghJob("installation", { action: "deleted", installation: { id: 1 } })), "routed");
    strictEqual(await installed(), null);
    current = 2;
    await router.dispatch(ghJob("installation", { action: "created", installation: { id: 2 }, repositories: [{ id: 555 }] }));
    strictEqual(await installed(), null, "creation never auto-approves an installation");
    await h.db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (2, 'other')");
    await router.dispatch(ghJob("installation", { action: "created", installation: { id: 2 } }));
    strictEqual(await installed(), null, "approval in another workspace never grants access");
    await h.db.query("UPDATE workspace_installations SET workspace_slug = 'ws' WHERE installation_id = 2");
    await router.dispatch(ghJob("installation", { action: "created", installation: { id: 2 } }));
    strictEqual(Number(await installed()), 2);
    await router.dispatch(ghJob("installation", { action: "deleted", installation: { id: 1 } }));
    strictEqual(Number(await installed()), 2, "delayed deletion of old installation preserves replacement");
    await router.dispatch(ghJob("installation_repositories", { action: "removed", installation: { id: 2 }, repositories_removed: [{ id: 999 }] }));
    strictEqual(Number(await installed()), 2);
    await router.dispatch(ghJob("installation_repositories", { action: "removed", installation: { id: 2 }, repositories_removed: [{ id: 555 }] }));
    strictEqual(await installed(), null);
    await router.dispatch(ghJob("installation_repositories", { action: "added", installation: { id: 2 }, repositories_added: [{ id: 555 }] }));
    strictEqual(Number(await installed()), 2);
    await router.dispatch(ghJob("installation", { action: "new_permissions_accepted", installation: { id: 2 } }));
    ok(invalidated.includes(2));
    await router.dispatch(ghJob("installation", { action: "suspend", installation: { id: 2 } }));
    strictEqual(await installed(), null);
    await router.dispatch(ghJob("installation", { action: "unsuspend", installation: { id: 2 } }));
    strictEqual(Number(await installed()), 2);
  } finally { await h.close(); }
});

test("G14: installation reconciliation verifies repository IDs and honors concurrent approval revocation", async () => {
  const h = await makeHarness();
  let identity = 999;
  let revoke = false;
  try {
    const id = await h.mapping({ installationId: null });
    await h.db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (2, 'ws')");
    h.ctx.ghClient = {
      installationIdFor: async () => 2,
      installationOctokit: async () => ({ request: async () => {
        if (revoke) await h.db.query("DELETE FROM workspace_installations WHERE installation_id = 2");
        return { data: { id: identity, full_name: "acme/web" } };
      } }),
    };
    await refreshInstallationMappings(h.ctx, 2);
    strictEqual((await h.db.query<{ installation_id: number | string | null }>("SELECT installation_id FROM repo_mappings WHERE id = $1", [id])).rows[0]!.installation_id, null);
    identity = 555; revoke = true;
    await refreshInstallationMappings(h.ctx, 2);
    strictEqual((await h.db.query<{ installation_id: number | string | null }>("SELECT installation_id FROM repo_mappings WHERE id = $1", [id])).rows[0]!.installation_id, null);
  } finally { await h.close(); }
});

test("G14: Plane-only installation lookup repairs stale IDs and refuses unapproved replacements", async () => {
  const h = await makeHarness();
  try {
    await h.mapping();
    const mapping = (await mappingsForRepo(h.db, 555))[0]!;
    h.ctx.ghClient.installationIdFor = async () => 2;
    await rejects(installationFor(h.ctx, mapping), /not allowed/);
    strictEqual(mapping.installationId, 1);
    await h.db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (2, 'ws')");
    strictEqual(await installationFor(h.ctx, mapping, { installation: { id: 1 } }), 2);
    strictEqual(mapping.installationId, 2);
    strictEqual(Number((await h.db.query<{ installation_id: number | string | null }>("SELECT installation_id FROM repo_mappings WHERE id = $1", [mapping.id])).rows[0]!.installation_id), 2);
    h.ctx.ghClient.installationIdFor = async () => { throw { status: 403, response: { headers: {}, data: { message: "You have exceeded a secondary rate limit" } } }; };
    await rejects(installationFor(h.ctx, mapping));
    strictEqual(mapping.installationId, 2, "a secondary limit never invalidates installation authority");
    h.ctx.ghClient.installationIdFor = async () => { throw { status: 404 }; };
    await rejects(installationFor(h.ctx, mapping));
    strictEqual(mapping.installationId, null);
    strictEqual((await h.db.query<{ installation_id: number | string | null }>("SELECT installation_id FROM repo_mappings WHERE id = $1", [mapping.id])).rows[0]!.installation_id, null);
  } finally { await h.close(); }
});

test("G14: explicit instance approval refreshes existing disabled mappings", async () => {
  const refreshed: number[] = [];
  const h = await setup([], undefined, undefined, { refreshInstallation: async (id) => { refreshed.push(id); } });
  try {
    const response = await h.call("PUT", "/instance/installations/2", { cookie: INST, body: { workspaceSlug: "acme" } });
    strictEqual(response.status, 200);
    deepStrictEqual(refreshed, [2]);
    strictEqual((await h.call("PUT", "/instance/installations/2", { cookie: ADM, body: { workspaceSlug: "acme" } })).status, 401);
    deepStrictEqual(refreshed, [2]);
  } finally { await h.close(); }
});

test("G1 shared classifier: mapping verification propagates secondary limits instead of calling them missing installations", async () => {
  const limited = { status: 403, response: { headers: {}, data: { message: "You have exceeded a secondary rate limit" } } };
  const verify = createMappingVerifier({
    plane: { request: async () => ({}) }, installationWorkspace: async () => "acme",
    github: { installationIdFor: async () => { throw limited; }, installationOctokit: async () => { throw new Error("unused"); } },
  });
  await rejects(verify({ slug: "acme", repo: { id: 555, fullName: "acme/web" } }), (err) => err === limited);
});
