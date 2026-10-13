import test, { after, before } from "node:test";
import { strictEqual, ok, deepStrictEqual } from "node:assert/strict";
import { ADM, INST, KEY, MAPPING, MEM, ORIGIN, setup } from "./harness.ts";
import type { Harness } from "./harness.ts";
import { encryptSecret } from "../../src/auth/identity.ts";
import { putGithubOAuthToken } from "../../src/db/parity.ts";

let h: Harness;
before(async () => {
  // C3 adds personal repository access after the auth/CSRF guards; valid JSON must reach that positive control.
  h = await setup([], undefined, undefined, {
    githubOAuthConfig: { GITHUB_CLIENT_ID: "Iv1.fixture", GITHUB_CLIENT_SECRET: "fixture-secret" },
    appRequest: async () => ({ data: [] }),
    fetch: (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.hostname !== "api.github.com") return fetch(url, init);
      strictEqual(new Headers(init?.headers).get("authorization"), "Bearer ghu-fixture");
      strictEqual(u.pathname, "/user/installations/1/repositories");
      return new Response(JSON.stringify({ total_count: 1, repositories: [{ id: 555, full_name: "acme/web", permissions: { triage: true } }] }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  await h.db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (1,'acme')");
  await putGithubOAuthToken(h.db, "u-adm", { accessCiphertext: encryptSecret("ghu-fixture", KEY), refreshCiphertext: null, accessExpiresAt: null, refreshExpiresAt: null });
});
after(async () => { await h.close(); });

test("auth: no cookie, forged cookie and a member session are 401/401/403 and write nothing", async () => {
  strictEqual((await h.call("GET", "/workspaces/acme/mappings")).status, 401);
  strictEqual((await h.call("GET", "/workspaces/acme/mappings", { cookie: "session-id=forged" })).status, 401);
  strictEqual((await h.call("GET", "/workspaces/acme/mappings", { cookie: MEM })).status, 403);
  strictEqual((await h.call("POST", "/workspaces/acme/mappings", { cookie: MEM, body: MAPPING })).status, 403);
  strictEqual(await h.count("repo_mappings"), 0);
});

test("auth: error bodies are {error} and never echo Plane's text or cookies", async () => {
  const r = await h.call("GET", "/workspaces/acme/mappings", { cookie: "session-id=forged" });
  const body = await r.json() as { error: string };
  deepStrictEqual(Object.keys(body), ["error"]);
  ok(!/forged|Authentication credentials/.test(body.error), body.error);
});

test("auth: only the relevant Plane cookie is forwarded and Plane only sees GETs", async () => {
  h.plane.calls.length = 0;
  strictEqual((await h.call("GET", "/workspaces/acme/mappings", { cookie: ADM })).status, 200);
  ok(h.plane.calls.length >= 2);
  for (const c of h.plane.calls) {
    strictEqual(c.method, "GET");
    strictEqual(c.cookie, "session-id=adm");
  }
  h.plane.calls.length = 0;
  strictEqual((await h.call("GET", "/instance/health", { cookie: `${INST}; session-id=adm; csrftoken=x` })).status, 200);
  strictEqual(h.plane.calls.length, 1);
  strictEqual(h.plane.calls[0]!.cookie, "admin-session-id=inst");
});

test("auth: the web cookie does not satisfy an instance endpoint, nor the admin cookie a workspace one", async () => {
  strictEqual((await h.call("GET", "/instance/settings", { cookie: ADM })).status, 401);
  strictEqual((await h.call("GET", "/workspaces/acme/mappings", { cookie: INST })).status, 401);
});

test("auth: a cookie named like the real one but longer (xsession-id) is ignored", async () => {
  strictEqual((await h.call("GET", "/workspaces/acme/mappings", { cookie: "xsession-id=adm" })).status, 401);
});

test("auth: a demoted admin fails the very next write; no result is cached", async () => {
  h.plane.roles["u-adm"]!.acme = 20;
  strictEqual((await h.call("GET", "/workspaces/acme/mappings", { cookie: ADM })).status, 200);
  h.plane.roles["u-adm"]!.acme = 15;
  strictEqual((await h.call("GET", "/workspaces/acme/mappings", { cookie: ADM })).status, 403);
  strictEqual((await h.call("POST", "/workspaces/acme/mappings", { cookie: ADM, body: MAPPING })).status, 403);
  h.plane.roles["u-adm"]!.acme = 20;
  strictEqual((await h.call("GET", "/workspaces/acme/mappings", { cookie: ADM })).status, 200);
});

test("auth: an admin of one workspace is 403 in a workspace where they are a member", async () => {
  strictEqual((await h.call("GET", "/workspaces/other/mappings", { cookie: ADM })).status, 403);
});

test("S2: an admin in a reissued workspace cannot inherit the former workspace's data", async () => {
  strictEqual((await h.call("GET", "/workspaces/acme/mappings", { cookie: ADM })).status, 200);
  h.plane.workspaceIds.acme = "replacement-workspace-id";
  try {
    strictEqual((await h.call("GET", "/workspaces/acme/mappings", { cookie: ADM })).status, 409);
    strictEqual((await h.call("POST", "/workspaces/acme/mappings", { cookie: ADM, body: MAPPING })).status, 409);
    strictEqual((await h.db.query<any>("SELECT plane_workspace_id FROM workspace_identity WHERE workspace_slug = 'acme'")).rows[0].plane_workspace_id, "ws-id-acme");
    strictEqual(await h.count("repo_mappings"), 0);
  } finally { delete h.plane.workspaceIds.acme; }
  strictEqual((await h.call("GET", "/workspaces/acme/mappings", { cookie: ADM })).status, 200);
});

test("auth: a Plane outage is 502, never a pass", async () => {
  h.plane.state.unavailable = true;
  try {
    strictEqual((await h.call("GET", "/workspaces/acme/mappings", { cookie: ADM })).status, 502);
    strictEqual((await h.call("GET", "/instance/settings", { cookie: INST })).status, 502);
  } finally { h.plane.state.unavailable = false; }
});

test("auth: an unusable slug is 404 without calling Plane", async () => {
  h.plane.calls.length = 0;
  strictEqual((await h.call("GET", "/workspaces/a%20b/mappings", { cookie: ADM })).status, 404);
  strictEqual(h.plane.calls.length, 0);
});

test("csrf: a missing or foreign Origin is 403, even for DELETE without a body", async () => {
  strictEqual((await h.call("POST", "/workspaces/acme/mappings", { cookie: ADM, body: MAPPING, origin: null })).status, 403);
  strictEqual((await h.call("POST", "/workspaces/acme/mappings", { cookie: ADM, body: MAPPING, origin: "https://evil.example" })).status, 403);
  strictEqual((await h.call("POST", "/workspaces/acme/mappings", { cookie: ADM, body: MAPPING, origin: ORIGIN + ".evil.example" })).status, 403);
  strictEqual((await h.call("DELETE", "/workspaces/acme/mappings/1", { cookie: ADM, origin: "https://evil.example" })).status, 403);
  strictEqual(await h.count("repo_mappings"), 0);
});

test("csrf: a body that is not application/json is 415; a charset parameter is accepted", async () => {
  strictEqual((await h.call("POST", "/workspaces/acme/mappings", { cookie: ADM, body: "a=b", type: "application/x-www-form-urlencoded" })).status, 415);
  strictEqual((await h.call("POST", "/workspaces/acme/mappings", { cookie: ADM, body: JSON.stringify(MAPPING), type: "text/plain" })).status, 415);
  const ok201 = await h.call("POST", "/workspaces/acme/mappings", { cookie: ADM, body: MAPPING, type: "application/json; charset=utf-8" });
  strictEqual(ok201.status, 201);
  strictEqual(await h.count("repo_mappings"), 1);
});

test("csrf: GET does not need an Origin", async () => {
  strictEqual((await h.call("GET", "/workspaces/acme/mappings", { cookie: ADM, origin: null })).status, 200);
});

test("body: over 1 MiB is 413, malformed JSON is 400, a non-object is 422", async () => {
  const big = JSON.stringify({ ...MAPPING, ghRepoFullName: "a/" + "b".repeat(1024 * 1024) });
  strictEqual((await h.call("POST", "/workspaces/acme/mappings", { cookie: ADM, body: big })).status, 413);
  strictEqual((await h.call("POST", "/workspaces/acme/mappings", { cookie: ADM, body: "{nope" })).status, 400);
  strictEqual((await h.call("POST", "/workspaces/acme/mappings", { cookie: ADM, body: "[1]" })).status, 422);
});

test("instance: needs the admin-app session; a bad one is 401", async () => {
  strictEqual((await h.call("GET", "/instance/github-app")).status, 401);
  strictEqual((await h.call("GET", "/instance/github-app", { cookie: "admin-session-id=nope" })).status, 401);
  strictEqual((await h.call("GET", "/instance/github-app", { cookie: INST })).status, 200);
});
