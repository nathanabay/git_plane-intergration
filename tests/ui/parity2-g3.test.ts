// Parity wave 2, G3: C1 connect (install callback, owner handoff, claim), C2 personal GitHub accounts (state, PKCE,
// exchange, refresh under the lock, re-authorization, disconnect), C3 user-scoped repositories and the save-time
// re-check, and attribution through the user token in GithubWritePath.
import test, { afterEach } from "node:test";
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../../src/db/migrate.ts";
import { addUserLinkTombstone } from "../../src/db/ledgers.ts";
import { getGithubOAuthToken, putGithubOAuthToken } from "../../src/db/parity.ts";
import { decryptSecret, encryptSecret } from "../../src/auth/identity.ts";
import { GithubUserTokens, createPkcePair, loadGithubOAuthApp } from "../../src/auth/github-user.ts";
import {
  ClaimRefused, assertRepositoryPickable, claimInstallation, createOwnerHandoff, getConnection, handleInstallCallback,
  listClaimableInstallations, listPickableRepositories, startInstall,
} from "../../src/ui/install-flow.ts";
import type { Authenticate, ConnectDeps } from "../../src/ui/install-flow.ts";
import {
  authenticateWorkspaceMember, disconnectPersonalAccount, getPersonalLink, handleOAuthCallback, revokePersonalGrant, startGithubAuthorization,
} from "../../src/ui/oauth-flow.ts";
import { GithubWritePath } from "../../src/sync/github.ts";
import { HttpError } from "../../src/ui/http.ts";

const databases: PGlite[] = [];
afterEach(async () => { for (const db of databases.splice(0)) await db.close(); });

const ADMIN = { id: "u-admin", email: "admin@example.com" };
const MEMBER = { id: "u-member", email: "member@example.com" };
const ORIGIN = "https://tasks.example";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const TRIAGE = { admin: false, maintain: false, push: false, triage: true, pull: true };
const READ_ONLY = { admin: false, maintain: false, push: false, triage: false, pull: true };
const ACME_ID = 9100;
const MEMBER_ROLE = { state: "active", role: "member", organization: { id: ACME_ID, login: "acme" } };

interface GithubFake {
  user: { id: number; login: string };
  /** GET /user by bearer token; the default `user` otherwise. */
  usersByToken: Record<string, { id: number; login: string }>;
  /** GET /user/memberships/orgs/{org}: key `<token>|<org>` first, then `<org>`; "forbidden" → 403; missing → 404. */
  memberships: Record<string, { state: string; role: string; organization: { id: number; login: string } } | "forbidden">;
  installations: { id: number; account: { id: number; login: string; type: string; avatar_url: string } }[];
  repos: Record<number, { id: number; full_name: string; private: boolean; permissions?: Record<string, boolean> }[] | "forbidden">;
  tokenReplies: (() => Response)[];
  tokenBodies: any[];
  revokeStatus: number;
  revocations: { auth: string | null; body: any }[];
  userCalls: { url: string; auth: string | null }[];
}

function githubFake(): GithubFake & { fetch: typeof fetch } {
  const f: GithubFake = {
    user: { id: 77, login: "Octo" },
    usersByToken: {},
    memberships: { acme: { state: "active", role: "admin", organization: { id: ACME_ID, login: "acme" } } },
    installations: [{ id: 501, account: { id: ACME_ID, login: "acme", type: "Organization", avatar_url: "https://avatars.example/acme" } }],
    repos: { 501: [{ id: 9001, full_name: "acme/web", private: false, permissions: TRIAGE }] },
    tokenReplies: [], tokenBodies: [], userCalls: [], revokeStatus: 204, revocations: [],
  };
  const fetchFake = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.href === "https://github.com/login/oauth/access_token") {
      f.tokenBodies.push(JSON.parse(String(init?.body)));
      const reply = f.tokenReplies.shift();
      return reply ? reply() : json(200, { error: "bad_verification_code" });
    }
    const headers = new Headers(init?.headers);
    if (init?.method === "DELETE" && url.href === "https://api.github.com/applications/Iv1.client/grant") {
      f.revocations.push({ auth: headers.get("authorization"), body: JSON.parse(String(init.body)) });
      return new Response(null, { status: f.revokeStatus });
    }
    f.userCalls.push({ url: url.href, auth: headers.get("authorization") });
    if (url.origin !== "https://api.github.com") return json(404, {});
    const token = (headers.get("authorization") ?? "").replace(/^Bearer /, "");
    if (url.pathname === "/user") return json(200, f.usersByToken[token] ?? f.user);
    const org = /^\/user\/memberships\/orgs\/([^/]+)$/.exec(url.pathname);
    if (org) {
      const m = f.memberships[`${token}|${org[1]}`] ?? f.memberships[org[1]!];
      return m === "forbidden" ? json(403, { message: "blocked" }) : m ? json(200, m) : json(404, { message: "Not Found" });
    }
    const page = Number(url.searchParams.get("page") ?? "1"), per = Number(url.searchParams.get("per_page") ?? "30");
    if (url.pathname === "/user/installations") {
      return json(200, { total_count: f.installations.length, installations: f.installations.slice((page - 1) * per, page * per) });
    }
    const m = /^\/user\/installations\/(\d+)\/repositories$/.exec(url.pathname);
    if (m) {
      const repos = f.repos[Number(m[1])];
      if (!repos || repos === "forbidden") return json(404, { message: "Not Found" });
      return json(200, { total_count: repos.length, repositories: repos.slice((page - 1) * per, page * per) });
    }
    return json(404, {});
  }) as unknown as typeof fetch;
  return Object.assign(f, { fetch: fetchFake });
}

async function setup(opts: { appSlug?: string | null; clientId?: string | null } = {}) {
  const db = new PGlite();
  databases.push(db);
  await db.waitReady;
  await migrate(db);
  const gh = githubFake();
  const appCalls: { route: string; params: any }[] = [];
  const refreshed: number[] = [];
  let pending: unknown[] | Error = [];
  const tokenKey = randomBytes(32);
  const deps: ConnectDeps = {
    db, tokenKey, publicOrigin: ORIGIN,
    config: {
      ...(opts.clientId === null ? {} : { GITHUB_CLIENT_ID: opts.clientId ?? "Iv1.client", GITHUB_CLIENT_SECRET: "client-secret" }),
      ...(opts.appSlug === null ? {} : { GITHUB_APP_SLUG: opts.appSlug ?? "gitsync-test" }),
    },
    appRequest: async (route, params) => {
      appCalls.push({ route, params });
      if (route === "GET /app/installation-requests") { if (pending instanceof Error) throw pending; return { data: params.page === 1 ? pending : [] }; }
      if (route === "GET /app/installations/{installation_id}") {
        const i = gh.installations.find((x) => x.id === params.installation_id);
        return { data: { id: params.installation_id, account: i?.account ?? { login: "someone", type: "User", avatar_url: null }, html_url: `https://github.com/organizations/x/settings/installations/${params.installation_id}` } };
      }
      throw new Error(`unexpected ${route}`);
    },
    refreshInstallation: async (id) => { refreshed.push(id); },
    fetch: gh.fetch,
  };
  return { db, deps, gh, appCalls, refreshed, tokenKey, setPending: (p: unknown[] | Error) => { pending = p; } };
}

const asAuth = (viewer: { id: string; email: string } | null, levels: ("admin" | "member")[] = ["admin", "member"]): Authenticate =>
  async (_slug, level) => {
    if (!viewer || !levels.includes(level)) throw new HttpError(403, "no");
    return viewer;
  };

const stateOf = (url: string) => new URL(url).searchParams.get("state")!;
const query = (q: Record<string, string>) => new URLSearchParams(q);

/** Links `viewer` through the real OAuth flow (authorize URL → callback with a code). */
async function link(s: Awaited<ReturnType<typeof setup>>, viewer = ADMIN, tokens: Record<string, unknown> = {}) {
  const { authorizeUrl } = await startGithubAuthorization(s.deps, { slug: "ws", viewer });
  s.gh.tokenReplies.push(() => json(200, { access_token: "ghu_access", expires_in: 28800, refresh_token: "ghr_refresh", refresh_token_expires_in: 15897600, token_type: "bearer", scope: "", ...tokens }));
  return handleOAuthCallback(s.deps, { query: query({ code: "the-code", state: stateOf(authorizeUrl) }), authenticate: asAuth(viewer) });
}

// ---- C2: authorization, exchange, link ---------------------------------------------------------------------
test("C2: the authorize URL carries client_id, the service callback, a single-use state and an S256 PKCE challenge", async () => {
  const s = await setup();
  const { authorizeUrl } = await startGithubAuthorization(s.deps, { slug: "ws", viewer: MEMBER });
  const u = new URL(authorizeUrl);
  strictEqual(u.origin + u.pathname, "https://github.com/login/oauth/authorize");
  strictEqual(u.searchParams.get("client_id"), "Iv1.client");
  strictEqual(u.searchParams.get("redirect_uri"), `${ORIGIN}/git-sync/oauth/github/callback`);
  strictEqual(u.searchParams.get("code_challenge_method"), "S256");
  const row = (await s.db.query<any>("SELECT purpose, workspace_slug, plane_user_id, pkce_verifier_v1, nonce_hash FROM oauth_states")).rows[0];
  strictEqual(row.purpose, "oauth");
  strictEqual(row.plane_user_id, MEMBER.id);
  strictEqual(row.nonce_hash, createHash("sha256").update(u.searchParams.get("state")!).digest("hex"), "only the nonce hash is stored");
  const verifier = decryptSecret(row.pkce_verifier_v1, s.tokenKey);
  strictEqual(u.searchParams.get("code_challenge"), createHash("sha256").update(verifier).digest("base64url"));
});

test("C2: createPkcePair makes a 43-character verifier whose challenge is its base64url SHA-256", () => {
  const p = createPkcePair();
  strictEqual(p.verifier.length, 43);
  strictEqual(p.challenge, createHash("sha256").update(p.verifier).digest("base64url"));
  ok(createPkcePair().verifier !== p.verifier);
});

test("C2: the callback exchanges the code with the PKCE verifier, links by GitHub id, stores the tokens encrypted and lifts the tombstone", async () => {
  const s = await setup();
  await addUserLinkTombstone(s.db, "ws", 77);
  const r = await link(s, MEMBER);
  strictEqual(r.location, `${ORIGIN}/ws/settings/git-sync-account?github=linked`);
  const body = s.gh.tokenBodies[0];
  strictEqual(body.client_id, "Iv1.client");
  strictEqual(body.client_secret, "client-secret");
  strictEqual(body.code, "the-code");
  strictEqual(body.redirect_uri, `${ORIGIN}/git-sync/oauth/github/callback`);
  strictEqual(createHash("sha256").update(body.code_verifier).digest("base64url").length, 43);
  deepStrictEqual((await s.db.query("SELECT plane_user_id, gh_login, gh_id FROM user_map")).rows, [{ plane_user_id: MEMBER.id, gh_login: "Octo", gh_id: 77 }]);
  strictEqual((await s.db.query("SELECT 1 FROM user_link_tombstones")).rows.length, 0);
  const t = (await getGithubOAuthToken(s.db, MEMBER.id))!;
  ok(t.accessCiphertext !== "ghu_access" && decryptSecret(t.accessCiphertext, s.tokenKey) === "ghu_access");
  strictEqual(decryptSecret(t.refreshCiphertext!, s.tokenKey), "ghr_refresh");
  ok(t.accessExpiresAt && t.refreshExpiresAt && !t.needsReauth);
  strictEqual(s.gh.userCalls.find((c) => c.url.endsWith("/user"))?.auth, "Bearer ghu_access");
  deepStrictEqual(await getPersonalLink(s.deps, { slug: "ws", viewer: MEMBER }),
    { appConfigured: true, linked: true, githubLogin: "Octo", githubId: 77, needsReauth: false, tokenStored: true });
});

test("C2: a replayed, expired, unknown or foreign state is refused, and a denied authorization stores nothing", async () => {
  const s = await setup();
  const first = await startGithubAuthorization(s.deps, { slug: "ws", viewer: MEMBER });
  s.gh.tokenReplies.push(() => json(200, { access_token: "ghu_a" }));
  strictEqual((await handleOAuthCallback(s.deps, { query: query({ code: "c", state: stateOf(first.authorizeUrl) }), authenticate: asAuth(MEMBER) })).location,
    `${ORIGIN}/ws/settings/git-sync-account?github=linked`);
  // Replay of the same state.
  strictEqual((await handleOAuthCallback(s.deps, { query: query({ code: "c", state: stateOf(first.authorizeUrl) }), authenticate: asAuth(MEMBER) })).location,
    `${ORIGIN}/?github=error&reason=state`);
  // Unknown state.
  strictEqual((await handleOAuthCallback(s.deps, { query: query({ code: "c", state: "forged" }), authenticate: asAuth(MEMBER) })).location,
    `${ORIGIN}/?github=error&reason=state`);
  // Expired state.
  const expired = await startGithubAuthorization(s.deps, { slug: "ws", viewer: MEMBER });
  await s.db.query("UPDATE oauth_states SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE consumed_at IS NULL");
  strictEqual((await handleOAuthCallback(s.deps, { query: query({ code: "c", state: stateOf(expired.authorizeUrl) }), authenticate: asAuth(MEMBER) })).location,
    `${ORIGIN}/?github=error&reason=state`);
  // Another Plane user's browser carrying this user's state.
  const foreign = await startGithubAuthorization(s.deps, { slug: "ws", viewer: MEMBER });
  strictEqual((await handleOAuthCallback(s.deps, { query: query({ code: "c", state: stateOf(foreign.authorizeUrl) }), authenticate: asAuth(ADMIN) })).location,
    `${ORIGIN}/ws/settings/git-sync-account?github=error&reason=state`);
  // GitHub's error=access_denied.
  const denied = await startGithubAuthorization(s.deps, { slug: "ws", viewer: ADMIN });
  strictEqual((await handleOAuthCallback(s.deps, { query: query({ error: "access_denied", state: stateOf(denied.authorizeUrl) }), authenticate: asAuth(ADMIN) })).location,
    `${ORIGIN}/ws/settings/git-sync-account?github=error&reason=denied`);
  strictEqual(await getGithubOAuthToken(s.db, ADMIN.id), null);
  strictEqual(s.gh.tokenBodies.length, 1, "only the first, valid state reached GitHub");
});

test("C2: a failed code exchange and an account linked to another Plane user store nothing", async () => {
  const s = await setup();
  const bad = await startGithubAuthorization(s.deps, { slug: "ws", viewer: MEMBER });
  s.gh.tokenReplies.push(() => json(200, { error: "bad_verification_code" }));
  strictEqual((await handleOAuthCallback(s.deps, { query: query({ code: "c", state: stateOf(bad.authorizeUrl) }), authenticate: asAuth(MEMBER) })).location,
    `${ORIGIN}/ws/settings/git-sync-account?github=error&reason=exchange`);
  await s.db.query("INSERT INTO user_map (workspace_slug, plane_user_id, gh_login, gh_id) VALUES ('ws', 'u-other', 'Octo', 77)");
  strictEqual((await link(s, MEMBER)).location, `${ORIGIN}/ws/settings/git-sync-account?github=error&reason=already_linked`);
  strictEqual(await getGithubOAuthToken(s.db, MEMBER.id), null, "the link transaction rolled back the token too");
});

test("C2: without a client id and secret the flow says the App is not configured", async () => {
  const s = await setup({ clientId: null });
  strictEqual(await loadGithubOAuthApp(s.db, s.tokenKey, s.deps.config), null);
  await rejects(startGithubAuthorization(s.deps, { slug: "ws", viewer: MEMBER }), (e: unknown) => e instanceof HttpError && e.status === 409);
});

// ---- C2: refresh, re-authorization, disconnect --------------------------------------------------------------
async function storedToken(s: Awaited<ReturnType<typeof setup>>, user: string, o: { accessExpired?: boolean; refreshExpired?: boolean; refresh?: string | null } = {}) {
  await putGithubOAuthToken(s.db, user, {
    accessCiphertext: encryptSecret("ghu_old", s.tokenKey),
    refreshCiphertext: o.refresh === null ? null : encryptSecret(o.refresh ?? "ghr_old", s.tokenKey),
    accessExpiresAt: new Date(Date.now() + (o.accessExpired ? -60_000 : 3_600_000)),
    refreshExpiresAt: new Date(Date.now() + (o.refreshExpired ? -60_000 : 86_400_000)),
  });
}
const tokensOf = (s: Awaited<ReturnType<typeof setup>>) =>
  new GithubUserTokens({ db: s.db, tokenKey: s.tokenKey, app: () => loadGithubOAuthApp(s.db, s.tokenKey, s.deps.config), fetch: s.deps.fetch! });

test("C2: a fresh token is used as is; an expiring one is refreshed once, rotating the refresh token, even with two callers", async () => {
  const s = await setup();
  await storedToken(s, MEMBER.id);
  strictEqual((await tokensOf(s).accessToken(MEMBER.id))?.reveal(), "ghu_old");
  strictEqual(s.gh.tokenBodies.length, 0);
  await storedToken(s, MEMBER.id, { accessExpired: true });
  s.gh.tokenReplies.push(() => json(200, { access_token: "ghu_new", expires_in: 28800, refresh_token: "ghr_new", refresh_token_expires_in: 15897600 }));
  const [a, b] = await Promise.all([tokensOf(s).accessToken(MEMBER.id), tokensOf(s).accessToken(MEMBER.id)]);
  strictEqual(a?.reveal(), "ghu_new");
  strictEqual(b?.reveal(), "ghu_new");
  strictEqual(s.gh.tokenBodies.length, 1, "the waiter used the winner's token instead of refreshing again");
  deepStrictEqual({ grant: s.gh.tokenBodies[0].grant_type, refresh: s.gh.tokenBodies[0].refresh_token }, { grant: "refresh_token", refresh: "ghr_old" });
  const t = (await getGithubOAuthToken(s.db, MEMBER.id))!;
  strictEqual(decryptSecret(t.refreshCiphertext!, s.tokenKey), "ghr_new");
});

test("C2: a refused refresh marks the link for re-authorization; a transient failure keeps it; both fall back to the service identity", async () => {
  const s = await setup();
  await storedToken(s, MEMBER.id, { accessExpired: true });
  s.gh.tokenReplies.push(() => json(502, {}));
  strictEqual(await tokensOf(s).accessToken(MEMBER.id), null);
  strictEqual((await getGithubOAuthToken(s.db, MEMBER.id))!.needsReauth, false);
  s.gh.tokenReplies.push(() => json(200, { error: "bad_refresh_token" }));
  strictEqual(await tokensOf(s).accessToken(MEMBER.id), null);
  strictEqual((await getGithubOAuthToken(s.db, MEMBER.id))!.needsReauth, true);
  strictEqual(await tokensOf(s).accessToken(MEMBER.id), null, "needs_reauth is not retried");
  strictEqual(s.gh.tokenBodies.length, 2);
  strictEqual((await getPersonalLink(s.deps, { slug: "ws", viewer: MEMBER })).needsReauth, true);
  // An expired refresh token needs re-authorization without asking GitHub.
  await storedToken(s, ADMIN.id, { accessExpired: true, refreshExpired: true });
  strictEqual(await tokensOf(s).accessToken(ADMIN.id), null);
  strictEqual((await getGithubOAuthToken(s.db, ADMIN.id))!.needsReauth, true);
  strictEqual(s.gh.tokenBodies.length, 2);
  // Reconnect clears it.
  await link(s, MEMBER);
  strictEqual((await getGithubOAuthToken(s.db, MEMBER.id))!.needsReauth, false);
});

test("C2: disconnect revokes the grant on GitHub, deletes the tokens and the link and writes the tombstone; a second disconnect is 404", async () => {
  const s = await setup();
  await link(s, MEMBER);
  await disconnectPersonalAccount(s.deps, { slug: "ws", viewer: MEMBER });
  deepStrictEqual(s.gh.revocations, [{ auth: `Basic ${Buffer.from("Iv1.client:client-secret").toString("base64")}`, body: { access_token: "ghu_access" } }]);
  strictEqual((await s.db.query("SELECT 1 FROM audit_log WHERE kind = 'github_grant_revoke_failed'")).rows.length, 0);
  strictEqual((await s.db.query("SELECT 1 FROM user_map")).rows.length, 0);
  strictEqual(await getGithubOAuthToken(s.db, MEMBER.id), null);
  deepStrictEqual((await s.db.query("SELECT workspace_slug, gh_id FROM user_link_tombstones")).rows, [{ workspace_slug: "ws", gh_id: 77 }]);
  await rejects(disconnectPersonalAccount(s.deps, { slug: "ws", viewer: MEMBER }), (e: unknown) => e instanceof HttpError && e.status === 404);
  strictEqual(s.gh.revocations.length, 1, "nothing linked: GitHub is not asked again");
});

test("C2: a failed revocation is audited without the token and never blocks the local disconnect", async () => {
  const s = await setup();
  await link(s, MEMBER);
  s.gh.revokeStatus = 422;
  await disconnectPersonalAccount(s.deps, { slug: "ws", viewer: MEMBER });
  strictEqual(await getGithubOAuthToken(s.db, MEMBER.id), null);
  strictEqual((await s.db.query("SELECT 1 FROM user_map")).rows.length, 0);
  const audit = (await s.db.query<any>("SELECT workspace_slug, outcome, error, detail FROM audit_log WHERE kind = 'github_grant_revoke_failed'")).rows;
  strictEqual(audit.length, 1);
  deepStrictEqual([audit[0].workspace_slug, audit[0].outcome, audit[0].detail], ["ws", "failed", { planeUserId: MEMBER.id }]);
  ok(!JSON.stringify(audit).includes("ghu_access"), "the token never reaches the audit log");
});

test("C2: a link that needs re-authorization still revokes with the stored token", async () => {
  const s = await setup();
  await link(s, MEMBER);
  await s.db.query("UPDATE user_tokens SET needs_reauth = true");
  await disconnectPersonalAccount(s.deps, { slug: "ws", viewer: MEMBER });
  deepStrictEqual(s.gh.revocations.map((r) => r.body), [{ access_token: "ghu_access" }]);
});

// ---- C1: install, callback, handoff, claim ------------------------------------------------------------------
test("C1: Connect builds the App's install URL with a single-use install state; without an app slug it is refused", async () => {
  const s = await setup();
  const { installUrl } = await startInstall(s.deps, { slug: "ws", viewer: ADMIN });
  const u = new URL(installUrl);
  strictEqual(u.origin + u.pathname, "https://github.com/apps/gitsync-test/installations/new");
  ok(u.searchParams.get("state"));
  strictEqual((await s.db.query<any>("SELECT purpose FROM oauth_states")).rows[0].purpose, "install");
  const handoff = await createOwnerHandoff(s.deps, { slug: "ws", viewer: ADMIN, accountId: ACME_ID });
  ok(Date.parse(handoff.expiresAt) - Date.now() > 6 * 24 * 3600 * 1000, "the owner link lasts days, not minutes");
  const noSlug = await setup({ appSlug: null });
  await rejects(startInstall(noSlug.deps, { slug: "ws", viewer: ADMIN }), (e: unknown) => e instanceof HttpError && e.status === 409);
});

test("C1: the callback allow-lists an installation that is the admin's, and refuses a forged installation id", async () => {
  const s = await setup();
  await link(s, ADMIN);
  const forged = await startInstall(s.deps, { slug: "ws", viewer: ADMIN });
  strictEqual((await handleInstallCallback(s.deps, { query: query({ installation_id: "999", setup_action: "install", state: stateOf(forged.installUrl) }), authenticate: asAuth(ADMIN) })).location,
    `${ORIGIN}/ws/settings/git-sync?connect=error&reason=not_yours`);
  strictEqual((await s.db.query("SELECT 1 FROM workspace_installations")).rows.length, 0);
  const real = await startInstall(s.deps, { slug: "ws", viewer: ADMIN });
  strictEqual((await handleInstallCallback(s.deps, { query: query({ installation_id: "501", setup_action: "install", state: stateOf(real.installUrl) }), authenticate: asAuth(ADMIN) })).location,
    `${ORIGIN}/ws/settings/git-sync?connect=ok`);
  deepStrictEqual((await s.db.query("SELECT installation_id, workspace_slug, account_login FROM workspace_installations")).rows,
    [{ installation_id: 501, workspace_slug: "ws", account_login: "acme" }]);
  deepStrictEqual(s.refreshed, [501]);
  // The same state cannot be used again.
  strictEqual((await handleInstallCallback(s.deps, { query: query({ installation_id: "501", state: stateOf(real.installUrl) }), authenticate: asAuth(ADMIN) })).location,
    `${ORIGIN}/?connect=error&reason=state`);
});

test("C1: an installation connected to another workspace is refused", async () => {
  const s = await setup();
  await link(s, ADMIN);
  await s.db.query("INSERT INTO workspace_installations (installation_id, workspace_slug, account_login) VALUES (501, 'other', 'acme')");
  const st = await startInstall(s.deps, { slug: "ws", viewer: ADMIN });
  strictEqual((await handleInstallCallback(s.deps, { query: query({ installation_id: "501", state: stateOf(st.installUrl) }), authenticate: asAuth(ADMIN) })).location,
    `${ORIGIN}/ws/settings/git-sync?connect=error&reason=taken`);
  deepStrictEqual((await s.db.query("SELECT workspace_slug FROM workspace_installations")).rows, [{ workspace_slug: "other" }]);
});

test("C1: without a personal token the callback chains into the GitHub authorization, whose callback claims the installation", async () => {
  const s = await setup();
  const st = await startInstall(s.deps, { slug: "ws", viewer: ADMIN });
  const r = await handleInstallCallback(s.deps, { query: query({ installation_id: "501", state: stateOf(st.installUrl) }), authenticate: asAuth(ADMIN) });
  ok(r.location.startsWith("https://github.com/login/oauth/authorize?"));
  strictEqual((await s.db.query<any>("SELECT installation_id FROM oauth_states WHERE purpose = 'oauth'")).rows[0].installation_id, 501);
  s.gh.tokenReplies.push(() => json(200, { access_token: "ghu_admin", expires_in: 28800, refresh_token: "ghr_admin" }));
  const done = await handleOAuthCallback(s.deps, { query: query({ code: "c", state: stateOf(r.location) }), authenticate: asAuth(ADMIN) });
  strictEqual(done.location, `${ORIGIN}/ws/settings/git-sync?connect=ok`);
  strictEqual((await s.db.query("SELECT 1 FROM workspace_installations WHERE installation_id = 501 AND workspace_slug = 'ws'")).rows.length, 1);
});

test("C1: the chained authorization needs a workspace admin, not just a member", async () => {
  const s = await setup();
  const st = await startInstall(s.deps, { slug: "ws", viewer: ADMIN });
  const r = await handleInstallCallback(s.deps, { query: query({ installation_id: "501", state: stateOf(st.installUrl) }), authenticate: asAuth(ADMIN) });
  s.gh.tokenReplies.push(() => json(200, { access_token: "ghu_admin" }));
  const done = await handleOAuthCallback(s.deps, { query: query({ code: "c", state: stateOf(r.location) }), authenticate: asAuth(ADMIN, ["member"]) });
  strictEqual(done.location, `${ORIGIN}/ws/settings/git-sync?connect=error&reason=state`);
  strictEqual((await s.db.query("SELECT 1 FROM workspace_installations")).rows.length, 0);
});

test("C1: an admin who already has a token and owns the org claims from the claimable list; a forged id is refused", async () => {
  const s = await setup();
  await rejects(claimInstallation(s.deps, { slug: "ws", viewer: ADMIN, installationId: 501 }), (e: unknown) => e instanceof HttpError && e.status === 409);
  deepStrictEqual(await listClaimableInstallations(s.deps, { slug: "ws", viewer: ADMIN }), { needsGithubAccount: true, needsReauth: false, installations: [] });
  await link(s, ADMIN);
  deepStrictEqual((await listClaimableInstallations(s.deps, { slug: "ws", viewer: ADMIN })).installations,
    [{ installationId: 501, accountId: ACME_ID, accountLogin: "acme", avatarUrl: "https://avatars.example/acme", allowedForWorkspace: null, canClaim: true }]);
  strictEqual((await claimInstallation(s.deps, { slug: "ws", viewer: ADMIN, installationId: 501 })).accountLogin, "acme");
  await rejects(claimInstallation(s.deps, { slug: "ws", viewer: ADMIN, installationId: 777 }), (e: unknown) => e instanceof ClaimRefused && e.reason === "not_yours");
  strictEqual((await listClaimableInstallations(s.deps, { slug: "ws", viewer: ADMIN })).installations[0]!.allowedForWorkspace, "ws");
});

test("C1: setup_action=update for this workspace's installation re-runs verification", async () => {
  const s = await setup();
  await s.db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (501, 'ws')");
  const st = await startInstall(s.deps, { slug: "ws", viewer: ADMIN });
  strictEqual((await handleInstallCallback(s.deps, { query: query({ installation_id: "501", setup_action: "update", state: stateOf(st.installUrl) }), authenticate: asAuth(ADMIN) })).location,
    `${ORIGIN}/ws/settings/git-sync?connect=updated`);
  deepStrictEqual(s.refreshed, [501]);
});

test("C1: the connection view lists the org and only the pending requests the viewer made; it survives a failing requests call", async () => {
  const s = await setup();
  await s.db.query("INSERT INTO workspace_installations (installation_id, workspace_slug, account_login) VALUES (501, 'ws', 'acme')");
  s.setPending([
    { id: 3, account: { login: "bigco", avatar_url: "https://avatars.example/bigco" }, requester: { id: 77, login: "Octo" }, created_at: "2026-10-12T10:00:00Z" },
    { id: 4, account: { login: "elsewhere", avatar_url: null }, requester: { id: 99, login: "someone" }, created_at: "2026-10-12T11:00:00Z" },
  ]);
  const unlinked = await getConnection(s.deps, { slug: "ws", viewer: ADMIN });
  deepStrictEqual(unlinked.pendingRequests, [], "without a linked account no other workspace's requests are shown");
  strictEqual(unlinked.personal.linked, false);
  await link(s, ADMIN);
  const view = await getConnection(s.deps, { slug: "ws", viewer: ADMIN });
  strictEqual(view.appConfigured, true);
  deepStrictEqual(view.installations.map((i) => [i.installationId, i.accountLogin, i.avatarUrl]), [[501, "acme", "https://avatars.example/acme"]]);
  deepStrictEqual(view.pendingRequests, [{ id: 3, accountId: null, accountLogin: "bigco", accountAvatarUrl: "https://avatars.example/bigco", requesterLogin: "Octo", createdAt: "2026-10-12T10:00:00Z" }]);
  s.setPending(new Error("jwt"));
  deepStrictEqual((await getConnection(s.deps, { slug: "ws", viewer: ADMIN })).pendingRequests, []);
});

// Audit S7: an admin can write a user_map row for any public GitHub account without proving it, so the pending
// requests must follow the GitHub identity the viewer's own OAuth token proves, not that row.
test("S7: an admin-asserted link to someone else's GitHub id shows none of their pending requests", async () => {
  const s = await setup();
  s.setPending([{ id: 3, account: { login: "bigco", avatar_url: null }, requester: { id: 77, login: "Octo" }, created_at: "2026-10-12T10:00:00Z" }]);
  await s.db.query("INSERT INTO user_map (workspace_slug, plane_user_id, gh_login, gh_id) VALUES ('ws', $1, 'Octo', 77)", [ADMIN.id]);
  const asserted = await getConnection(s.deps, { slug: "ws", viewer: ADMIN });
  strictEqual(asserted.personal.linked, true);
  deepStrictEqual(asserted.pendingRequests, [], "no token proves the asserted identity");
  // Positive control: the same identity proven through OAuth shows the request.
  await link(s, ADMIN);
  deepStrictEqual((await getConnection(s.deps, { slug: "ws", viewer: ADMIN })).pendingRequests.map((r) => r.id), [3]);
});

// ---- C3 ---------------------------------------------------------------------------------------------------
test("C3: the picker follows every page of the user's repositories, skips inaccessible installations, and needs a linked account", async () => {
  const s = await setup();
  deepStrictEqual(await listPickableRepositories(s.deps, { slug: "ws", viewer: ADMIN }), { needsGithubAccount: true, needsReauth: false, repositories: [] });
  await rejects(assertRepositoryPickable(s.deps, { slug: "ws", viewer: ADMIN, ghRepoId: 9001 }), (e: unknown) => e instanceof HttpError && e.status === 409);
  await link(s, ADMIN);
  s.gh.repos[501] = Array.from({ length: 150 }, (_, i) => ({ id: 9001 + i, full_name: `acme/r${i}`, private: i % 2 === 0, permissions: TRIAGE }));
  s.gh.repos[502] = "forbidden";
  await s.db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (501, 'ws'), (502, 'ws'), (503, 'other')");
  const list = await listPickableRepositories(s.deps, { slug: "ws", viewer: ADMIN });
  strictEqual(list.repositories.length, 150);
  ok(list.repositories.every((r) => r.installationId === 501));
  ok(s.gh.userCalls.some((c) => c.url.includes("/user/installations/501/repositories") && c.url.includes("page=2")));
  await rejects(listPickableRepositories(s.deps, { slug: "ws", viewer: ADMIN, installationId: 503 }), (e: unknown) => e instanceof HttpError && e.status === 404);
});

test("C3: the save-time re-check accepts a repository in the user's list and refuses a forged one", async () => {
  const s = await setup();
  await link(s, ADMIN);
  await s.db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (501, 'ws')");
  strictEqual((await assertRepositoryPickable(s.deps, { slug: "ws", viewer: ADMIN, ghRepoId: 9001 })).fullName, "acme/web");
  await rejects(assertRepositoryPickable(s.deps, { slug: "ws", viewer: ADMIN, ghRepoId: 4242 }), (e: unknown) => e instanceof HttpError && e.status === 403);
  await s.db.query("UPDATE user_tokens SET needs_reauth = true");
  await rejects(assertRepositoryPickable(s.deps, { slug: "ws", viewer: ADMIN, ghRepoId: 9001 }), (e: unknown) => e instanceof HttpError && e.status === 409);
});

// ---- attribution ----------------------------------------------------------------------------------------
function writePath(s: Awaited<ReturnType<typeof setup>>, user: { request: (route: string, params: any) => Promise<any> } | null) {
  const installation: { route: string; params: any }[] = [], rejected: string[] = [];
  const path = new GithubWritePath({ db: s.db,
    app: { installationOctokit: async () => ({ request: async (route: string, params: any) => { installation.push({ route, params }); return { data: { id: 1 } }; } }) },
    userClient: async () => user, onUserTokenRejected: async (id) => { rejected.push(id); } });
  return { path, installation, rejected };
}
const comment = { kind: "comment" as const, installationId: 501, owner: "acme", repo: "web", repoId: 9001, number: 4, body: "hi" };

test("C2 attribution: a linked user's write goes out with their token; without asUser or a token the installation is used", async () => {
  const s = await setup();
  const userCalls: string[] = [];
  const w = writePath(s, { request: async (route) => { userCalls.push(route); return { data: { id: 2 } }; } });
  await w.path.apply({ ...comment, asUser: MEMBER.id });
  deepStrictEqual(userCalls, ["POST /repos/{owner}/{repo}/issues/{issue_number}/comments"]);
  strictEqual(w.installation.length, 0);
  await w.path.apply(comment);
  strictEqual(w.installation.length, 1);
  const none = writePath(s, null);
  await none.path.apply({ ...comment, asUser: MEMBER.id });
  strictEqual(none.installation.length, 1, "an unlinked user falls back to the service identity");
});

test("C2 attribution: a refused user token falls back to the installation (401 also asks for re-authorization); other errors propagate", async () => {
  const s = await setup();
  for (const status of [401, 403, 404]) {
    const w = writePath(s, { request: async () => { throw Object.assign(new Error("no"), { status }); } });
    await w.path.apply({ ...comment, asUser: MEMBER.id });
    strictEqual(w.installation.length, 1, `status ${status} falls back`);
    deepStrictEqual(w.rejected, status === 401 ? [MEMBER.id] : []);
  }
  const broken = writePath(s, { request: async () => { throw Object.assign(new Error("boom"), { status: 500 }); } });
  await rejects(broken.path.apply({ ...comment, asUser: MEMBER.id }), /boom/);
  strictEqual(broken.installation.length, 0, "a server error is retried by the outbox, not silently re-sent as the bot");
});

// ---- member authentication -----------------------------------------------------------------------------------
test("C2: members (role 15) may use the personal page; guests (role 5) may not", async () => {
  const planeFetch = (role: number) => (async (input: string | URL) => {
    const p = new URL(String(input)).pathname;
    if (p === "/api/users/me/") return json(200, { id: "u-1", email: "m@example.com" });
    if (p === "/api/workspaces/ws/workspace-members/me/") return json(200, { role });
    return json(404, {});
  }) as unknown as typeof fetch;
  const req = { headers: { cookie: "session-id=abc" } } as unknown as IncomingMessage;
  deepStrictEqual(await authenticateWorkspaceMember({ planeInternalUrl: "http://plane", fetch: planeFetch(15) }, req, "ws"), { id: "u-1", email: "m@example.com" });
  await rejects(authenticateWorkspaceMember({ planeInternalUrl: "http://plane", fetch: planeFetch(5) }, req, "ws"), (e: unknown) => e instanceof HttpError && e.status === 403);
  await rejects(authenticateWorkspaceMember({ planeInternalUrl: "http://plane", fetch: planeFetch(15) }, { headers: {} } as unknown as IncomingMessage, "ws"),
    (e: unknown) => e instanceof HttpError && e.status === 401);
});

// ---- W2d: the shared revocation used by self-service disconnect and the admin unlink route -------------------
test("C2: revokePersonalGrant revokes on GitHub and deletes the stored token, leaving the link to the caller", async () => {
  const s = await setup();
  await link(s, MEMBER);
  deepStrictEqual(await revokePersonalGrant(s.deps, MEMBER.id, "ws"), { revoked: true, tokenDeleted: true });
  deepStrictEqual(s.gh.revocations.map((r) => r.body), [{ access_token: "ghu_access" }]);
  strictEqual(await getGithubOAuthToken(s.db, MEMBER.id), null);
  strictEqual((await s.db.query("SELECT 1 FROM user_map")).rows.length, 1, "unlinking and the tombstone stay with the caller");
  deepStrictEqual(await revokePersonalGrant(s.deps, MEMBER.id, "ws"), { revoked: false, tokenDeleted: false });
  strictEqual(s.gh.revocations.length, 1, "nothing stored: GitHub is not asked");
});

test("C2: revokePersonalGrant audits a GitHub failure under the given workspace and still deletes locally", async () => {
  const s = await setup();
  await link(s, MEMBER);
  s.gh.revokeStatus = 500;
  deepStrictEqual(await revokePersonalGrant(s.deps, MEMBER.id, "ws-admin-view"), { revoked: false, tokenDeleted: true });
  strictEqual(await getGithubOAuthToken(s.db, MEMBER.id), null);
  const audit = (await s.db.query<any>("SELECT workspace_slug, detail FROM audit_log WHERE kind = 'github_grant_revoke_failed'")).rows;
  deepStrictEqual(audit, [{ workspace_slug: "ws-admin-view", detail: { planeUserId: MEMBER.id } }]);
});

// ---- security-audit self-review fixes ----------------------------------------------------------------------
test("security: a read-only collaborator can neither pick a repository nor claim the installation (capability growth)", async () => {
  const s = await setup();
  await link(s, ADMIN);
  await s.db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (501, 'ws')");
  s.gh.repos[501] = [{ id: 9001, full_name: "acme/web", private: false, permissions: TRIAGE }, { id: 9002, full_name: "acme/secret", private: true, permissions: READ_ONLY }];
  deepStrictEqual((await listPickableRepositories(s.deps, { slug: "ws", viewer: ADMIN })).repositories.map((r) => r.id), [9001]);
  await rejects(assertRepositoryPickable(s.deps, { slug: "ws", viewer: ADMIN, ghRepoId: 9002 }), (e: unknown) => e instanceof HttpError && e.status === 403);
  const other = await setup();
  await link(other, ADMIN);
  other.gh.memberships.acme = MEMBER_ROLE; // even with triage on every repository, a plain member cannot claim
  other.gh.repos[501] = [{ id: 9001, full_name: "acme/web", private: false, permissions: TRIAGE }];
  await rejects(claimInstallation(other.deps, { slug: "ws", viewer: ADMIN, installationId: 501 }), (e: unknown) => e instanceof ClaimRefused && e.reason === "not_owner");
  strictEqual((await listClaimableInstallations(other.deps, { slug: "ws", viewer: ADMIN })).installations[0]!.canClaim, false, "the UI can offer the hand-off instead");
  strictEqual((await other.db.query("SELECT 1 FROM workspace_installations")).rows.length, 0);
});

test("security: the claimable list does not reveal another workspace's slug", async () => {
  const s = await setup();
  await link(s, ADMIN);
  await s.db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (501, 'secret-team')");
  deepStrictEqual((await listClaimableInstallations(s.deps, { slug: "ws", viewer: ADMIN })).installations.map((i) => i.allowedForWorkspace), ["another workspace"]);
});

// ---- claiming needs an organization owner (user decision 2026-10-12) ---------------------------------------
test("CLAIM: only an active org admin (owner) may claim; members, billing managers, pending owners, outsiders and blocked checks get a clear 403", async () => {
  for (const [label, m] of [["member", MEMBER_ROLE], ["billing manager", { ...MEMBER_ROLE, role: "billing_manager" }],
    ["pending owner", { ...MEMBER_ROLE, state: "pending", role: "admin" }], ["not affiliated", undefined], ["App blocked", "forbidden"]] as const) {
    const s = await setup();
    await link(s, ADMIN);
    if (m === undefined) delete s.gh.memberships.acme; else s.gh.memberships.acme = m as any;
    await rejects(claimInstallation(s.deps, { slug: "ws", viewer: ADMIN, installationId: 501 }), (e: unknown) =>
      e instanceof ClaimRefused && e.status === 403 && e.reason === "not_owner" && /owner of the GitHub organization acme/.test(e.message) && /hand-off link/.test(e.message), label);
    strictEqual((await s.db.query("SELECT 1 FROM workspace_installations")).rows.length, 0, label);
  }
});

test("CLAIM: a personal-account installation can be claimed only by that person; other account types are refused", async () => {
  const mine = await setup();
  await link(mine, ADMIN);
  mine.gh.installations = [{ id: 601, account: { id: 77, login: "Octo", type: "User", avatar_url: "" } }];
  strictEqual((await claimInstallation(mine.deps, { slug: "ws", viewer: ADMIN, installationId: 601 })).installationId, 601);
  const theirs = await setup();
  await link(theirs, ADMIN);
  theirs.gh.installations = [{ id: 602, account: { id: 78, login: "someone", type: "User", avatar_url: "" } }];
  await rejects(claimInstallation(theirs.deps, { slug: "ws", viewer: ADMIN, installationId: 602 }), (e: unknown) => e instanceof ClaimRefused && e.reason === "not_owner");
  const ent = await setup();
  await link(ent, ADMIN);
  ent.gh.installations = [{ id: 603, account: { id: 5, login: "bigent", type: "Enterprise", avatar_url: "" } }];
  await rejects(claimInstallation(ent.deps, { slug: "ws", viewer: ADMIN, installationId: 603 }), (e: unknown) => e instanceof ClaimRefused && e.reason === "unsupported_account");
});

test("CLAIM: a non-owner admin's own install callback says an owner is needed", async () => {
  const s = await setup();
  await link(s, ADMIN);
  s.gh.memberships.acme = MEMBER_ROLE;
  const st = await startInstall(s.deps, { slug: "ws", viewer: ADMIN });
  strictEqual((await handleInstallCallback(s.deps, { query: query({ installation_id: "501", state: stateOf(st.installUrl) }), authenticate: asAuth(ADMIN) })).location,
    `${ORIGIN}/ws/settings/git-sync?connect=error&reason=not_owner`);
  // A Connect state carried by another session (not the admin who started it) is refused outright.
  const st2 = await startInstall(s.deps, { slug: "ws", viewer: ADMIN });
  strictEqual((await handleInstallCallback(s.deps, { query: query({ installation_id: "501", state: stateOf(st2.installUrl) }), authenticate: asAuth(MEMBER) })).location,
    `${ORIGIN}/ws/settings/git-sync?connect=error&reason=state`);
});

/** The hand-off approver: GitHub user 500 "boss" with their own token. */
function owner(s: Awaited<ReturnType<typeof setup>>, role: "admin" | "member" = "admin") {
  s.gh.usersByToken.ghu_owner = { id: 500, login: "boss" };
  s.gh.memberships["ghu_owner|acme"] = { ...MEMBER_ROLE, role };
  s.gh.tokenReplies.push(() => json(200, { access_token: "ghu_owner", expires_in: 28800, refresh_token: "ghr_owner" }));
}
const noPlaneSession: Authenticate = async () => { throw new HttpError(401, "no Plane session"); };

test("CLAIM hand-off: an org owner approving through the link proves ownership on GitHub and the workspace is connected, with nothing of theirs stored", async () => {
  const s = await setup();
  s.gh.memberships.acme = MEMBER_ROLE; // the admin who made the link is not an owner
  const { link: handoff } = await createOwnerHandoff(s.deps, { slug: "ws", viewer: ADMIN, accountId: ACME_ID });
  const toGithub = await handleInstallCallback(s.deps, { query: query({ installation_id: "501", setup_action: "install", state: stateOf(handoff) }), authenticate: noPlaneSession });
  ok(toGithub.location.startsWith("https://github.com/login/oauth/authorize?"), toGithub.location);
  strictEqual((await s.db.query<any>("SELECT plane_user_id, installation_id FROM oauth_states WHERE purpose = 'oauth'")).rows[0].plane_user_id, `handoff:${ADMIN.id}:${ACME_ID}`);
  owner(s);
  const done = await handleOAuthCallback(s.deps, { query: query({ code: "c", state: stateOf(toGithub.location) }), authenticate: noPlaneSession });
  strictEqual(done.location, `${ORIGIN}/ws/settings/git-sync?connect=ok&via=handoff`);
  deepStrictEqual((await s.db.query("SELECT installation_id, workspace_slug FROM workspace_installations")).rows, [{ installation_id: 501, workspace_slug: "ws" }]);
  strictEqual((await s.db.query("SELECT 1 FROM user_map")).rows.length, 0, "the approver is not linked to anyone");
  strictEqual((await s.db.query("SELECT 1 FROM user_tokens")).rows.length, 0, "the approver's token is not stored");
  // Single use: the same hand-off link cannot be replayed.
  strictEqual((await handleInstallCallback(s.deps, { query: query({ installation_id: "501", state: stateOf(handoff) }), authenticate: noPlaneSession })).location,
    `${ORIGIN}/?connect=error&reason=state`);
});

test("CLAIM hand-off: a non-owner approving, or an install on a different organization than the link names, connects nothing", async () => {
  const notOwner = await setup();
  const a = await createOwnerHandoff(notOwner.deps, { slug: "ws", viewer: ADMIN, accountId: ACME_ID });
  const r1 = await handleInstallCallback(notOwner.deps, { query: query({ installation_id: "501", state: stateOf(a.link) }), authenticate: noPlaneSession });
  owner(notOwner, "member");
  strictEqual((await handleOAuthCallback(notOwner.deps, { query: query({ code: "c", state: stateOf(r1.location) }), authenticate: noPlaneSession })).location,
    `${ORIGIN}/ws/settings/git-sync?connect=error&reason=not_owner&via=handoff`);
  strictEqual((await notOwner.db.query("SELECT 1 FROM workspace_installations")).rows.length, 0);

  const otherOrg = await setup();
  const b = await createOwnerHandoff(otherOrg.deps, { slug: "ws", viewer: ADMIN, accountId: 1234 });
  const r2 = await handleInstallCallback(otherOrg.deps, { query: query({ installation_id: "501", state: stateOf(b.link) }), authenticate: noPlaneSession });
  owner(otherOrg);
  strictEqual((await handleOAuthCallback(otherOrg.deps, { query: query({ code: "c", state: stateOf(r2.location) }), authenticate: noPlaneSession })).location,
    `${ORIGIN}/ws/settings/git-sync?connect=error&reason=wrong_account&via=handoff`);
  strictEqual((await otherOrg.db.query("SELECT 1 FROM workspace_installations")).rows.length, 0);
});

// Audit S3: an unbound hand-off let its holder name any installation in the install callback and send the resulting
// GitHub authorize link to that installation's owner; a prior authorizer skips GitHub's prompt, so one click claimed it.
test("S3: hand-off links must name their organization; an unbound or legacy link claims nothing", async () => {
  const s = await setup();
  await rejects(createOwnerHandoff(s.deps, { slug: "evil", viewer: ADMIN, accountId: undefined as unknown as number }),
    (e: unknown) => e instanceof HttpError && e.status === 422);
  // A link minted before the binding was mandatory (`handoff:<admin>` with no account) is refused at the callback,
  // before any GitHub authorize URL is handed out.
  const { link: bound } = await createOwnerHandoff(s.deps, { slug: "evil", viewer: ADMIN, accountId: ACME_ID });
  await s.db.query("UPDATE oauth_states SET plane_user_id = $1 WHERE purpose = 'install'", [`handoff:${ADMIN.id}`]);
  const legacy = await handleInstallCallback(s.deps, { query: query({ installation_id: "501", setup_action: "install", state: stateOf(bound) }), authenticate: noPlaneSession });
  strictEqual(legacy.location, `${ORIGIN}/evil/settings/git-sync?connect=error&reason=state`);
  strictEqual((await s.db.query("SELECT 1 FROM oauth_states WHERE purpose = 'oauth'")).rows.length, 0, "no authorize state was issued");
  strictEqual((await s.db.query("SELECT 1 FROM workspace_installations")).rows.length, 0);
});
