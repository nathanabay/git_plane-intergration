// Personal GitHub account linking (spec §12.3, parity C2): any workspace member links their own account
// through the GitHub App's user authorization (state + PKCE S256), the code is exchanged for a user token,
// GET /user identifies the account by id, and user_map is written under the workspace's user-link lock.
// GitHub facts: Context7 /websites/github_en ("Generating a user access token for a GitHub App"); see
// src/auth/github-user.ts. Plane roles (v1.4.2 plane/db/models/workspace.py): 20 Admin, 15 Member, 5 Guest.
import type { IncomingMessage } from "node:http";
import { addUserLinkTombstone, appendAudit, clearUserLinkTombstone, withUserLinkTransaction } from "../db/ledgers.ts";
import { consumeOAuthState, deleteGithubOAuthToken } from "../db/parity.ts";
import { SecretString, decryptSecret } from "../auth/identity.ts";
import { exchangeGithubCode, githubUserApi, revokeGithubGrant } from "../auth/github-user.ts";
import { githubServiceUrls } from "../github/hosts.ts";
import { HttpError } from "./http.ts";
import { cookieValue, membershipWorkspace } from "./plane-auth.ts";
import type { PlaneAuthDeps, Viewer } from "./plane-auth.ts";
import {
  accountUrl, beginGithubAuthorization, claimReason, claimWithToken, getPersonalLink, oauthApp, parseHandoff, settingsUrl, userTokens, withQuery,
} from "./install-flow.ts";
import type { Authenticate, ConnectDeps, PersonalLink } from "./install-flow.ts";

export { getPersonalLink };
export type { PersonalLink };

export const WORKSPACE_MEMBER_ROLE = 15;
const WEB_COOKIE = "session-id";
const ADMIN_COOKIE = "admin-session-id";

async function planeGet(deps: PlaneAuthDeps, path: string, cookie: string): Promise<{ status: number; json: any }> {
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(deps.planeInternalUrl.replace(/\/+$/, "") + path, {
      method: "GET", headers: { cookie, accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new HttpError(502, "Plane is unreachable");
  }
  if (res.status !== 200) { await res.body?.cancel().catch(() => undefined); return { status: res.status, json: null }; }
  try { return { status: 200, json: await res.json() }; } catch { throw new HttpError(502, "Plane returned an unreadable response"); }
}

/**
 * Like authenticateWorkspaceAdmin, but any workspace member (role ≥ 15) passes; guests are refused. Used for the
 * member-level "Connect GitHub account" page: a member may link only their own account.
 */
export async function authenticateWorkspaceMember(deps: PlaneAuthDeps, req: IncomingMessage, slug: string): Promise<Viewer> {
  const webCookie = deps.planeSessionCookieName ?? WEB_COOKIE;
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(webCookie)) throw new HttpError(502, "Plane session cookie name is invalid");
  const sid = cookieValue(req.headers.cookie, webCookie);
  if (!sid) throw new HttpError(401, "Sign in to Plane to continue");
  const cookie = `${webCookie}=${sid}`;
  const me = await planeGet(deps, "/api/users/me/", cookie);
  if (me.status === 401 || me.status === 403) throw new HttpError(401, "Sign in to Plane to continue");
  if (me.status !== 200 || typeof me.json?.id !== "string" || !me.json.id) throw new HttpError(502, "Plane could not verify the session");
  // Same v1.4.2 cookie-name quirk as authenticateWorkspaceAdmin for slugs containing "instances".
  const memberCookie = slug.includes("instances") ? `${cookie}; ${ADMIN_COOKIE}=${sid}` : cookie;
  const member = await planeGet(deps, `/api/workspaces/${encodeURIComponent(slug)}/workspace-members/me/`, memberCookie);
  if (member.status === 401) throw new HttpError(401, "Sign in to Plane to continue");
  if (member.status === 403 || member.status === 404) throw new HttpError(403, "Workspace membership is required");
  if (member.status !== 200) throw new HttpError(502, "Plane could not verify the workspace role");
  const role = Number(member.json?.role);
  if (!Number.isFinite(role) || role < WORKSPACE_MEMBER_ROLE) throw new HttpError(403, "Workspace membership is required");
  return { id: me.json.id, email: typeof me.json.email === "string" ? me.json.email : null, ...membershipWorkspace(member.json) };
}

/** POST …/github/account/connect (also Reconnect): GitHub's authorize URL for the viewer's own account. */
export function startGithubAuthorization(deps: ConnectDeps, input: { slug: string; viewer: Viewer }): Promise<{ authorizeUrl: string; expiresAt: string }> {
  return beginGithubAuthorization(deps, input);
}

/** GET /git-sync/oauth/github/callback?code&state (or ?error&state) → 302 to `location`. */
export async function handleOAuthCallback(deps: ConnectDeps, input: { query: URLSearchParams; authenticate: Authenticate }): Promise<{ location: string }> {
  const nonce = input.query.get("state");
  const state = nonce ? await consumeOAuthState(deps.db, nonce, "oauth") : null;
  if (!state) return { location: withQuery(`${new URL(deps.publicOrigin).origin}/`, { github: "error", reason: "state" }) };
  const slug = state.workspaceSlug;
  const handoff = parseHandoff(state.planeUserId);
  if (handoff) return completeHandoff(deps, state, handoff.accountId, input.query);
  const chained = state.installationId !== null;
  const back = (ok: boolean, reason?: string) => ({ location: chained
    ? withQuery(settingsUrl(deps, slug), ok ? { connect: "ok" } : { connect: "error", reason: reason ?? "github" })
    : withQuery(accountUrl(deps, slug), ok ? { github: "linked" } : { github: "error", reason: reason ?? "github" }) });

  if (input.query.get("error")) return back(false, "denied");
  let viewer: Viewer;
  try { viewer = await input.authenticate(slug, chained ? "admin" : "member"); } catch { return back(false, "state"); }
  if (viewer.id !== state.planeUserId) return back(false, "state");
  const code = input.query.get("code");
  if (!code || !state.pkceVerifierCiphertext) return back(false, "exchange");
  const app = await oauthApp(deps);
  if (!app) return back(false, "not_configured");

  let set;
  try {
    set = await exchangeGithubCode(app, { code, codeVerifier: decryptSecret(state.pkceVerifierCiphertext, deps.tokenKey),
      redirectUri: githubServiceUrls(deps.publicOrigin).oauthCallbackUrl }, deps.fetch);
  } catch (e) {
    console.error("GitHub code exchange failed:", e instanceof Error ? e.message : "unknown");
    return back(false, "exchange");
  }
  const token = new SecretString(set.accessToken, viewer.id);
  let user: { id: number; login: string };
  try { user = await githubUserApi(app.hosts, token, deps.fetch).getUser(); }
  catch (e) {
    console.error("GitHub user lookup failed:", e instanceof Error ? e.message : "unknown");
    return back(false, "github");
  }

  // The link is keyed by the stable account id; linking lifts this account's unlink tombstone (review-4 F11).
  const tokens = userTokens(deps);
  try {
    await withUserLinkTransaction(deps.db, slug, async (conn) => {
      await conn.query(
        `INSERT INTO user_map (workspace_slug, plane_user_id, gh_login, gh_id) VALUES ($1, $2, $3, $4)
         ON CONFLICT (workspace_slug, plane_user_id) DO UPDATE SET gh_login = EXCLUDED.gh_login, gh_id = EXCLUDED.gh_id`,
        [slug, viewer.id, user.login, user.id]);
      await clearUserLinkTombstone(conn, slug, user.id);
      await tokens.store(conn, viewer.id, set);
    });
  } catch (e) {
    if ((e as { code?: string })?.code === "23505") return back(false, "already_linked");
    throw e;
  }

  if (chained) {
    try { await claimWithToken(deps, slug, token, state.installationId!); }
    catch (e) { return back(false, claimReason(e)); }
  }
  return back(true);
}

/**
 * The owner hand-off (spec §12.2): the person approving through the admin's hand-off link authorizes on GitHub; the
 * installation is claimed for the link's workspace only if GitHub confirms, through their own token, that it is one
 * of their installations and that they own it (claimWithToken). Security-audit WEB-PROTOCOL-AND-AUTH, OAuth callback
 * binding: the state is single-use, expiring and PKCE-bound; it is deliberately not bound to a Plane session, because
 * the approver may have none, so it is a capability that grants nothing without GitHub-verified ownership. The token is
 * used for these reads and discarded: no Plane identity, user_map row or stored token is created.
 */
async function completeHandoff(deps: ConnectDeps, state: { workspaceSlug: string; installationId: number | null; pkceVerifierCiphertext: string | null },
  accountId: number | null, query: URLSearchParams): Promise<{ location: string }> {
  const back = (q: Record<string, string>) => ({ location: withQuery(settingsUrl(deps, state.workspaceSlug), { ...q, via: "handoff" }) });
  if (query.get("error")) return back({ connect: "error", reason: "denied" });
  const code = query.get("code");
  if (!code || !state.pkceVerifierCiphertext || state.installationId === null) return back({ connect: "error", reason: "exchange" });
  // Audit S3: only an organization-bound hand-off may claim; the claim then refuses any other account.
  if (accountId === null) return back({ connect: "error", reason: "state" });
  const app = await oauthApp(deps);
  if (!app) return back({ connect: "error", reason: "not_configured" });
  let set;
  try {
    set = await exchangeGithubCode(app, { code, codeVerifier: decryptSecret(state.pkceVerifierCiphertext, deps.tokenKey),
      redirectUri: githubServiceUrls(deps.publicOrigin).oauthCallbackUrl }, deps.fetch);
  } catch (e) {
    console.error("GitHub code exchange failed:", e instanceof Error ? e.message : "unknown");
    return back({ connect: "error", reason: "exchange" });
  }
  try {
    await claimWithToken(deps, state.workspaceSlug, new SecretString(set.accessToken), state.installationId, { expectAccountId: accountId });
    return back({ connect: "ok" });
  } catch (e) {
    return back({ connect: "error", reason: claimReason(e) });
  }
}

/**
 * Revokes a Plane user's GitHub grant, shared by self-service disconnect and the admin unlink route.
 * 1. Best effort: DELETE /applications/{client_id}/grant with their token (a working one, else the stored one), which
 *    deletes every token GitHub issued to this App for them (Context7 /websites/github_en_rest, "Delete an app
 *    authorization"; HTTP Basic with the client id and secret).
 * 2. Always: deletes the locally stored `github_oauth` token.
 * A GitHub failure (non-204, network, App not configured) is audited as `github_grant_revoke_failed` under
 * `workspaceSlug`, never with the token, and never blocks step 2. The user_map row and tombstone stay with the caller.
 * Returns whether GitHub confirmed the revocation and whether a local token was deleted.
 */
export async function revokePersonalGrant(deps: ConnectDeps, planeUserId: string, workspaceSlug: string): Promise<{ revoked: boolean; tokenDeleted: boolean }> {
  let revoked = false;
  const token = await userTokens(deps).tokenForRevocation(planeUserId);
  if (token) {
    try {
      const app = await oauthApp(deps);
      if (!app) throw new Error("the GitHub App client id and secret are not configured");
      await revokeGithubGrant(app, token, deps.fetch);
      revoked = true;
    } catch (e) {
      // Never the token itself: only who, where and why.
      await appendAudit(deps.db, { kind: "github_grant_revoke_failed", source: "github", workspaceSlug, outcome: "failed",
        error: (e instanceof Error ? e.message : "unknown").slice(0, 300), detail: { planeUserId } });
    }
  }
  return { revoked, tokenDeleted: await deleteGithubOAuthToken(deps.db, planeUserId) };
}

/**
 * DELETE …/github/account: revokes the grant (revokePersonalGrant), then unlinks the viewer in this workspace
 * (tombstone, so the next email match does not relink them). The Plane token stays; GitHub tokens are per user, so
 * attribution stops in every workspace until they connect again.
 */
export async function disconnectPersonalAccount(deps: ConnectDeps, input: { slug: string; viewer: Viewer }): Promise<void> {
  const linked = (await deps.db.query(`SELECT 1 FROM user_map WHERE workspace_slug = $1 AND plane_user_id = $2`, [input.slug, input.viewer.id])).rows.length > 0;
  if (!linked && !(await userTokens(deps).status(input.viewer.id)).stored) throw new HttpError(404, "No GitHub account is linked");
  const { tokenDeleted } = await revokePersonalGrant(deps, input.viewer.id, input.slug);
  const unlinked = await withUserLinkTransaction(deps.db, input.slug, async (conn) => {
    const del = await conn.query<{ gh_id: string | number }>(
      `DELETE FROM user_map WHERE workspace_slug = $1 AND plane_user_id = $2 RETURNING gh_id`, [input.slug, input.viewer.id]);
    if (del.rows[0]) await addUserLinkTombstone(conn, input.slug, Number(del.rows[0].gh_id));
    return del.rows.length > 0;
  });
  if (!unlinked && !tokenDeleted) throw new HttpError(404, "No GitHub account is linked");
}
