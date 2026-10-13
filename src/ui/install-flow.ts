// Connect GitHub (spec §12.2, parity C1) and the user-scoped repository picker (§12.4, C3).
// Handlers are plain functions: G5 authenticates the viewer and routes them (docs/impl/parity-w2-G3.md §1).
// GitHub facts (Context7 /websites/github_en "About the setup URL"): the setup URL receives
// `installation_id`, which "bad actors can hit … with a spoofed installation_id", so it is never trusted:
// the installation must appear in the admin's own GET /user/installations (/websites/github_en_rest).
// GET /app/installations/{id} and GET /app/installation-requests need the App JWT (/websites/github_en_rest).
import type { Db } from "../db/migrate.ts";
import { consumeOAuthState, createOAuthState } from "../db/parity.ts";
import { encryptSecret } from "../auth/identity.ts";
import type { SecretString } from "../auth/identity.ts";
import {
  GithubApiError, GithubUserTokens, createPkcePair, githubUserApi, loadGithubOAuthApp, newStateNonce,
} from "../auth/github-user.ts";
import type { GithubOAuthApp, OAuthAppEnv, UserInstallation } from "../auth/github-user.ts";
import { githubAppInstallUrl, githubServiceUrls } from "../github/hosts.ts";
import { HttpError } from "./http.ts";
import type { Viewer } from "./plane-auth.ts";

export interface ConnectDeps {
  db: Db;
  tokenKey: Buffer;
  publicOrigin: string;
  config: OAuthAppEnv;
  /** A request as the App itself (JWT): `GithubClient.appRequest`. */
  appRequest(route: string, params: Record<string, unknown>): Promise<{ data: any }>;
  /** Re-runs mapping verification for an installation (the existing api.ts dependency). */
  refreshInstallation?(installationId: number): Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
  settingsUrl?(slug: string): string;
  accountUrl?(slug: string): string;
}

export type Authenticate = (slug: string, level: "admin" | "member") => Promise<Viewer>;

/**
 * A refused claim with a machine-readable reason for the UI (and the callbacks' `reason=` query value):
 * - `not_yours`: the installation is not among the signed-in GitHub user's installations;
 * - `not_owner`: they can see it but are not an active owner/admin of its organization, or it is another person's
 *   account; an organization owner must connect it, or use the hand-off link;
 * - `wrong_account`: a hand-off link bound to one organization was used to install on another;
 * - `unsupported_account`: an installation on an account type that cannot be verified (for example an enterprise).
 */
export class ClaimRefused extends HttpError {
  readonly reason: "not_yours" | "not_owner" | "wrong_account" | "unsupported_account";
  constructor(reason: ClaimRefused["reason"], message: string) {
    super(403, message);
    this.reason = reason;
  }
}

export interface ConnectedInstallation { installationId: number; accountLogin: string | null; accountType: string | null; avatarUrl: string | null; htmlUrl: string | null }
export interface PendingRequest { id: number; accountId: number | null; accountLogin: string | null; accountAvatarUrl: string | null; requesterLogin: string | null; createdAt: string | null }
export interface ClaimableInstallation {
  installationId: number; accountId: number | null; accountLogin: string | null; avatarUrl: string | null; allowedForWorkspace: string | null;
  /** Whether the viewer owns it (org admin, or their own account). False: show "ask an owner" and the hand-off link. */
  canClaim: boolean;
}
export interface PersonalLink { appConfigured: boolean; linked: boolean; githubLogin: string | null; githubId: number | null; needsReauth: boolean; tokenStored: boolean }
export interface ConnectionView { appConfigured: boolean; installations: ConnectedInstallation[]; pendingRequests: PendingRequest[]; personal: PersonalLink }
export interface PickableRepo { id: number; fullName: string; private: boolean; installationId: number; permissions: Record<string, boolean> | null }
/**
 * Mirroring writes labels, assignees, state and comments with the App's token, so a repository is pickable, and an
 * installation claimable, only for a user who can manage issues there themselves: triage or higher (GitHub repository
 * roles: Read < Triage < Write < Maintain < Admin, Context7 /websites/github_en). Read access alone would let the
 * workspace gain abilities through the App that its admin does not have (security-audit ATTACK-CLASSES "Chained
 * vulnerabilities": scope and capability growth). The per-repository `permissions` hash comes from
 * GET /user/installations/{id}/repositories (Context7 /websites/github_en_rest).
 */
export const canManageIssues = (p: Record<string, boolean> | null): boolean =>
  !!p && (p.admin === true || p.maintain === true || p.push === true || p.triage === true);

export interface PickableRepositories { needsGithubAccount: boolean; needsReauth: boolean; repositories: PickableRepo[] }

export const INSTALL_STATE_TTL_SECONDS = 30 * 60;
export const HANDOFF_STATE_TTL_SECONDS = 7 * 24 * 3600;
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

// ---- shared plumbing ------------------------------------------------------------------------------------
const originOf = (deps: ConnectDeps) => new URL(deps.publicOrigin).origin;
export const settingsUrl = (deps: ConnectDeps, slug: string) =>
  deps.settingsUrl?.(slug) ?? `${originOf(deps)}/${encodeURIComponent(slug)}/settings/git-sync`;
export const accountUrl = (deps: ConnectDeps, slug: string) =>
  deps.accountUrl?.(slug) ?? `${originOf(deps)}/${encodeURIComponent(slug)}/settings/git-sync-account`;
export const withQuery = (url: string, q: Record<string, string>) => {
  const u = new URL(url);
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return u.toString();
};

export const oauthApp = (deps: ConnectDeps): Promise<GithubOAuthApp | null> => loadGithubOAuthApp(deps.db, deps.tokenKey, deps.config);

export function userTokens(deps: ConnectDeps): GithubUserTokens {
  return new GithubUserTokens({ db: deps.db, tokenKey: deps.tokenKey, app: () => oauthApp(deps),
    ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.now ? { now: deps.now } : {}) });
}

const expiresAt = (deps: ConnectDeps, ttl: number) => new Date((deps.now?.() ?? Date.now()) + ttl * 1000).toISOString();

async function requireApp(deps: ConnectDeps, needSlug: boolean): Promise<GithubOAuthApp> {
  const app = await oauthApp(deps);
  if (!app || (needSlug && !app.appSlug))
    throw new HttpError(409, "The GitHub App is not fully configured: an instance admin must add its client ID, client secret and app slug");
  return app;
}

/** GitHub failures become 502 for the browser; the detail goes to the log only. */
function githubFailure(e: unknown, what: string): never {
  if (e instanceof HttpError) throw e;
  console.error(`${what} failed:`, e instanceof Error ? e.message : "unknown");
  throw new HttpError(502, `Could not ${what} with GitHub`);
}

const parseInstallationId = (raw: string | null | undefined): number | null =>
  raw && /^\d{1,15}$/.test(raw) && Number(raw) >= 1 ? Number(raw) : null;

// ---- C2 core shared with the OAuth flow: start the GitHub user authorization -----------------------------
/**
 * The authorize URL with a single-use state and a PKCE S256 challenge (Context7 /websites/github_en). A chained
 * step from the install callback carries the installation the OAuth callback must confirm and claim.
 */
export async function beginGithubAuthorization(deps: ConnectDeps, input: { slug: string; viewer: Viewer; installationId?: number | null }
  | { slug: string; handoff: string; installationId: number }): Promise<{ authorizeUrl: string; expiresAt: string }> {
  const app = await requireApp(deps, false);
  const nonce = newStateNonce();
  const pkce = createPkcePair();
  await createOAuthState(deps.db, { nonce, purpose: "oauth", workspaceSlug: input.slug, planeUserId: "handoff" in input ? input.handoff : input.viewer.id,
    ttlSeconds: OAUTH_STATE_TTL_SECONDS, pkceVerifierCiphertext: encryptSecret(pkce.verifier, deps.tokenKey),
    installationId: input.installationId ?? null });
  const url = new URL(app.hosts.oauthAuthorizeUrl);
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("redirect_uri", githubServiceUrls(deps.publicOrigin).oauthCallbackUrl);
  url.searchParams.set("state", nonce);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { authorizeUrl: url.toString(), expiresAt: expiresAt(deps, OAUTH_STATE_TTL_SECONDS) };
}

// ---- C1 -----------------------------------------------------------------------------------------------------
const installationJson = (id: number, data: any, fallbackLogin: string | null = null): ConnectedInstallation => ({
  installationId: id,
  accountLogin: typeof data?.account?.login === "string" ? data.account.login : fallbackLogin,
  accountType: typeof data?.account?.type === "string" ? data.account.type : null,
  avatarUrl: typeof data?.account?.avatar_url === "string" ? data.account.avatar_url : null,
  htmlUrl: typeof data?.html_url === "string" ? data.html_url : null,
});

/**
 * Allow-lists an installation for the workspace after proving the signed-in GitHub user may connect it (user decision,
 * 2026-10-12): it must be among their installations (GET /user/installations), and they must own it:
 * - an organization: their membership is `state: active` and `role: admin` (organization owner);
 * - a personal account: the account is the user themself (same immutable id from GET /user).
 * `expectAccountId` binds a hand-off link to the organization it was issued for. One installation belongs to one
 * workspace (409 otherwise).
 */
export async function claimWithToken(deps: ConnectDeps, slug: string, token: SecretString, installationId: number,
  opts: { expectAccountId?: number | null } = {}): Promise<ConnectedInstallation> {
  const app = await requireApp(deps, false);
  const api = githubUserApi(app.hosts, token, deps.fetch);
  let mine;
  try { mine = await api.listInstallations(); }
  catch (e) { githubFailure(e, "list your GitHub installations"); }
  const inst = mine.find((i) => i.id === installationId);
  if (!inst) throw new ClaimRefused("not_yours", "That GitHub installation is not one your GitHub account can access");
  if (opts.expectAccountId != null && inst.account.id !== opts.expectAccountId)
    throw new ClaimRefused("wrong_account", "This hand-off link was issued for a different GitHub organization");
  await assertOwnsInstallationAccount(api, inst);
  const taken = (await deps.db.query<{ workspace_slug: string }>(`SELECT workspace_slug FROM workspace_installations WHERE installation_id = $1`, [installationId])).rows[0];
  if (taken && taken.workspace_slug !== slug) throw new HttpError(409, "That GitHub installation is already connected to another workspace");
  let data: any;
  try { data = (await deps.appRequest("GET /app/installations/{installation_id}", { installation_id: installationId })).data; }
  catch (e) { githubFailure(e, "read the installation"); }
  const view = installationJson(installationId, data);
  try {
    const { rows } = await deps.db.query(
      `INSERT INTO workspace_installations (installation_id, workspace_slug, account_login) VALUES ($1, $2, $3)
       ON CONFLICT (installation_id) DO UPDATE SET account_login = EXCLUDED.account_login
         WHERE workspace_installations.workspace_slug = EXCLUDED.workspace_slug
       RETURNING installation_id`, [installationId, slug, view.accountLogin]);
    if (!rows[0]) throw new HttpError(409, "That GitHub installation is already connected to another workspace");
  } catch (e) {
    if ((e as { code?: string })?.code === "23505") throw new HttpError(409, "That GitHub installation is already connected to another workspace");
    throw e;
  }
  await deps.refreshInstallation?.(installationId);
  return view;
}

const OWNER_NEEDED = (org: string) =>
  `Only an owner of the GitHub organization ${org} can connect it. Ask an organization owner to connect it, or send them the hand-off link.`;

async function assertOwnsInstallationAccount(api: ReturnType<typeof githubUserApi>, inst: UserInstallation): Promise<void> {
  const { type, login, id } = inst.account;
  if (type === "Organization" && login) {
    let membership;
    try { membership = await api.getOrgMembership(login); }
    catch (e) {
      // 403: the organization blocks this App for user tokens; ownership cannot be confirmed.
      if (e instanceof GithubApiError && e.status === 403) throw new ClaimRefused("not_owner", OWNER_NEEDED(login));
      githubFailure(e, "check your organization role");
    }
    // A pending invitation is not membership; billing managers and members are not owners.
    if (!membership || membership.state !== "active" || membership.role !== "admin") throw new ClaimRefused("not_owner", OWNER_NEEDED(login));
    if (membership.orgId !== null && id !== null && membership.orgId !== id) throw new ClaimRefused("not_owner", OWNER_NEEDED(login));
    return;
  }
  if (type === "User") {
    let me;
    try { me = await api.getUser(); }
    catch (e) { githubFailure(e, "identify your GitHub account"); }
    if (id === null || me.id !== id)
      throw new ClaimRefused("not_owner", `That installation belongs to the personal account ${login ?? "of someone else"}; only that person can connect it.`);
    return;
  }
  throw new ClaimRefused("unsupported_account", "Installations on this kind of GitHub account cannot be connected here");
}

export async function getPersonalLink(deps: ConnectDeps, input: { slug: string; viewer: Viewer }): Promise<PersonalLink> {
  const app = await oauthApp(deps);
  const row = (await deps.db.query<{ gh_login: string; gh_id: string | number }>(
    `SELECT gh_login, gh_id FROM user_map WHERE workspace_slug = $1 AND plane_user_id = $2`, [input.slug, input.viewer.id])).rows[0];
  const status = await userTokens(deps).status(input.viewer.id);
  return {
    appConfigured: app !== null,
    linked: row !== undefined,
    githubLogin: row?.gh_login ?? null,
    githubId: row ? Number(row.gh_id) : null,
    needsReauth: status.needsReauth,
    tokenStored: status.stored,
  };
}

/**
 * Pending installation requests the viewer made themselves: GitHub's request carries `requester` (a Simple User) and
 * `account` (Context7 /websites/github_en_rest, "List installation requests for the authenticated app"), but nothing
 * that names a workspace, so the requester's id is matched against the viewer's linked GitHub account. Without a
 * linked account the viewer sees none: other workspaces' organization names are not shown.
 */
/**
 * Audit S7: the viewer's GitHub id as their own OAuth token proves it (GET /user), never the user_map row, which a
 * workspace admin can assert for any public account. No working token means no proven identity, so no requests.
 */
async function verifiedGithubId(deps: ConnectDeps, planeUserId: string): Promise<number | null> {
  const app = await oauthApp(deps);
  if (!app) return null;
  try {
    const token = await userTokens(deps).accessToken(planeUserId);
    return token ? (await githubUserApi(app.hosts, token, deps.fetch).getUser()).id : null;
  } catch { return null; }
}

async function pendingInstallationRequests(deps: ConnectDeps, githubId: number | null): Promise<PendingRequest[]> {
  if (githubId === null) return [];
  const out: PendingRequest[] = [];
  try {
    for (let page = 1; page <= 20; page++) {
      const { data } = await deps.appRequest("GET /app/installation-requests", { per_page: 100, page });
      if (!Array.isArray(data)) break;
      for (const r of data) {
        if (!Number.isSafeInteger(r?.id) || r?.requester?.id !== githubId) continue;
        out.push({ id: r.id, accountId: Number.isSafeInteger(r.account?.id) ? r.account.id : null, accountLogin: r.account?.login ?? null, accountAvatarUrl: r.account?.avatar_url ?? null,
          requesterLogin: r.requester?.login ?? null, createdAt: typeof r.created_at === "string" ? r.created_at : null });
      }
      if (data.length < 100) break;
    }
  } catch (e) {
    console.error("listing installation requests failed:", e instanceof Error ? e.message : "unknown");
    return [];
  }
  return out;
}

export async function getConnection(deps: ConnectDeps, input: { slug: string; viewer: Viewer }): Promise<ConnectionView> {
  const app = await oauthApp(deps);
  const rows = (await deps.db.query<{ installation_id: string | number; account_login: string | null }>(
    `SELECT installation_id, account_login FROM workspace_installations WHERE workspace_slug = $1 ORDER BY installation_id`, [input.slug])).rows;
  const installations: ConnectedInstallation[] = [];
  for (const r of rows) {
    const id = Number(r.installation_id);
    try { installations.push(installationJson(id, (await deps.appRequest("GET /app/installations/{installation_id}", { installation_id: id })).data, r.account_login)); }
    catch { installations.push(installationJson(id, null, r.account_login)); }
  }
  const personal = await getPersonalLink(deps, input);
  return {
    appConfigured: app !== null && app.appSlug !== null,
    installations,
    pendingRequests: await pendingInstallationRequests(deps, await verifiedGithubId(deps, input.viewer.id)),
    personal,
  };
}

async function installState(deps: ConnectDeps, input: { slug: string; viewer: Viewer }, ttl: number): Promise<{ url: string; expiresAt: string }> {
  const app = await requireApp(deps, true);
  const nonce = newStateNonce();
  await createOAuthState(deps.db, { nonce, purpose: "install", workspaceSlug: input.slug, planeUserId: input.viewer.id, ttlSeconds: ttl });
  return { url: githubAppInstallUrl(app.hosts, app.appSlug!, nonce), expiresAt: expiresAt(deps, ttl) };
}

/** POST …/github/connect: the App's install page with a single-use signed state. */
export async function startInstall(deps: ConnectDeps, input: { slug: string; viewer: Viewer }): Promise<{ installUrl: string; expiresAt: string }> {
  const s = await installState(deps, input, INSTALL_STATE_TTL_SECONDS);
  return { installUrl: s.url, expiresAt: s.expiresAt };
}

// A hand-off state is a capability the admin hands to someone else, so it is not bound to a Plane session. Its
// `plane_user_id` holds `handoff:<admin's Plane user id>[:<GitHub organization id>]` (Plane user ids are UUIDs, so no
// collision); the admin's id is kept only for the audit trail, never used as an identity.
const HANDOFF = "handoff:";
export function parseHandoff(stateUser: string): { adminPlaneUserId: string; accountId: number | null } | null {
  if (!stateUser.startsWith(HANDOFF)) return null;
  const [admin = "", account] = stateUser.slice(HANDOFF.length).split(":");
  const accountId = account && /^\d{1,15}$/.test(account) ? Number(account) : null;
  return admin ? { adminPlaneUserId: admin, accountId } : null;
}

/**
 * POST …/github/connect/handoff: a copyable install link for an organization owner (an admin who is not an owner gets
 * an installation request instead; GET /app/installation-requests lists them). The owner installs or approves through
 * it; the install callback then sends them through GitHub's user authorization, and the OAuth callback claims the
 * installation for this workspace only after GitHub confirms the person is an active owner of that organization (or
 * the personal account itself). They need no Plane account; their GitHub token is used once and never stored.
 * `accountId` (the organization id from a pending request) binds the link to that organization.
 */
export async function createOwnerHandoff(deps: ConnectDeps, input: { slug: string; viewer: Viewer; accountId: number }): Promise<{ link: string; expiresAt: string }> {
  // Audit S3: an unbound link let its holder name any installation in the callback and have a prior authorizer claim it.
  if (!Number.isSafeInteger(input.accountId) || input.accountId < 1) throw new HttpError(422, "accountId must be a GitHub account id");
  const app = await requireApp(deps, true);
  const nonce = newStateNonce();
  await createOAuthState(deps.db, { nonce, purpose: "install", workspaceSlug: input.slug,
    planeUserId: `${HANDOFF}${input.viewer.id}:${input.accountId}`, ttlSeconds: HANDOFF_STATE_TTL_SECONDS });
  return { link: githubAppInstallUrl(app.hosts, app.appSlug!, nonce), expiresAt: expiresAt(deps, HANDOFF_STATE_TTL_SECONDS) };
}

export async function listClaimableInstallations(deps: ConnectDeps, input: { slug: string; viewer: Viewer }): Promise<{ needsGithubAccount: boolean; needsReauth: boolean; installations: ClaimableInstallation[] }> {
  const tokens = userTokens(deps);
  const token = await tokens.accessToken(input.viewer.id);
  if (!token) {
    const status = await tokens.status(input.viewer.id);
    return { needsGithubAccount: !status.stored, needsReauth: status.needsReauth, installations: [] };
  }
  const app = await requireApp(deps, false);
  let mine;
  try { mine = await githubUserApi(app.hosts, token, deps.fetch).listInstallations(); }
  catch (e) { githubFailure(e, "list your GitHub installations"); }
  const owners = new Map((await deps.db.query<{ installation_id: string | number; workspace_slug: string }>(
    `SELECT installation_id, workspace_slug FROM workspace_installations WHERE installation_id = ANY($1::bigint[])`, [mine.map((i) => i.id)])).rows
    .map((r) => [Number(r.installation_id), r.workspace_slug] as const));
  const api = githubUserApi(app.hosts, token, deps.fetch);
  const installations: ClaimableInstallation[] = [];
  for (const i of mine) {
    let canClaim = true;
    try { await assertOwnsInstallationAccount(api, i); } catch { canClaim = false; }
    installations.push({ installationId: i.id, accountId: i.account.id, accountLogin: i.account.login, avatarUrl: i.account.avatarUrl,
      // Another workspace's slug is not this admin's to see (security-audit DATA-ISOLATION "Enumeration and aggregate oracles").
      allowedForWorkspace: !owners.has(i.id) ? null : owners.get(i.id) === input.slug ? input.slug : "another workspace", canClaim });
  }
  return { needsGithubAccount: false, needsReauth: false, installations };
}

export async function claimInstallation(deps: ConnectDeps, input: { slug: string; viewer: Viewer; installationId: number }): Promise<ConnectedInstallation> {
  if (!Number.isSafeInteger(input.installationId) || input.installationId < 1) throw new HttpError(404, "Installation not found");
  const token = await userTokens(deps).accessToken(input.viewer.id);
  if (!token) throw new HttpError(409, "Connect your personal GitHub account first, so the installation can be verified as yours");
  return claimWithToken(deps, input.slug, token, input.installationId);
}

/** DELETE …/github/installations/:id: removes the allow-list row; the workspace's mappings on it stop syncing. */
export async function disconnectInstallation(deps: ConnectDeps, input: { slug: string; installationId: number }): Promise<void> {
  const del = await deps.db.query(`DELETE FROM workspace_installations WHERE installation_id = $1 AND workspace_slug = $2 RETURNING 1`,
    [input.installationId, input.slug]);
  if (!del.rows.length) throw new HttpError(404, "Installation not found");
}

/** GET /git-sync/install/github/callback?installation_id&setup_action&state → 302 to `location`. */
export async function handleInstallCallback(deps: ConnectDeps, input: { query: URLSearchParams; authenticate: Authenticate }): Promise<{ location: string }> {
  const nonce = input.query.get("state");
  const state = nonce ? await consumeOAuthState(deps.db, nonce, "install") : null;
  if (!state) return { location: withQuery(`${originOf(deps)}/`, { connect: "error", reason: "state" }) };
  const slug = state.workspaceSlug;
  const back = (q: Record<string, string>) => ({ location: withQuery(settingsUrl(deps, slug), q) });
  const installationId = parseInstallationId(input.query.get("installation_id"));
  const handoff = parseHandoff(state.planeUserId);
  if (handoff) {
    // The person approving through a hand-off link proves ownership through GitHub, not a Plane session. The URL's
    // installation_id is only carried forward; the OAuth callback checks it against their own installations.
    if (installationId === null) return back({ connect: "error", reason: "installation" });
    // Audit S3: links issued before the organization binding was mandatory are refused, not honoured unbound.
    if (handoff.accountId === null) return back({ connect: "error", reason: "state" });
    if (!(await oauthApp(deps))) return back({ connect: "error", reason: "not_configured" });
    return { location: (await beginGithubAuthorization(deps, { slug, handoff: state.planeUserId, installationId })).authorizeUrl };
  }
  let viewer: Viewer | null = null;
  try { viewer = await input.authenticate(slug, "admin"); } catch { viewer = null; }
  // A Connect state belongs to the admin who started it; anyone else (or no session) gets nothing.
  if (!viewer || viewer.id !== state.planeUserId) return back({ connect: "error", reason: "state" });
  if (installationId === null) return back({ connect: "error", reason: "installation" });
  if (!(await oauthApp(deps))) return back({ connect: "error", reason: "not_configured" });
  if (input.query.get("setup_action") === "update") {
    const owner = (await deps.db.query<{ workspace_slug: string }>(`SELECT workspace_slug FROM workspace_installations WHERE installation_id = $1`, [installationId])).rows[0];
    if (owner?.workspace_slug === slug) {
      try { await deps.refreshInstallation?.(installationId); }
      catch (e) { console.error("installation refresh failed:", e instanceof Error ? e.message : "unknown"); }
      return back({ connect: "updated" });
    }
  }
  const token = await userTokens(deps).accessToken(viewer.id);
  // No usable personal token: verify through C2 first; the OAuth callback confirms and claims this installation.
  if (!token) return { location: (await beginGithubAuthorization(deps, { slug, viewer, installationId })).authorizeUrl };
  try {
    await claimWithToken(deps, slug, token, installationId);
    return back({ connect: "ok" });
  } catch (e) {
    return back({ connect: "error", reason: claimReason(e) });
  }
}

export function claimReason(e: unknown): string {
  if (e instanceof ClaimRefused) return e.reason;
  if (e instanceof HttpError) return e.status === 409 ? (/configured/.test(e.message) ? "not_configured" : "taken") : "github";
  return "github";
}

// ---- C3 -----------------------------------------------------------------------------------------------------
/**
 * Repositories the viewer may pick: for each installation allow-listed for this workspace (or just one),
 * GET /user/installations/{id}/repositories with the viewer's token, every page. An installation the viewer has
 * no access to (403/404) contributes nothing.
 */
export async function listPickableRepositories(deps: ConnectDeps, input: { slug: string; viewer: Viewer; installationId?: number }): Promise<PickableRepositories> {
  const tokens = userTokens(deps);
  const token = await tokens.accessToken(input.viewer.id);
  if (!token) {
    const status = await tokens.status(input.viewer.id);
    return { needsGithubAccount: !status.stored, needsReauth: status.needsReauth, repositories: [] };
  }
  const ids = (await deps.db.query<{ installation_id: string | number }>(
    `SELECT installation_id FROM workspace_installations WHERE workspace_slug = $1 ORDER BY installation_id`, [input.slug])).rows.map((r) => Number(r.installation_id));
  if (input.installationId !== undefined && !ids.includes(input.installationId)) throw new HttpError(404, "Installation not found");
  const app = await requireApp(deps, false);
  const api = githubUserApi(app.hosts, token, deps.fetch);
  const repositories: PickableRepo[] = [];
  for (const id of input.installationId !== undefined ? [input.installationId] : ids) {
    try {
      for (const r of await api.listInstallationRepositories(id)) if (canManageIssues(r.permissions)) repositories.push({ ...r, installationId: id });
    } catch (e) {
      if (e instanceof GithubApiError && (e.status === 403 || e.status === 404)) continue;
      githubFailure(e, "list repositories");
    }
  }
  return { needsGithubAccount: false, needsReauth: false, repositories };
}

/** Save-time re-check (the browser's list is never trusted): the repository must be in the viewer's own list now. */
export async function assertRepositoryPickable(deps: ConnectDeps, input: { slug: string; viewer: Viewer; ghRepoId: number }): Promise<PickableRepo> {
  const list = await listPickableRepositories(deps, { slug: input.slug, viewer: input.viewer });
  if (list.needsGithubAccount) throw new HttpError(409, "Connect your personal GitHub account to choose repositories");
  if (list.needsReauth) throw new HttpError(409, "Your GitHub account needs re-authorization before you can choose repositories");
  const hit = list.repositories.find((r) => r.id === input.ghRepoId);
  if (!hit) throw new HttpError(403, "That repository is not one your GitHub account can access through this workspace's installations");
  return hit;
}
