// Personal GitHub accounts (spec §12.3, parity C2): the GitHub App's OAuth client, PKCE, the user
// access token store with refresh under the per-user lock, and the few REST reads a user token makes.
// GitHub facts (Context7 /websites/github_en, "Generating a user access token for a GitHub App"):
// - authorize: GET <web>/login/oauth/authorize with client_id, redirect_uri, state, code_challenge,
//   code_challenge_method=S256; GitHub returns to redirect_uri with `code` and the same `state`.
// - exchange: POST <web>/login/oauth/access_token (Accept: application/json) with client_id,
//   client_secret, code, redirect_uri, code_verifier → access_token, expires_in, refresh_token,
//   refresh_token_expires_in (the last three are omitted when token expiration is disabled).
// - refresh: same endpoint with grant_type=refresh_token and refresh_token; it returns a NEW refresh
//   token, so two refreshes with one token invalidate each other (hence the lock).
// - failures come back as `{ error: "bad_refresh_token" | "incorrect_client_credentials" | … }`.
// - REST calls send `Authorization: Bearer <user token>`, `Accept: application/vnd.github+json`,
//   `X-GitHub-Api-Version: 2022-11-28`.
import { createHash, randomBytes } from "node:crypto";
import { Octokit } from "@octokit/core";
import type { Db } from "../db/migrate.ts";
import {
  getGithubOAuthToken, markGithubOAuthNeedsReauth, putGithubOAuthToken, readGithubAppClient, withGithubOAuthRefreshLock,
} from "../db/parity.ts";
import type { GithubOAuthToken } from "../db/parity.ts";
import { deriveGithubHosts } from "../github/hosts.ts";
import type { GithubEdition, GithubHosts } from "../github/hosts.ts";
import { withGithubRateLimits } from "../github/errors.ts";
import { SecretString, decryptSecret, encryptSecret } from "./identity.ts";

/** The environment bootstrap for the OAuth client; a stored `github_app_config` row wins over it. */
export interface OAuthAppEnv {
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_EDITION?: GithubEdition;
  GITHUB_GHE_SUBDOMAIN?: string;
  GITHUB_API_BASE_URL?: string;
}

export interface GithubOAuthApp {
  clientId: string;
  clientSecret: SecretString;
  appSlug: string | null;
  hosts: GithubHosts;
}

/** The configured edition's hosts: the stored row when there is one, otherwise the environment. */
export async function loadGithubHosts(db: Db, env: OAuthAppEnv): Promise<GithubHosts> {
  const row = await readGithubAppClient(db);
  if (row) {
    return deriveGithubHosts({
      edition: row.edition,
      ...(row.edition === "ghe_cloud" ? { gheSubdomain: row.gheSubdomain } : {}),
      ...(row.edition === "ghes" ? { gheBaseUrl: row.gheBaseUrl } : {}),
    });
  }
  return deriveGithubHosts({
    ...(env.GITHUB_EDITION ? { edition: env.GITHUB_EDITION } : {}),
    ...(env.GITHUB_GHE_SUBDOMAIN ? { gheSubdomain: env.GITHUB_GHE_SUBDOMAIN } : {}),
    ...(env.GITHUB_API_BASE_URL ? { apiBaseUrl: env.GITHUB_API_BASE_URL } : {}),
  });
}

/**
 * The App's OAuth client, or null when no client id and secret are configured. Id and secret always come
 * from the same source: a stored client id requires the stored secret, never the environment's.
 */
export async function loadGithubOAuthApp(db: Db, tokenKey: Buffer, env: OAuthAppEnv): Promise<GithubOAuthApp | null> {
  const row = await readGithubAppClient(db);
  const hosts = await loadGithubHosts(db, env);
  const appSlug = row?.appSlug ?? env.GITHUB_APP_SLUG?.trim() ?? null;
  if (row?.clientId) {
    if (!row.clientSecretCiphertext) return null;
    return { clientId: row.clientId, clientSecret: new SecretString(decryptSecret(row.clientSecretCiphertext, tokenKey)), appSlug: appSlug || null, hosts };
  }
  const id = env.GITHUB_CLIENT_ID?.trim(), secret = env.GITHUB_CLIENT_SECRET;
  if (!id || !secret) return null;
  return { clientId: id, clientSecret: new SecretString(secret), appSlug: appSlug || null, hosts };
}

// ---- PKCE and state ---------------------------------------------------------------------------------------
/** RFC 7636: a 43-character base64url verifier and its S256 challenge. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier, "ascii").digest("base64url") };
}

/** An unguessable single-use state value; only its hash is stored (db/parity.ts). */
export const newStateNonce = (): string => randomBytes(32).toString("base64url");

// ---- token endpoint --------------------------------------------------------------------------------------
export interface GithubTokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** Seconds; null when the App has token expiration disabled. */
  expiresIn: number | null;
  refreshExpiresIn: number | null;
}

/** `transient` failures (network, 5xx, 429) keep the link; any other failure needs re-authorization. */
export class GithubOAuthError extends Error {
  readonly code: string;
  readonly transient: boolean;
  constructor(code: string, transient: boolean) {
    super(`GitHub OAuth failed: ${code}`);
    this.code = code;
    this.transient = transient;
    this.name = "GithubOAuthError";
  }
}

const seconds = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

async function tokenRequest(app: GithubOAuthApp, body: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<GithubTokenSet> {
  let res: Response;
  try {
    res = await fetchImpl(app.hosts.oauthAccessTokenUrl, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret.reveal(), ...body }),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new GithubOAuthError("network", true);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new GithubOAuthError(`http_${res.status}`, res.status >= 500 || res.status === 429);
  }
  let json: any;
  try { json = await res.json(); } catch { throw new GithubOAuthError("unreadable", true); }
  if (typeof json?.error === "string") throw new GithubOAuthError(json.error, false);
  if (typeof json?.access_token !== "string" || !json.access_token) throw new GithubOAuthError("no_access_token", false);
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === "string" && json.refresh_token ? json.refresh_token : null,
    expiresIn: seconds(json.expires_in),
    refreshExpiresIn: seconds(json.refresh_token_expires_in),
  };
}

export function exchangeGithubCode(app: GithubOAuthApp, input: { code: string; codeVerifier: string; redirectUri: string }, fetchImpl?: typeof fetch): Promise<GithubTokenSet> {
  return tokenRequest(app, { code: input.code, redirect_uri: input.redirectUri, code_verifier: input.codeVerifier }, fetchImpl);
}

export function refreshGithubToken(app: GithubOAuthApp, refreshToken: string, fetchImpl?: typeof fetch): Promise<GithubTokenSet> {
  return tokenRequest(app, { grant_type: "refresh_token", refresh_token: refreshToken }, fetchImpl);
}

// ---- REST reads with a user token --------------------------------------------------------------------------
export class GithubApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "GithubApiError";
  }
}

export interface UserInstallation { id: number; account: { id: number | null; login: string | null; type: string | null; avatarUrl: string | null } }
/** GET /user/memberships/orgs/{org} (org-membership): state active|pending, role admin|member|billing_manager. */
export interface OrgMembership { state: string; role: string; orgId: number | null }
export interface UserRepository { id: number; fullName: string; private: boolean; permissions: Record<string, boolean> | null }

const MAX_PAGES = 100;

export function githubUserApi(hosts: Pick<GithubHosts, "apiBaseUrl">, token: SecretString, fetchImpl: typeof fetch = fetch) {
  const get = async (path: string, query: Record<string, string> = {}): Promise<any> => {
    const url = new URL(hosts.apiBaseUrl.replace(/\/+$/, "") + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token.reveal()}`, "x-github-api-version": "2022-11-28" },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new GithubApiError(0, "GitHub is unreachable");
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new GithubApiError(res.status, `GitHub answered ${res.status} for ${path}`);
    }
    return res.json();
  };
  /** Every page (per_page max 100) until the reported total or an empty page; never a silent first page only. */
  const all = async <T>(path: string, key: string): Promise<T[]> => {
    const out: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await get(path, { per_page: "100", page: String(page) });
      const items: unknown = body?.[key];
      if (!Array.isArray(items)) throw new GithubApiError(502, `GitHub returned no ${key} list`);
      out.push(...(items as T[]));
      const total = Number(body?.total_count);
      if (items.length === 0 || (Number.isFinite(total) && out.length >= total) || items.length < 100) return out;
    }
    throw new GithubApiError(502, `GitHub ${key} pagination did not finish`);
  };
  return {
    async getUser(): Promise<{ id: number; login: string }> {
      const u = await get("/user");
      if (!Number.isSafeInteger(u?.id) || typeof u?.login !== "string") throw new GithubApiError(502, "GitHub returned no user");
      return { id: u.id, login: u.login };
    },
    /** GET /user/installations: this App's installations the user can access. */
    async listInstallations(): Promise<UserInstallation[]> {
      return (await all<any>("/user/installations", "installations"))
        .filter((i) => Number.isSafeInteger(i?.id))
        .map((i) => ({ id: i.id, account: { id: Number.isSafeInteger(i.account?.id) ? i.account.id : null, login: i.account?.login ?? null,
          type: i.account?.type ?? null, avatarUrl: i.account?.avatar_url ?? null } }));
    },
    /**
     * The signed-in user's own membership of `org`, or null when they are not affiliated (404). Context7
     * /websites/github_en_rest "Get an organization membership for the authenticated user" and GitHub's OpenAPI
     * description (org-membership: `state` active|pending, `role` admin|member|billing_manager). Organization owners
     * have role `admin`. A 403 (the organization blocks the App) is thrown, never read as "no".
     */
    async getOrgMembership(org: string): Promise<OrgMembership | null> {
      try {
        const m = await get(`/user/memberships/orgs/${encodeURIComponent(org)}`);
        return { state: String(m?.state ?? ""), role: String(m?.role ?? ""), orgId: Number.isSafeInteger(m?.organization?.id) ? m.organization.id : null };
      } catch (e) {
        if (e instanceof GithubApiError && e.status === 404) return null;
        throw e;
      }
    },
    /** GET /user/installations/{id}/repositories: repositories the user may access through that installation. */
    async listInstallationRepositories(installationId: number): Promise<UserRepository[]> {
      return (await all<any>(`/user/installations/${installationId}/repositories`, "repositories"))
        .filter((r) => Number.isSafeInteger(r?.id) && typeof r?.full_name === "string")
        .map((r) => ({ id: r.id, fullName: r.full_name, private: r.private === true, permissions: r.permissions && typeof r.permissions === "object" ? r.permissions : null }));
    },
  };
}

/**
 * Disconnect (spec §12.3): DELETE /applications/{client_id}/grant with the user's access token in the body, as the
 * App (HTTP Basic, client id as username and client secret as password). "Deleting an application's grant will also
 * delete all OAuth tokens associated with the application for the user"; success is 204
 * (Context7 /websites/github_en_rest, "Delete an app authorization" and "Authenticating to the REST API").
 */
export async function revokeGithubGrant(app: GithubOAuthApp, accessToken: SecretString, fetchImpl: typeof fetch = fetch): Promise<void> {
  const url = `${app.hosts.apiBaseUrl.replace(/\/+$/, "")}/applications/${encodeURIComponent(app.clientId)}/grant`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "DELETE",
      headers: {
        accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json",
        authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret.reveal()}`, "utf8").toString("base64")}`,
      },
      body: JSON.stringify({ access_token: accessToken.reveal() }),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new GithubApiError(0, "GitHub is unreachable");
  }
  await res.body?.cancel().catch(() => undefined);
  if (res.status !== 204) throw new GithubApiError(res.status, `GitHub answered ${res.status} when revoking the grant`);
}

// ---- the token store --------------------------------------------------------------------------------------
export interface GithubUserTokensDeps {
  db: Db;
  tokenKey: Buffer;
  app(): Promise<GithubOAuthApp | null>;
  fetch?: typeof fetch;
  now?: () => number;
  /** Refresh this long before expiry (default 5 minutes). */
  refreshSkewMs?: number;
}

export type GithubLinkStatus = { stored: boolean; needsReauth: boolean };

export class GithubUserTokens {
  #d: GithubUserTokensDeps;
  constructor(deps: GithubUserTokensDeps) { this.#d = deps; }

  #now() { return this.#d.now?.() ?? Date.now(); }
  #fresh(t: GithubOAuthToken): boolean {
    return t.accessExpiresAt === null || t.accessExpiresAt.getTime() - this.#now() > (this.#d.refreshSkewMs ?? 5 * 60_000);
  }
  #at(sec: number | null): Date | null { return sec === null ? null : new Date(this.#now() + sec * 1000); }

  /** Saves an exchange or refresh result (encrypted) on `conn`, which may be a transaction, and clears needs_reauth. */
  async store(conn: Db, planeUserId: string, set: GithubTokenSet): Promise<void> {
    await putGithubOAuthToken(conn, planeUserId, {
      accessCiphertext: encryptSecret(set.accessToken, this.#d.tokenKey),
      refreshCiphertext: set.refreshToken ? encryptSecret(set.refreshToken, this.#d.tokenKey) : null,
      accessExpiresAt: this.#at(set.expiresIn),
      refreshExpiresAt: this.#at(set.refreshExpiresIn),
    });
  }

  /**
   * The best token to revoke with: a working (possibly just refreshed) one, else the stored access token as is,
   * which GitHub may still accept even when this service stopped using it.
   */
  async tokenForRevocation(planeUserId: string): Promise<SecretString | null> {
    const usable = await this.accessToken(planeUserId);
    if (usable) return usable;
    const t = await getGithubOAuthToken(this.#d.db, planeUserId);
    if (!t) return null;
    try { return new SecretString(decryptSecret(t.accessCiphertext, this.#d.tokenKey), planeUserId); } catch { return null; }
  }

  async status(planeUserId: string): Promise<GithubLinkStatus> {
    const t = await getGithubOAuthToken(this.#d.db, planeUserId);
    return { stored: t !== null, needsReauth: t?.needsReauth ?? false };
  }

  /** GitHub refused the token (401): the user must authorize again; writes use the service identity meanwhile. */
  async markRejected(planeUserId: string): Promise<void> {
    await markGithubOAuthNeedsReauth(this.#d.db, planeUserId);
  }

  /**
   * A usable access token, refreshed when it is about to expire, or null: not linked, needs
   * re-authorization, or a refresh that failed. Null means "use the service identity"; it never drops a write.
   * A transient refresh failure (network, 5xx) keeps the link; a refused refresh marks it needs_reauth.
   */
  async accessToken(planeUserId: string): Promise<SecretString | null> {
    const t = await getGithubOAuthToken(this.#d.db, planeUserId);
    if (!t || t.needsReauth) return null;
    if (this.#fresh(t)) return this.#decrypt(planeUserId, t.accessCiphertext);
    return withGithubOAuthRefreshLock(this.#d.db, planeUserId, async (conn, cur) => {
      if (!cur || cur.needsReauth) return null;
      // Another worker refreshed while this one waited for the lock: use its token, never refresh twice.
      if (this.#fresh(cur)) return this.#decrypt(planeUserId, cur.accessCiphertext, conn);
      const refreshExpired = cur.refreshExpiresAt !== null && cur.refreshExpiresAt.getTime() <= this.#now();
      if (!cur.refreshCiphertext || refreshExpired) {
        await markGithubOAuthNeedsReauth(conn, planeUserId);
        return null;
      }
      const app = await this.#d.app();
      if (!app) return null; // configuration gap, not the user's fault: fall back without marking
      let refreshToken: string;
      try { refreshToken = decryptSecret(cur.refreshCiphertext, this.#d.tokenKey); }
      catch { await markGithubOAuthNeedsReauth(conn, planeUserId); return null; }
      try {
        const set = await refreshGithubToken(app, refreshToken, this.#d.fetch);
        await this.store(conn, planeUserId, set);
        return new SecretString(set.accessToken, planeUserId);
      } catch (err) {
        if (err instanceof GithubOAuthError && err.transient) return null;
        await markGithubOAuthNeedsReauth(conn, planeUserId);
        return null;
      }
    });
  }

  async #decrypt(planeUserId: string, blob: string, conn: Db = this.#d.db): Promise<SecretString | null> {
    try { return new SecretString(decryptSecret(blob, this.#d.tokenKey), planeUserId); }
    catch { await markGithubOAuthNeedsReauth(conn, planeUserId); return null; }
  }
}

// ---- attribution: an Octokit that acts as the linked user (spec §12.3) -----------------------------------------
export type UserClientFactory = (planeUserId: string, installationId: number) => Promise<any | null>;

/**
 * For GithubWritePath's `userClient`: an Octokit authenticated with the user's token on the configured API
 * host (Context7 /octokit/octokit.js: `auth` takes a token, `baseUrl` the API root), or null for the service identity.
 * A user token of a GitHub App only reaches repositories the App's installations cover, so `installationId`
 * needs no separate check; a refused request falls back in the write path.
 */
export function createUserClientFactory(tokens: GithubUserTokens, hosts: () => Promise<Pick<GithubHosts, "apiBaseUrl">>, db?: Db): UserClientFactory {
  return async (planeUserId) => {
    const token = await tokens.accessToken(planeUserId);
    if (!token) return null;
    const { apiBaseUrl } = await hosts();
    const octokit = new Octokit({ auth: token.reveal(), baseUrl: apiBaseUrl });
    return db ? withGithubRateLimits(octokit, { key: `user:${planeUserId}`, db }) : octokit;
  };
}
