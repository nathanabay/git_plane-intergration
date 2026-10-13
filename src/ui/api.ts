// Config API (spec §8) under /git-sync/api/. Authenticated per request against Plane's own
// session; configuration lives only in the gitsync database (no Plane writes, ever).
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Route } from "../index.ts";
import type { Db } from "../db/migrate.ts";
import { PgTokenStore } from "../db/token-store.ts";
import { readGithubAppClient, saveGithubAppClient, updateMappingParity, readRequireVerifiedCommits, writeRequireVerifiedCommits } from "../db/parity.ts";
import { githubRetryDeadline } from "../github/errors.ts";
import { ClaimRefused, assertRepositoryPickable, claimInstallation, createOwnerHandoff, disconnectInstallation, getConnection, handleInstallCallback, listClaimableInstallations, listPickableRepositories, startInstall } from "./install-flow.ts";
import type { ConnectDeps } from "./install-flow.ts";
import { authenticateWorkspaceMember, disconnectPersonalAccount, getPersonalLink, handleOAuthCallback, revokePersonalGrant, startGithubAuthorization } from "./oauth-flow.ts";
import type { OAuthAppEnv } from "../auth/github-user.ts";
import type { SetupCheckResult } from "./setup-check.ts";
import type { MappingHealth, WorkspaceHealth } from "./client/types.ts";
import { addUserLinkTombstone, appendAudit, clearUserLinkTombstone, withUserLinkTransaction } from "../db/ledgers.ts";
import { TokenVault, decryptSecret, encryptSecret } from "../auth/identity.ts";
import { parseRules } from "../rules/engine.ts";
import { QLL_DEFAULTS, compileLifecycleRules } from "../github/pr-automation.ts";
import { classifyGithubError } from "../github/errors.ts";
import { OperationError, backfill, replayDelivery } from "../operations/tooling.ts";
import type { BackfillCursor, GithubRequester, ReplayJob } from "../operations/tooling.ts";
import { HttpError, hasBody, isJsonContentType, readJsonBody, sendJson } from "./http.ts";
import type { GithubUserLookup, MappingVerifier, WorkspaceMemberCheck } from "./mapping-check.ts";
import { authenticateInstanceAdmin, authenticateWorkspaceAdmin, listInstanceWorkspaces } from "./plane-auth.ts";
import { listMembers, listProjects, listStates } from "./plane-directory.ts";
import type { PlaneDirectory } from "./plane-directory.ts";
import { previewRules } from "./dry-run.ts";
import type { Viewer } from "./plane-auth.ts";
import {
  CONFLICT_FIELDS, DEFAULT_CONFLICT_POLICIES, DEFAULT_INSTANCE_SETTINGS, DEFAULT_MAGIC_WORDS, MAGIC_TIERS, SLUG_PATTERN,
  ValidationError, isValidPlaneId, parseConflictPolicies, parseGithubApp, parseInstanceSettings, parseMagicWords,
  isValidGithubLogin, isValidRepoFullName, parseDryRun, parseInstallationEntry, parseMappingInput, parseOwnerHandoff, parseRulesBody, parseUserLink,
} from "./validate.ts";
import type { ConflictField, ConflictPolicy, InstanceSettings, MagicTier } from "./validate.ts";

export { createUiRoutes, defaultUiDistDir } from "./static.ts";

/** What replay and backfill need from the running service; absent in a config-only deployment (those endpoints then answer 503). */

export interface OperationsDeps {
  /**
   * Explicitly retries one failed outbound write, scoped to the workspace that owns it (round-4 F3, supplied by the ordered
   * outbox). A row of another workspace must answer not-found, never retry. Without it the route answers 503.
   */
  retryFailed?(id: string, workspaceSlug: string): Promise<unknown>;
  // Answer: { ok: true, retried: boolean } — retried:false (no such failed row in the workspace) is a 404.
  enqueue(job: ReplayJob): Promise<void>;
  /** `installationId` is the mapping's own installation, already checked against the calling workspace's allow-list. */
  githubFor(repo: { ghRepoId: number; owner: string; repo: string; installationId: number }): Promise<GithubRequester>;
  resolveIssue(slug: string, key: string): Promise<{ projectId: string; issueId: string } | null | undefined>;
}

export interface ConfigApiDeps {
  db: Db;
  planeInternalUrl: string;
  planeSessionCookieName?: string;
  planeDirectory?: PlaneDirectory;
  requireVerifiedCommitsDefault?: boolean;
  setupCheck?: () => Promise<SetupCheckResult>;
  githubOAuthConfig?: OAuthAppEnv;
  appRequest?: ConnectDeps["appRequest"];
  /** Resolve repositories with the configured host and workspace-approved installation. */
  lookupGithubRepo?: (slug: string, fullName: string) => Promise<{ id: number; fullName: string }>;
  /** Reconcile mapped repositories after an instance admin approves installation access. */
  refreshInstallation?: (installationId: number) => Promise<void>;
  publicOrigin: string;
  tokenKey: Buffer;
  fetch?: typeof fetch;
  operations?: OperationsDeps;
  /**
   * Checks that a mapping's Plane project belongs to the workspace and its repository is reachable through
   * the GitHub App (see `createMappingVerifier`). Mapping writes FAIL CLOSED without it (503): a missing
   * verifier must never mean "allow".
   */
  verifyMapping?: MappingVerifier;
  /**
   * Resolves a GitHub login to its canonical login and numeric id on the configured host (see `createGithubUserLookup`);
   * null means the account does not exist. Manual user links FAIL CLOSED (503) without it.
   */
  lookupGithubUser?: GithubUserLookup;
  /**
   * The credential source the service actually verifies with (`CredentialSource.describe`). Health reports it instead of
   * re-deriving the source from row existence; without it health falls back to the stored-row check.
   */
  credentialStatus?: () => Promise<{ source: "database" | "environment"; decryptOk: boolean }>;
  /** Whether a Plane user belongs to the workspace (see `createPlaneMemberCheck`). User links FAIL CLOSED (503) without it. */
  isWorkspaceMember?: WorkspaceMemberCheck;
}

const API = "/git-sync/api";

interface Ctx<V> {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  viewer: V;
  body(): Promise<unknown>;
}

type Row = Record<string, any>;

function errorCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null ? (e as { code?: string }).code : undefined;
}

export function createConfigRoutes(deps: ConfigApiDeps): Route[] {
  const { db } = deps;
  const origin = new URL(deps.publicOrigin).origin;
  const vault = new TokenVault(new PgTokenStore(db), deps.tokenKey);
  const authDeps = { planeInternalUrl: deps.planeInternalUrl, planeSessionCookieName: deps.planeSessionCookieName, fetch: deps.fetch };
  const routes: Route[] = [];

  /** Cross-site write protection runs before anything else: cookies make CSRF the main threat. */
  function guardWrite(req: IncomingMessage): void {
    if (req.method === "GET" || req.method === "HEAD") return;
    if (req.headers.origin !== origin) throw new HttpError(403, "Cross-site request refused");
    if (hasBody(req) && !isJsonContentType(req.headers["content-type"])) {
      throw new HttpError(415, "Content-Type must be application/json");
    }
  }

  function add<V>(
    method: string, path: string,
    authenticate: (req: IncomingMessage, params: Record<string, string>) => Promise<V>,
    handler: (ctx: Ctx<V>) => Promise<void>,
  ): void {
    routes.push({
      method, path: API + path,
      handler: async (req, res, params) => {
        try {
          guardWrite(req);
          const viewer = await authenticate(req, params);
          await handler({ req, res, params, viewer, body: () => readJsonBody(req) });
        } catch (e) {
          if (e instanceof ClaimRefused) {
            sendJson(res, e.status, { error: e.message, reason: e.reason });
          } else if (e instanceof HttpError) {
            sendJson(res, e.status, { error: e.message }, e.status === 413 ? { connection: "close" } : {});
          } else if (e instanceof OperationError) {
            sendJson(res, e.status, { error: e.message });
          } else if (e instanceof ValidationError) {
            sendJson(res, 422, { error: e.message });
          } else if (classifyGithubError(e).kind === "rate_limited") {
            const failure = classifyGithubError(e);
            if (failure.kind === "rate_limited") sendJson(res, 429,
              { error: "GitHub rate limit reached; retry after the indicated deadline", retryAt: failure.retryAt },
              { "retry-after": String(Math.max(1, Math.ceil((failure.retryAt - Date.now()) / 1000))) });
          } else {
            console.error("config api error:", e instanceof Error ? e.message : "unknown");
            sendJson(res, 500, { error: "Internal error" });
          }
        }
      },
    });
  }

  /**
   * Audit S2: every slug-keyed row belongs to the Plane workspace first seen under that slug. Plane frees a deleted
   * workspace's slug, so a workspace that reuses it is refused until an instance admin purges the old data.
   */
  async function bindWorkspaceIdentity(slug: string, viewer: Viewer): Promise<Viewer> {
    if (!viewer.workspaceId) throw new HttpError(502, "Plane did not identify the workspace");
    await db.query(`INSERT INTO workspace_identity (workspace_slug, plane_workspace_id) VALUES ($1, $2) ON CONFLICT (workspace_slug) DO NOTHING`,
      [slug, viewer.workspaceId]);
    const bound = (await db.query<{ plane_workspace_id: string }>(`SELECT plane_workspace_id FROM workspace_identity WHERE workspace_slug = $1`, [slug])).rows[0];
    if (bound?.plane_workspace_id !== viewer.workspaceId) {
      throw new HttpError(409, "This workspace address belonged to a Plane workspace that was deleted. An instance admin must remove its old git-sync data before it can be used again.");
    }
    return viewer;
  }

  // Viewers let through while the database was unreachable; their route must bind before it reads any data.
  const unboundViewers = new WeakSet<Viewer>();
  const workspace = (method: string, path: string, handler: (ctx: Ctx<Viewer> & { slug: string }) => Promise<void>,
    opts: { tolerateDatabaseOutage?: boolean } = {}) =>
    add<Viewer>(method, "/workspaces/:slug" + path, async (req, params) => {
      const slug = params.slug ?? "";
      if (!SLUG_PATTERN.test(slug)) throw new HttpError(404, "Not found");
      const viewer = await authenticateWorkspaceAdmin(authDeps, req, slug);
      try { return await bindWorkspaceIdentity(slug, viewer); }
      catch (err) {
        // Health must still say the database is down; it binds again before reading anything (audit S2).
        if (!opts.tolerateDatabaseOutage || err instanceof HttpError) throw err;
        unboundViewers.add(viewer);
        return viewer;
      }
    }, (ctx) => handler({ ...ctx, slug: ctx.params.slug! }));

  const instance = (method: string, path: string, handler: (ctx: Ctx<Viewer>) => Promise<void>) =>
    add<Viewer>(method, "/instance" + path, (req) => authenticateInstanceAdmin(authDeps, req), handler);

  const member = (method: string, path: string, handler: (ctx: Ctx<Viewer> & { slug: string }) => Promise<void>) =>
    add<Viewer>(method, "/workspaces/:slug" + path, async (req, params) => {
      if (!SLUG_PATTERN.test(params.slug ?? "")) throw new HttpError(404, "Not found");
      return bindWorkspaceIdentity(params.slug!, await authenticateWorkspaceMember(authDeps, req, params.slug!));
    }, (ctx) => handler({ ...ctx, slug: ctx.params.slug! }));
  const connectDeps = (requireAppRequest = true): ConnectDeps => {
    if (requireAppRequest && !deps.appRequest) throw new HttpError(503, "GitHub connection is not configured in this deployment");
    return { db, tokenKey: deps.tokenKey, publicOrigin: deps.publicOrigin, config: deps.githubOAuthConfig ?? {},
      appRequest: deps.appRequest ?? (async () => { throw new HttpError(503, "App authentication is unavailable"); }), refreshInstallation: deps.refreshInstallation, fetch: deps.fetch,
      settingsUrl: (slug) => `${origin}/git-sync/ui/workspaces/${encodeURIComponent(slug)}`,
      accountUrl: (slug) => `${origin}/git-sync/ui/workspaces/${encodeURIComponent(slug)}/account` };
  };
  workspace("GET", "/github/connection", async ({ res, slug, viewer }) => sendJson(res, 200, await getConnection(connectDeps(), { slug, viewer })));
  workspace("POST", "/github/connect", async ({ res, slug, viewer }) => sendJson(res, 200, await startInstall(connectDeps(), { slug, viewer })));
  workspace("POST", "/github/connect/handoff", async ({ req, res, slug, viewer, body }) => {
    // Audit S3: the link is bound to one organization; the claim refuses any installation on another account.
    if (!hasBody(req)) throw new ValidationError("Name the GitHub organization: accountId or accountLogin");
    const input = parseOwnerHandoff(await body());
    let accountId: number;
    if ("accountId" in input) accountId = input.accountId;
    else {
      if (!deps.lookupGithubUser) throw new HttpError(503, "GitHub account lookup is not configured");
      const found = await deps.lookupGithubUser(input.accountLogin);
      if (!found) throw new ValidationError("That GitHub organization does not exist");
      accountId = found.id;
    }
    sendJson(res, 200, await createOwnerHandoff(connectDeps(), { slug, viewer, accountId }));
  });
  workspace("GET", "/github/claimable", async ({ res, slug, viewer }) => sendJson(res, 200, await listClaimableInstallations(connectDeps(), { slug, viewer })));
  workspace("POST", "/github/installations/:installationId/claim", async ({ res, slug, viewer, params }) => sendJson(res, 200,
    await claimInstallation(connectDeps(), { slug, viewer, installationId: installationId(params.installationId) })));
  workspace("DELETE", "/github/installations/:installationId", async ({ res, slug, params }) => {
    await disconnectInstallation(connectDeps(), { slug, installationId: installationId(params.installationId) }); sendJson(res, 204);
  });
  workspace("GET", "/github/repositories", async ({ req, res, slug, viewer }) => {
    const id = new URL(req.url ?? "/", origin).searchParams.get("installationId");
    sendJson(res, 200, await listPickableRepositories(connectDeps(), { slug, viewer, ...(id !== null ? { installationId: installationId(id) } : {}) }));
  });
  member("GET", "/github/account", async ({ res, slug, viewer }) => sendJson(res, 200, await getPersonalLink(connectDeps(), { slug, viewer })));
  member("POST", "/github/account/connect", async ({ res, slug, viewer }) => sendJson(res, 200, await startGithubAuthorization(connectDeps(), { slug, viewer })));
  member("DELETE", "/github/account", async ({ res, slug, viewer }) => { await disconnectPersonalAccount(connectDeps(), { slug, viewer }); sendJson(res, 204); });
  for (const [path, callback] of [["/git-sync/install/github/callback", handleInstallCallback], ["/git-sync/oauth/github/callback", handleOAuthCallback]] as const) {
    routes.push({ method: "GET", path, handler: async (req, res) => {
      let returnUrl: string | undefined;
      let callbackQuery: URLSearchParams | undefined;
      const redirect = (location: string) => {
        res.writeHead(302, { location, "cache-control": "no-store", "referrer-policy": "no-referrer" }); res.end();
      };
      try {
        callbackQuery = new URL(req.url ?? "/", origin).searchParams;
        const connection = connectDeps();
        const result = await callback(connection, { query: callbackQuery,
          authenticate: async (slug, level) => {
            const viewer = await bindWorkspaceIdentity(slug,
              await (level === "admin" ? authenticateWorkspaceAdmin(authDeps, req, slug) : authenticateWorkspaceMember(authDeps, req, slug)));
            returnUrl = level === "admin" ? connection.settingsUrl!(slug) : connection.accountUrl!(slug);
            return viewer;
          } });
        redirect(result.location);
      } catch (err) {
        // The request URL contains the authorization code and state. Log only the failure message.
        let message = err instanceof Error ? err.message : "unknown failure";
        for (const field of ["code", "state"]) {
          for (const secret of callbackQuery?.getAll(field) ?? []) {
            if (!secret) continue;
            message = message.split(secret).join("[redacted]").split(encodeURIComponent(secret)).join("[redacted]");
          }
        }
        console.error("GitHub callback failed:", message.replace(/https?:\/\/[^\s]+/gi, "[URL omitted]").slice(0, 500));
        const failed = new URL(returnUrl ?? `${origin}/`);
        failed.searchParams.set(path.includes("/oauth/") ? "github" : "connect", "error");
        failed.searchParams.set("reason", err instanceof HttpError && err.status === 503 ? "not_configured" : "internal");
        redirect(failed.toString());
      }
    } });
  }

  // ---- helpers over A3's tables ------------------------------------------------------------------
  const mappingDto = (r: Row) => ({
    id: Number(r.id),
    workspaceSlug: r.workspace_slug as string,
    ghRepoId: Number(r.gh_repo_id),
    ghRepoFullName: r.gh_repo_full_name as string,
    planeProjectId: r.plane_project_id as string,
    syncDirection: r.sync_direction as string,
    smartCommitsEnabled: r.smart_commits_enabled as boolean,
    linkbackComments: r.linkback_enabled as boolean,
    autolinks: r.autolinks_enabled as boolean,
    reportProblems: Boolean(r.report_problems),
    openStateId: (r.open_state_id ?? null) as string | null,
    closedStateId: (r.closed_state_id ?? null) as string | null,
  });

  /** Refuses (422) a project outside the workspace or a repository the App cannot reach; Plane/GitHub outages are 502. */
  async function authoriseMapping(slug: string, check: { planeProjectId: string; repo: { id: number; fullName: string } }): Promise<number> {
    if (!deps.verifyMapping) throw new HttpError(503, "Mapping verification is not configured, so mappings cannot be changed");
    let reason: string | null;
    let installationId: number | undefined;
    try {
      reason = await deps.verifyMapping({ slug, ...check, onInstallationVerified: (id) => { installationId = id; } });
    } catch (e) {
      if (classifyGithubError(e).kind === "rate_limited") throw e;
      console.error("mapping verification failed:", e instanceof Error ? e.message : "unknown");
      throw new HttpError(502, "Could not verify the mapping with Plane and GitHub");
    }
    if (reason) throw new ValidationError(reason);
    if (installationId === undefined || !Number.isSafeInteger(installationId) || installationId <= 0) throw new HttpError(503, "Mapping verification did not establish GitHub installation authority");
    return installationId;
  }

  /** The mapping must belong to the workspace in the path; anything else is 404, never a cross-workspace write. */
  async function loadMapping(slug: string, rawId: string | undefined): Promise<Row> {
    if (!rawId || !/^\d{1,9}$/.test(rawId)) throw new HttpError(404, "Mapping not found");
    const { rows } = await db.query(`SELECT * FROM repo_mappings WHERE id = $1 AND workspace_slug = $2`, [Number(rawId), slug]);
    if (!rows[0]) throw new HttpError(404, "Mapping not found");
    return rows[0];
  }

  async function readInstanceSettings(): Promise<InstanceSettings> {
    const { rows } = await db.query(`SELECT * FROM instance_settings WHERE id = 1`);
    const r = rows[0];
    const requireVerifiedCommits = await readRequireVerifiedCommits(db, deps.requireVerifiedCommitsDefault ?? false);
    if (!r) return { ...DEFAULT_INSTANCE_SETTINGS, requireVerifiedCommits };
    return {
      requireVerifiedCommits,
      smartCommitsDefault: r.smart_commits_default,
      reconciliationIntervalMinutes: Number(r.reconciliation_interval_minutes),
      opTtlMinutes: Number(r.op_ttl_minutes),
    };
  }

  async function directoryRead<T>(load: (plane: PlaneDirectory) => Promise<T>): Promise<T> {
    if (!deps.planeDirectory) throw new HttpError(503, "Plane directory lookup is not configured");
    try { return await load(deps.planeDirectory); }
    catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, "Could not load names and choices from Plane; try again");
    }
  }

  instance("GET", "/setup-check", async ({ res }) => {
    if (!deps.setupCheck) throw new HttpError(503, "Setup checks are unavailable in this deployment");
    sendJson(res, 200, await deps.setupCheck());
  });

  workspace("GET", "/defaults", async ({ res }) => sendJson(res, 200, { smartCommitsDefault: (await readInstanceSettings()).smartCommitsDefault }));
  workspace("GET", "/projects", async ({ res, slug }) => sendJson(res, 200, await directoryRead((plane) => listProjects(plane, slug))));
  workspace("GET", "/members", async ({ res, slug }) => sendJson(res, 200, await directoryRead((plane) => listMembers(plane, slug))));
  workspace("GET", "/projects/:projectId/states", async ({ res, slug, params }) => {
    if (!isValidPlaneId(params.projectId ?? "")) throw new HttpError(404, "Project not found");
    sendJson(res, 200, await directoryRead((plane) => listStates(plane, slug, params.projectId!)));
  });
  instance("GET", "/workspaces", async ({ req, res }) => sendJson(res, 200, await listInstanceWorkspaces(authDeps, req)));

  /**
   * Audit S2: removes a deleted Plane workspace's git-sync data so a new workspace may use its slug. Refused while the
   * slug still belongs to the workspace that owns the data.
   */
  instance("DELETE", "/workspaces/:slug/stale-data", async ({ req, res, params }) => {
    const slug = params.slug ?? "";
    if (!SLUG_PATTERN.test(slug)) throw new HttpError(404, "Not found");
    const bound = (await db.query<{ plane_workspace_id: string }>(`SELECT plane_workspace_id FROM workspace_identity WHERE workspace_slug = $1`, [slug])).rows[0];
    if (!bound) throw new HttpError(404, "No git-sync data is bound to that workspace address");
    const live = (await listInstanceWorkspaces(authDeps, req)).find((w) => w.slug === slug);
    if (live?.id === bound.plane_workspace_id) throw new HttpError(409, "That address still belongs to the workspace that owns the data");
    const purge = async (conn: Db) => {
      await conn.exec("BEGIN");
      try {
        const audit = `SELECT a.id FROM audit_log a WHERE ${auditWorkspace} = $1`;
        await conn.query(`UPDATE audit_log SET replay_of = NULL WHERE replay_of IN (${audit})`, [slug]);
        await conn.query(`DELETE FROM audit_log WHERE id IN (${audit})`, [slug]);
        for (const table of ["workspace_installations", "repo_mappings", "user_map", "user_link_tombstones", "user_link_locks",
          "oauth_states", "outbound_writes", "processed_commits", "workspace_identity"])
          await conn.query(`DELETE FROM ${table} WHERE workspace_slug = $1`, [slug]);
        await conn.query(`DELETE FROM sync_links WHERE plane_workspace_slug = $1`, [slug]);
        await conn.query(`INSERT INTO audit_log (kind, source, outcome, detail) VALUES ('workspace_data_purged', 'plane', 'applied', $1)`,
          [{ workspaceSlug: slug, previousWorkspaceId: bound.plane_workspace_id }]);
        await conn.exec("COMMIT");
      } catch (err) { await conn.exec("ROLLBACK"); throw err; }
    };
    await (db.withConnection ? db.withConnection(purge) : purge(db));
    sendJson(res, 204);
  });
  instance("GET", "/workspaces/:slug/projects", async ({ res, params }) => {
    if (!SLUG_PATTERN.test(params.slug ?? "")) throw new HttpError(404, "Workspace not found");
    sendJson(res, 200, await directoryRead((plane) => listProjects(plane, params.slug!)));
  });

  // Workspace authentication precedes every lookup; no browser request goes to api.github.com.
  workspace("GET", "/github/user", async ({ req, res }) => {
    const login = new URL(req.url ?? "/", "http://localhost").searchParams.get("login") ?? "";
    if (!isValidGithubLogin(login)) throw new ValidationError("Enter a valid GitHub username");
    if (!deps.lookupGithubUser) throw new HttpError(503, "GitHub account lookup is not configured");
    const user = await githubRead(() => deps.lookupGithubUser!(login));
    if (!user) throw new HttpError(404, "That GitHub account does not exist");
    sendJson(res, 200, user);
  });

  workspace("GET", "/github/repository", async ({ req, res, slug, viewer }) => {
    const name = new URL(req.url ?? "/", "http://localhost").searchParams.get("name") ?? "";
    if (!isValidRepoFullName(name)) throw new ValidationError("Enter the repository as owner/repo");
    const choices = await listPickableRepositories(connectDeps(), { slug, viewer });
    if (choices.needsGithubAccount || choices.needsReauth) throw new HttpError(409, "Connect or reconnect your personal GitHub account first");
    const repo = choices.repositories.find((item) => item.fullName.toLowerCase() === name.toLowerCase());
    if (!repo) throw new HttpError(403, "Your GitHub account cannot access that repository in this workspace");
    sendJson(res, 200, { id: repo.id, fullName: repo.fullName });
  });

  async function githubRead<T>(read: () => Promise<T>): Promise<T> {
    try { return await read(); }
    catch (err) {
      if (err instanceof HttpError) throw err;
      const failure = classifyGithubError(err);
      if (failure.kind === "rate_limited") throw err; // handled with its full retry deadline below
      if (failure.kind === "permission") throw new HttpError(403, "GitHub access is not allowed");
      if (failure.kind === "not_found") throw new HttpError(404, "GitHub does not know that name");
      throw new HttpError(502, "Could not verify the account or repository with GitHub");
    }
  }

  // ---- workspace: mappings -----------------------------------------------------------------------
  workspace("GET", "/mappings", async ({ res, slug }) => {
    const { rows } = await db.query(`SELECT * FROM repo_mappings WHERE workspace_slug = $1 ORDER BY id`, [slug]);
    sendJson(res, 200, rows.map(mappingDto));
  });

  async function validateMappingStates(slug: string, projectId: string, open: string | null, closed: string | null): Promise<void> {
    if (open && open === closed) throw new ValidationError("Open and closed states must differ");
    if (!open && !closed) return;
    const states = await directoryRead((plane) => listStates(plane, slug, projectId));
    for (const id of [open, closed]) {
      if (id && !states.some((state) => state.id === id && state.group !== "triage")) {
        throw new ValidationError("Choose an available, non-triage state from the selected Plane project");
      }
    }
  }
  async function mappingTransaction<T>(work: (conn: Db) => Promise<T>): Promise<T> {
    const run = async (conn: Db) => {
      await conn.exec("BEGIN");
      try { const result = await work(conn); await conn.exec("COMMIT"); return result; }
      catch (err) {
        await conn.exec("ROLLBACK");
        if (errorCode(err) === "23514") throw new ValidationError("Invalid mapping settings; open and closed states must differ");
        throw err;
      }
    };
    return db.withConnection ? db.withConnection(run) : run(db);
  }

  async function createMapping({ res, slug, body, viewer }: Ctx<Viewer> & { slug: string }, manual = false): Promise<void> {
    const input = parseMappingInput(await body(), false);
    if (!manual) { const repo = await assertRepositoryPickable(connectDeps(), { slug, viewer, ghRepoId: input.ghRepoId! }); input.ghRepoFullName = repo.fullName; }
    const installationId = await authoriseMapping(slug, { planeProjectId: input.planeProjectId!, repo: { id: input.ghRepoId!, fullName: input.ghRepoFullName! } });
    const dup = await db.query(
      `SELECT 1 FROM repo_mappings WHERE workspace_slug = $1 AND gh_repo_id = $2 AND plane_project_id = $3`,
      [slug, input.ghRepoId, input.planeProjectId]);
    if (dup.rows.length) throw new HttpError(409, "That repository is already mapped to that project");
    const smartDefault = (await readInstanceSettings()).smartCommitsDefault;
    await validateMappingStates(slug, input.planeProjectId!, input.openStateId ?? null, input.closedStateId ?? null);
    const id = await mappingTransaction(async (conn) => {
      const { rows } = await conn.query(
        `INSERT INTO repo_mappings (workspace_slug, gh_repo_id, gh_repo_full_name, plane_project_id, sync_direction,
           smart_commits_enabled, linkback_enabled, autolinks_enabled, installation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [slug, input.ghRepoId, input.ghRepoFullName, input.planeProjectId, input.syncDirection ?? "bidirectional",
          input.smartCommitsEnabled ?? smartDefault, input.linkbackComments ?? true, input.autolinks ?? false, installationId]);
      const mappingId = Number(rows[0].id);
      if (input.openStateId !== undefined || input.closedStateId !== undefined || input.reportProblems !== undefined) {
        await updateMappingParity(conn, mappingId, { openStateId: input.openStateId, closedStateId: input.closedStateId, reportProblems: input.reportProblems });
      }
      return mappingId;
    });
    sendJson(res, 201, { id });
  }
  workspace("POST", "/mappings", createMapping);
  instance("POST", "/workspaces/:slug/mappings", async (ctx) => {
    if (!SLUG_PATTERN.test(ctx.params.slug ?? "")) throw new HttpError(404, "Not found");
    await createMapping({ ...ctx, slug: ctx.params.slug! }, true);
  });

  async function updateMapping({ res, slug, params, body, viewer }: Ctx<Viewer> & { slug: string }, manual = false): Promise<void> {
    const current = await loadMapping(slug, params.id);
    const input = parseMappingInput(await body(), true);
    if (!manual && input.ghRepoId !== undefined && input.ghRepoId !== Number(current.gh_repo_id)) {
      const repo = await assertRepositoryPickable(connectDeps(), { slug, viewer, ghRepoId: input.ghRepoId });
      input.ghRepoFullName = repo.fullName;
    }
    const installationId = await authoriseMapping(slug, {
      planeProjectId: input.planeProjectId ?? current.plane_project_id,
      repo: { id: input.ghRepoId ?? Number(current.gh_repo_id), fullName: input.ghRepoFullName ?? current.gh_repo_full_name },
    });
    const projectChanged = input.planeProjectId !== undefined && input.planeProjectId !== current.plane_project_id;
    const statePatch = { openStateId: input.openStateId ?? (input.openStateId === null || projectChanged ? null : undefined),
      closedStateId: input.closedStateId ?? (input.closedStateId === null || projectChanged ? null : undefined) };
    if (statePatch.openStateId !== undefined || statePatch.closedStateId !== undefined) {
      await validateMappingStates(slug, input.planeProjectId ?? current.plane_project_id,
        statePatch.openStateId === undefined ? current.open_state_id ?? null : statePatch.openStateId,
        statePatch.closedStateId === undefined ? current.closed_state_id ?? null : statePatch.closedStateId);
    }
    const columns: Record<string, unknown> = {
      gh_repo_id: input.ghRepoId, gh_repo_full_name: input.ghRepoFullName, plane_project_id: input.planeProjectId,
      sync_direction: input.syncDirection, smart_commits_enabled: input.smartCommitsEnabled,
      linkback_enabled: input.linkbackComments, autolinks_enabled: input.autolinks,
      installation_id: installationId,
    };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [col, v] of Object.entries(columns)) {
      if (v === undefined) continue;
      values.push(v);
      sets.push(`${col} = $${values.length}`);
    }
    values.push(Number(params.id), slug);
    const row = await mappingTransaction(async (conn) => {
      const live = (await conn.query("SELECT * FROM repo_mappings WHERE id = $1 AND workspace_slug = $2 FOR UPDATE", [Number(params.id), slug])).rows[0];
      if (!live) throw new HttpError(404, "Mapping not found");
      const checkedFields = ["gh_repo_id", "gh_repo_full_name", "plane_project_id", "installation_id",
        ...(statePatch.openStateId !== undefined || statePatch.closedStateId !== undefined ? ["open_state_id", "closed_state_id"] : [])];
      if (checkedFields.some((field) => String(live[field] ?? "") !== String(current[field] ?? ""))) {
        throw new HttpError(409, "The mapping changed during verification. Reload it and try again");
      }
      const { rows } = await conn.query(
        `UPDATE repo_mappings SET ${sets.join(", ")} WHERE id = $${values.length - 1} AND workspace_slug = $${values.length} RETURNING *`, values);
      if (!rows[0]) throw new HttpError(404, "Mapping not found");
      if (statePatch.openStateId !== undefined || statePatch.closedStateId !== undefined || input.reportProblems !== undefined) {
        await updateMappingParity(conn, Number(params.id), { ...statePatch, reportProblems: input.reportProblems });
        return (await conn.query("SELECT * FROM repo_mappings WHERE id = $1 AND workspace_slug = $2", [Number(params.id), slug])).rows[0]!;
      }
      return rows[0];
    });
    sendJson(res, 200, mappingDto(row));
  }
  workspace("PATCH", "/mappings/:id", updateMapping);
  instance("PATCH", "/workspaces/:slug/mappings/:id", async (ctx) => {
    if (!SLUG_PATTERN.test(ctx.params.slug ?? "")) throw new HttpError(404, "Not found");
    await updateMapping({ ...ctx, slug: ctx.params.slug! }, true);
  });

  workspace("DELETE", "/mappings/:id", async ({ res, slug, params }) => {
    await loadMapping(slug, params.id);
    await db.query(`DELETE FROM repo_mappings WHERE id = $1 AND workspace_slug = $2`, [Number(params.id), slug]);
    sendJson(res, 204);
  });

  // ---- workspace: rules (one versioned surface, §7.5) --------------------------------------------
  workspace("GET", "/mappings/:id/rules", async ({ res, slug, params }) => {
    const m = await loadMapping(slug, params.id);
    const { rows } = await db.query(
      `SELECT yaml_source, version, updated_by, updated_at FROM rule_sets WHERE mapping_id = $1 ORDER BY version DESC LIMIT 1`, [m.id]);
    const r = rows[0];
    sendJson(res, 200, r
      ? { yaml: r.yaml_source, version: Number(r.version), updatedBy: r.updated_by, updatedAt: r.updated_at }
      : { yaml: "", version: 0, updatedBy: null, updatedAt: null });
  });

  async function saveRulesVersion(mappingId: number, source: string, author: string): Promise<number> {
    try {
      parseRules(source);
    } catch (e) {
      throw new ValidationError(e instanceof Error ? e.message.slice(0, 500) : "Rules are invalid");
    }
    // Each accepted save is a new version; a concurrent save loses the unique race and retries.
    for (let attempt = 0; ; attempt++) {
      try {
        const { rows } = await db.query(
          `INSERT INTO rule_sets (mapping_id, yaml_source, version, updated_by)
           SELECT $1::int, $2::text, COALESCE(MAX(version), 0) + 1, $3::text FROM rule_sets WHERE mapping_id = $1::int
           RETURNING version`, [mappingId, source, author]);
        return Number(rows[0].version);
      } catch (e) {
        if (errorCode(e) !== "23505" || attempt >= 4) throw e;
      }
    }
  }

  workspace("PUT", "/mappings/:id/rules", async ({ res, slug, params, body, viewer }) => {
    const m = await loadMapping(slug, params.id);
    sendJson(res, 200, { version: await saveRulesVersion(Number(m.id), parseRulesBody(await body()), viewer.id) });
  });
  workspace("GET", "/mappings/:id/rules/versions", async ({ res, slug, params }) => {
    const m = await loadMapping(slug, params.id);
    const { rows } = await db.query("SELECT version, updated_by, updated_at FROM rule_sets WHERE mapping_id = $1 ORDER BY version DESC", [m.id]);
    sendJson(res, 200, rows.map((row) => ({ version: Number(row.version), updatedBy: row.updated_by, updatedAt: row.updated_at })));
  });
  workspace("POST", "/mappings/:id/rules/versions/:version/restore", async ({ res, slug, params, viewer }) => {
    const m = await loadMapping(slug, params.id);
    if (!/^\d{1,10}$/.test(params.version ?? "") || Number(params.version) < 1) throw new HttpError(404, "Rule version not found");
    const { rows } = await db.query("SELECT yaml_source FROM rule_sets WHERE mapping_id = $1 AND version = $2", [m.id, Number(params.version)]);
    if (!rows[0]) throw new HttpError(404, "Rule version not found");
    const version = await saveRulesVersion(Number(m.id), rows[0].yaml_source, viewer.id);
    sendJson(res, 200, { version, yaml: rows[0].yaml_source });
  });

  // ---- workspace: conflict policies (§7.3) --------------------------------------------------------
  async function policiesFor(mappingId: number): Promise<Record<ConflictField, ConflictPolicy>> {
    const { rows } = await db.query(`SELECT field, policy FROM conflict_policies WHERE mapping_id = $1`, [mappingId]);
    const out = { ...DEFAULT_CONFLICT_POLICIES };
    for (const r of rows) if ((CONFLICT_FIELDS as readonly string[]).includes(r.field)) out[r.field as ConflictField] = r.policy;
    return out;
  }

  workspace("GET", "/mappings/:id/conflict-policies", async ({ res, slug, params }) => {
    const m = await loadMapping(slug, params.id);
    sendJson(res, 200, await policiesFor(Number(m.id)));
  });

  workspace("PUT", "/mappings/:id/conflict-policies", async ({ res, slug, params, body }) => {
    const m = await loadMapping(slug, params.id);
    const input = parseConflictPolicies(await body());
    const entries = Object.entries(input);
    const values: unknown[] = [Number(m.id)];
    const tuples = entries.map(([field, policy]) => {
      values.push(field, policy);
      return `($1, $${values.length - 1}, $${values.length})`;
    });
    await db.query(
      `INSERT INTO conflict_policies (mapping_id, field, policy) VALUES ${tuples.join(", ")}
       ON CONFLICT (mapping_id, field) DO UPDATE SET policy = EXCLUDED.policy`, values);
    sendJson(res, 200, await policiesFor(Number(m.id)));
  });

  // ---- workspace: user links (§9) -----------------------------------------------------------------
  const planeUserId = (raw: string | undefined): string => {
    if (!raw || !isValidPlaneId(raw)) throw new HttpError(404, "User not found");
    return raw;
  };

  workspace("GET", "/user-links", async ({ res, slug }) => {
    const { rows } = await db.query(
      `SELECT u.plane_user_id, u.gh_login, u.gh_id, COALESCE(t.needs_reauth, false) AS needs_reauth FROM user_map u LEFT JOIN user_tokens t ON t.plane_user_id = u.plane_user_id AND t.kind = 'github_oauth' WHERE u.workspace_slug = $1 ORDER BY u.gh_login`, [slug]);
    sendJson(res, 200, rows.map((r) => ({ planeUserId: r.plane_user_id, githubLogin: r.gh_login, githubId: Number(r.gh_id), needsReauth: Boolean(r.needs_reauth) })));
  });

  workspace("PUT", "/user-links/:planeUserId", async ({ res, slug, params, body }) => {
    const userId = planeUserId(params.planeUserId);
    const parsedLink = parseUserLink(await body());
    if (!deps.lookupGithubUser || !deps.isWorkspaceMember) throw new HttpError(503, "GitHub account verification is not configured, so user links cannot be changed");
    let found: Awaited<ReturnType<GithubUserLookup>>;
    let member: boolean;
    try {
      [found, member] = await Promise.all([deps.lookupGithubUser(parsedLink.githubLogin), deps.isWorkspaceMember(slug, userId)]);
    } catch (e) {
      if (classifyGithubError(e).kind === "rate_limited") throw e;
      console.error("user link verification failed:", e instanceof Error ? e.message : "unknown");
      throw new HttpError(502, "Could not verify the GitHub account and workspace membership");
    }
    if (!found) throw new ValidationError("That GitHub account does not exist");
    if (found.id !== parsedLink.githubId) throw new ValidationError("githubId does not match that GitHub login");
    if (!member) throw new ValidationError("That Plane user is not a member of this workspace");
    const link = { githubLogin: found.login, githubId: found.id }; // store GitHub's canonical casing
    try {
      await withUserLinkTransaction(db, slug, async (conn) => {
        await conn.query(
          `INSERT INTO user_map (workspace_slug, plane_user_id, gh_login, gh_id) VALUES ($1, $2, $3, $4)
           ON CONFLICT (workspace_slug, plane_user_id) DO UPDATE SET gh_login = EXCLUDED.gh_login, gh_id = EXCLUDED.gh_id`,
          [slug, userId, link.githubLogin, link.githubId]);
        await clearUserLinkTombstone(conn, slug, link.githubId);
      });
    } catch (e) {
      if (errorCode(e) === "23505") throw new HttpError(409, "That GitHub account is already linked to another user in this workspace");
      throw e;
    }
    sendJson(res, 200, { planeUserId: userId, githubLogin: link.githubLogin, githubId: link.githubId });
  });

  workspace("DELETE", "/user-links/:planeUserId", async ({ res, slug, params, viewer }) => {
    const userId = planeUserId(params.planeUserId);
    // Audit S6: the GitHub grant and token are per Plane user, shared by every workspace. One workspace's admin may
    // end them only for themself or for a user no other workspace links; otherwise only this workspace's link goes.
    // (Plane's members list includes removed members, so membership alone cannot prove this admin's authority.)
    // Decided under the workspace link lock (review r5 F7): an auto-link insert in flight finishes first and is then
    // unlinked here, instead of this request answering 404 for a link that is about to exist.
    const revoke = await withUserLinkTransaction(db, slug, async (conn) => {
      if (!(await conn.query("SELECT 1 FROM user_map WHERE workspace_slug = $1 AND plane_user_id = $2", [slug, userId])).rows.length) {
        throw new HttpError(404, "No link for that user");
      }
      const linkedElsewhere = (await conn.query("SELECT 1 FROM user_map WHERE plane_user_id = $1 AND workspace_slug <> $2 LIMIT 1", [userId, slug])).rows.length > 0;
      return viewer.id === userId || !linkedElsewhere;
    });
    // Revocation uses the OAuth client, so a missing App-JWT client must not block local unlink.
    if (revoke) await revokePersonalGrant(connectDeps(false), userId, slug);
    await withUserLinkTransaction(db, slug, async (conn) => {
      const del = await conn.query(`DELETE FROM user_map WHERE workspace_slug = $1 AND plane_user_id = $2 RETURNING id, gh_id`, [slug, userId]);
      if (!del.rows.length) throw new HttpError(404, "No link for that user");
      await addUserLinkTombstone(conn, slug, Number(del.rows[0].gh_id));
      // Tokens are per Plane user: deleted only together with the grant revocation above.
      if (revoke) await new PgTokenStore(conn).delete(userId);
    });
    sendJson(res, 204);
  });

  // Resolve legacy attribution from verified mappings; alerts with no project/workspace stay private.
  const payloadProject = `COALESCE(a.detail->'payload'->'data'->>'project_id', a.detail->'payload'->'data'->'project'->>'id',
    a.detail->'payload'->'data'->>'project', a.detail->'payload'->'data'->'issue'->'project'->>'id',
    a.detail->'payload'->'data'->'issue'->>'project')`;
  const auditMapping = `COALESCE(a.detail->>'mappingId', a.detail->'write'->'_authority'->>'mappingId',
    (SELECT o.write->'_authority'->>'mappingId' FROM outbound_writes o WHERE o.id = a.detail->>'outboxId'))`;
  const auditWorkspace = `COALESCE(a.workspace_slug, a.detail->>'workspaceSlug', a.detail->>'workspace_slug', a.detail->>'workspace',
    (SELECT rm.workspace_slug FROM repo_mappings rm WHERE rm.id::text = ${auditMapping}),
    CASE WHEN a.source = 'github' THEN (SELECT min(rm.workspace_slug) FROM repo_mappings rm
      WHERE rm.gh_repo_id::text = COALESCE(a.detail->>'ghRepoId', a.detail->>'repoId', a.detail->'payload'->'repository'->>'id')
      HAVING count(DISTINCT rm.workspace_slug) = 1) END,
    CASE WHEN a.source = 'plane' THEN (SELECT min(rm.workspace_slug) FROM repo_mappings rm
      WHERE rm.plane_project_id = ${payloadProject} HAVING count(DISTINCT rm.workspace_slug) = 1) END)`;
  const transportAudit = `(a.delivery_id IS NULL OR (a.delivery_id NOT LIKE 'replay-%' AND a.delivery_id NOT LIKE 'backfill-%'
    AND a.delivery_id NOT LIKE 'content:%' AND a.delivery_id NOT LIKE 'github-rate-limit:%'))`;
  const spoolProject = `COALESCE(s.payload->'data'->>'project_id', s.payload->'data'->'project'->>'id', s.payload->'data'->>'project',
    s.payload->'data'->'issue'->'project'->>'id', s.payload->'data'->'issue'->>'project')`;
  const mappingAuditMatch = `(${auditMapping} = m.id::text OR (${auditMapping} IS NULL AND
    (COALESCE(a.detail->>'ghRepoId', a.detail->>'repoId', a.detail->'payload'->'repository'->>'id') = m.gh_repo_id::text
      OR (a.source = 'plane' AND ${payloadProject} = m.plane_project_id))))`;
  const auditError = `(a.error IS NOT NULL OR a.outcome IN ('failed', 'error'))`;
  const time = (value: unknown): string | null => value === null || value === undefined ? null
    : value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();

  async function auditPage(req: IncomingMessage, slug?: string): Promise<unknown> {
    const q = new URL(req.url ?? "/", "http://localhost").searchParams;
    const limitRaw = q.get("limit");
    const beforeRaw = q.get("before");
    const limit = limitRaw === null || limitRaw === "" ? 50 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ValidationError("limit must be between 1 and 200");
    if (beforeRaw !== null && beforeRaw !== "" && !/^\d{1,15}$/.test(beforeRaw)) throw new ValidationError("before must be an audit entry id");
    const before = beforeRaw ? Number(beforeRaw) : null;
    const mappingId = q.get("mappingId");
    if (mappingId && !slug) throw new ValidationError("mappingId needs a workspace audit view");
    if (mappingId) await loadMapping(slug!, mappingId);
    const errors = q.get("errors") === "1";
    const hours = q.get("hours") ? Number(q.get("hours")) : null;
    if (hours !== null && (!Number.isInteger(hours) || hours < 1 || hours > 8760)) throw new ValidationError("hours must be between 1 and 8760");
    const { rows } = await db.query(
      `SELECT a.*, ${auditWorkspace} AS resolved_workspace FROM audit_log a
        LEFT JOIN repo_mappings m ON m.id = $4::int AND m.workspace_slug = $1
        WHERE ($2::bigint IS NULL OR a.id < $2::bigint)
          AND (($1::text IS NOT NULL AND ${auditWorkspace} = $1) OR ($1::text IS NULL AND ($7::boolean OR ${auditWorkspace} IS NULL)))
          AND ($4::int IS NULL OR ${mappingAuditMatch}) AND (NOT $5::boolean OR ${auditError})
          AND ($6::int IS NULL OR a.created_at > now() - interval '1 hour' * $6::int)
        ORDER BY a.id DESC LIMIT $3`, [slug ?? null, before, limit + 1, mappingId ? Number(mappingId) : null, errors, hours, q.get("scope") === "all"]);
    const page = rows.slice(0, limit).map((r) => ({
      id: Number(r.id), kind: r.kind, source: r.source, deliveryId: r.delivery_id, detail: r.detail,
      outcome: r.outcome, error: r.error, replayOf: r.replay_of === null ? null : Number(r.replay_of), createdAt: r.created_at,
      ...(slug === undefined ? { workspaceSlug: r.resolved_workspace ?? null } : {}),
    }));
    return { entries: page, nextBefore: rows.length > limit ? page[page.length - 1]!.id : null };
  }
  workspace("GET", "/audit", async ({ res, req, slug }) => sendJson(res, 200, await auditPage(req, slug)));
  instance("GET", "/audit", async ({ res, req }) => sendJson(res, 200, await auditPage(req)));

  async function databaseReachable(): Promise<boolean> {
    try { await db.query("SELECT 1 AS reachable"); return true; } catch { return false; }
  }

  workspace("GET", "/health", async ({ res, slug, viewer }) => {
    const health: WorkspaceHealth = { database: await databaseReachable(), githubAppCredentials: { source: "unavailable", decryptOk: false },
      planeWebhookSilent: null, mappings: [], setup: { rules: "defaults", policies: "defaults", membersLinked: 0, membersTotal: null, appEventsVerified: null } };
    if (!health.database) { sendJson(res, 200, { ...health, healthError: "Database is unreachable" }); return; }
    if (unboundViewers.has(viewer)) await bindWorkspaceIdentity(slug, viewer);
    try {
      const app = (await db.query("SELECT private_key_v1, webhook_secret_v1 FROM github_app_config WHERE id = 1")).rows[0];
      let decryptOk = true;
      if (app) try { decryptSecret(String(app.private_key_v1), deps.tokenKey); decryptSecret(String(app.webhook_secret_v1), deps.tokenKey); } catch { decryptOk = false; }
      health.githubAppCredentials = await credentialStatus(Boolean(app), decryptOk);
      const rows = (await db.query(`SELECT m.*, wi.installation_id AS allowed_installation,
        GREATEST((SELECT max(a.created_at) FROM audit_log a WHERE ${auditWorkspace} = m.workspace_slug AND a.kind = 'inbound_delivery'
          AND a.source = 'github' AND ${transportAudit} AND ${mappingAuditMatch}),
          (SELECT max(s.received_at) FROM inbound_spool s WHERE s.source = 'github' AND s.payload->'repository'->>'id' = m.gh_repo_id::text)) AS last_github,
        GREATEST((SELECT max(a.created_at) FROM audit_log a WHERE ${auditWorkspace} = m.workspace_slug AND a.kind = 'inbound_delivery'
          AND a.source = 'plane' AND ${transportAudit} AND ${mappingAuditMatch}),
          (SELECT max(s.received_at) FROM inbound_spool s WHERE s.source = 'plane' AND ${spoolProject} = m.plane_project_id)) AS last_plane,
        (SELECT count(*)::int FROM audit_log a WHERE ${auditWorkspace} = m.workspace_slug AND ${mappingAuditMatch}
          AND ${auditError} AND a.created_at > now() - interval '24 hours') AS failures,
        (SELECT max(o.updated_at) FROM outbound_writes o WHERE o.workspace_slug = m.workspace_slug AND o.status = 'applied'
          AND o.write->>'kind' <> 'resume_reducer' AND o.write->'_authority'->>'mappingId' = m.id::text) AS last_write,
        (SELECT max(o.retry_at) FROM outbound_writes o WHERE o.workspace_slug = m.workspace_slug AND o.status = 'pending'
          AND o.retry_at > now() AND o.write->'_authority'->>'mappingId' = m.id::text
          AND (o.error->>'message' ILIKE '%rate limit%' OR o.error->>'message' ILIKE '%429%')) AS retry_at
        FROM repo_mappings m LEFT JOIN workspace_installations wi ON wi.installation_id = m.installation_id AND wi.workspace_slug = m.workspace_slug
        WHERE m.workspace_slug = $1 ORDER BY m.id`, [slug])).rows;
      for (const row of rows) {
        const deadline = Math.max(row.retry_at ? new Date(row.retry_at).getTime() : 0,
          await githubRetryDeadline(db, "app"), row.installation_id ? await githubRetryDeadline(db, `installation:${row.installation_id}`) : 0);
        const mapping: MappingHealth = { mappingId: Number(row.id), lastGithubDeliveryAt: time(row.last_github), lastPlaneDeliveryAt: time(row.last_plane),
          lastSuccessfulWriteAt: time(row.last_write), failuresLast24h: Number(row.failures),
          disabledReason: !row.installation_id ? "Installation has not been verified" : !row.allowed_installation ? "Installation is no longer approved for this workspace" : null,
          rateLimitedUntil: deadline > Date.now() ? new Date(deadline).toISOString() : null };
        health.mappings.push(mapping);
      }
      const silent = (await db.query(`SELECT kind FROM audit_log a WHERE ${auditWorkspace} = $1
        AND kind IN ('plane_webhook_silent', 'plane_webhook_recovered') ORDER BY id DESC LIMIT 1`, [slug])).rows[0];
      health.planeWebhookSilent = silent ? silent.kind === "plane_webhook_silent" : false;
      const counts = (await db.query(`SELECT
        (SELECT count(*)::int FROM user_map WHERE workspace_slug = $1) AS linked,
        (SELECT count(*)::int FROM rule_sets r JOIN repo_mappings m ON m.id = r.mapping_id WHERE m.workspace_slug = $1) AS rules,
        (SELECT count(*)::int FROM conflict_policies c JOIN repo_mappings m ON m.id = c.mapping_id WHERE m.workspace_slug = $1) AS policies`, [slug])).rows[0];
      health.setup.membersLinked = Number(counts?.linked ?? 0);
      health.setup.rules = Number(counts?.rules) ? "custom" : "defaults";
      health.setup.policies = Number(counts?.policies) ? "custom" : "defaults";
      if (deps.setupCheck) try {
        const events = (await deps.setupCheck()).checks.find((check) => check.id === "github_events");
        health.setup.appEventsVerified = events?.status === "pass" ? true : events?.status === "fail" ? false : null;
      } catch { /* An unavailable live check stays unknown. */ }
      if (deps.planeDirectory) try { health.setup.membersTotal = (await listMembers(deps.planeDirectory, slug)).length; } catch { /* Unknown is shown explicitly. */ }
    } catch { health.healthError = "Sync health details could not be loaded; try again"; }
    sendJson(res, 200, health);
  }, { tolerateDatabaseOutage: true });

  // ---- workspace: operations (§7.6) ----------------------------------------------------------------
  const operations = (): OperationsDeps => {
    if (!deps.operations) throw new HttpError(503, "Operations are not available in this deployment");
    return deps.operations;
  };

  /** An audit row recorded for this workspace, or 404. */
  async function loadAudit(slug: string, rawId: string | undefined): Promise<Row> {
    if (!rawId || !/^\d{1,15}$/.test(rawId)) throw new HttpError(404, "Audit entry not found");
    const { rows } = await db.query(`SELECT id, source, detail FROM audit_log WHERE id = $1 AND workspace_slug = $2`, [Number(rawId), slug]);
    if (!rows[0]) throw new HttpError(404, "Audit entry not found");
    return rows[0];
  }

  workspace("POST", "/dry-run", async ({ res, slug, body }) => {
    const input = parseDryRun(await body());
    let yaml = input.yaml;
    let mapping: { repo: string; project: string } | undefined;
    if (input.mappingId !== undefined) {
      const m = await loadMapping(slug, String(input.mappingId));
      mapping = { repo: m.gh_repo_full_name, project: m.plane_project_id };
    }
    if (yaml === undefined) {
      if (input.mappingId !== undefined) {
        const m = await loadMapping(slug, String(input.mappingId));
        const { rows } = await db.query(`SELECT yaml_source FROM rule_sets WHERE mapping_id = $1 ORDER BY version DESC LIMIT 1`, [m.id]);
        yaml = rows[0]?.yaml_source;
      }
      yaml ??= compileLifecycleRules(QLL_DEFAULTS);
    }
    let payload: unknown = input.payload;
    if (input.auditId !== undefined) {
      const row = await loadAudit(slug, String(input.auditId));
      const detail = typeof row.detail === "string" ? JSON.parse(row.detail) : row.detail;
      if (!detail || detail.payload === undefined) throw new ValidationError("that audit entry has no payload on file");
      payload = detail.payload;
      if (input.source === undefined && (row.source === "plane" || row.source === "github")) input.source = row.source;
    }
    try {
      sendJson(res, 200, previewRules(input, yaml, payload, mapping));
    } catch (e) {
      // parseRules failures and unresolved {{templates}} are the author's to fix, not server errors.
      throw new ValidationError(e instanceof Error ? e.message.slice(0, 500) : "Rules could not be evaluated");
    }
  });

  workspace("POST", "/audit/:id/replay", async ({ res, slug, params }) => {
    const ops = operations();
    const row = await loadAudit(slug, params.id);
    const out = await replayDelivery({ db, enqueue: ops.enqueue }, row.id);
    sendJson(res, 202, out);
  });

  workspace("POST", "/outbound-writes/:id/retry", async ({ res, slug, params }) => {
    const ops = operations();
    if (!ops.retryFailed) throw new HttpError(503, "Retrying failed writes is not available in this deployment");
    const id = params.id ?? "";
    if (!/^[A-Za-z0-9_.:@-]{1,200}$/.test(id)) throw new HttpError(404, "Outbound write not found");
    const out = await ops.retryFailed(id, slug); // scoped by workspace: a foreign or unknown row is not found
    // The outbox answers { ok: true, retried: boolean }: false means no such FAILED row in this workspace (unknown, foreign or
    // not failed), which is indistinguishable by design and answered 404, never revealing another workspace's rows.
    if ((out as { retried?: unknown } | null)?.retried === false) throw new HttpError(404, "No failed outbound write with that id in this workspace");
    sendJson(res, 202, { id, status: "retry_scheduled" });
  });

  workspace("POST", "/mappings/:id/backfill", async ({ req, res, slug, params, body: readBody }) => {
    const body = hasBody(req) ? await readBody() as { cursor?: BackfillCursor } | null : undefined;
    if (body !== undefined && (body === null || typeof body !== "object" || Array.isArray(body))) {
      throw new ValidationError("Backfill options must be an object");
    }
    if (body?.cursor !== undefined) {
      const cursor = body.cursor;
      if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)
        || ![cursor.pullRequestsPage, cursor.issuesPage].every((page) => page === null || (Number.isSafeInteger(page) && page >= 1))) {
        throw new ValidationError("Invalid backfill cursor");
      }
    }
    const ops = operations();
    const m = await loadMapping(slug, params.id);
    const [owner, repo] = String(m.gh_repo_full_name).split("/");
    if (!owner || !repo) throw new HttpError(422, "The mapping has no valid repository name");
    const ghRepoId = Number(m.gh_repo_id);
    // Audit S5: read GitHub only through this mapping's installation, and only while it is allow-listed for this
    // workspace. A disconnected, removed or reassigned installation must not keep serving a stale mapping.
    const installationId = m.installation_id == null ? null : Number(m.installation_id);
    if (installationId === null || !(await db.query(`SELECT 1 FROM workspace_installations WHERE installation_id = $1 AND workspace_slug = $2`,
      [installationId, slug])).rows.length) throw new HttpError(403, "This mapping's GitHub installation is not connected to this workspace");
    const github = await ops.githubFor({ ghRepoId, owner, repo, installationId });
    const result = await backfill({
      db, github,
      mapping: { id: Number(m.id), workspaceSlug: slug, planeProjectId: m.plane_project_id, ghRepoId, owner, repo },
      resolveIssue: (key) => ops.resolveIssue(slug, key),
      ...(body?.cursor !== undefined ? { cursor: body.cursor } : {}),
    });
    sendJson(res, 200, result);
  });

  // ---- instance (Plane instance-admin session) ----------------------------------------------------
  async function githubAppDto() {
    const r = (await db.query(`SELECT app_id, ghe_base_url FROM github_app_config WHERE id = 1`)).rows[0];
    const client = await readGithubAppClient(db);
    return { appId: r ? Number(r.app_id) : null, gheBaseUrl: r?.ghe_base_url ?? null, configured: Boolean(r),
      clientId: client?.clientId ?? deps.githubOAuthConfig?.GITHUB_CLIENT_ID ?? null,
      appSlug: client?.appSlug ?? deps.githubOAuthConfig?.GITHUB_APP_SLUG ?? null,
      clientSecretConfigured: client?.clientId ? Boolean(client.clientSecretCiphertext) : Boolean(deps.githubOAuthConfig?.GITHUB_CLIENT_SECRET),
      edition: client?.edition ?? deps.githubOAuthConfig?.GITHUB_EDITION ?? "github", gheSubdomain: client?.gheSubdomain ?? deps.githubOAuthConfig?.GITHUB_GHE_SUBDOMAIN ?? null };
  }
  instance("GET", "/github-app", async ({ res }) => sendJson(res, 200, await githubAppDto()));
  instance("PUT", "/github-app", async ({ res, body }) => {
    const raw = await body();
    const input = parseGithubApp(raw);
    const updateHost = Object.hasOwn(raw as object, "gheBaseUrl") || input.edition !== undefined;
    const save = async (conn: Db) => {
      await conn.exec("BEGIN");
      try {
        const existing = (await conn.query(`SELECT * FROM github_app_config WHERE id = 1 FOR UPDATE`)).rows[0];
        if (!existing && (input.privateKey === undefined || input.webhookSecret === undefined)) throw new ValidationError("privateKey and webhookSecret are required the first time");
        if (input.clientId && input.clientId !== existing?.client_id && input.clientSecret === undefined) {
          throw new ValidationError("clientSecret is required when setting or changing clientId");
        }
        // Audit S4: every credentialed request (App JWTs, the OAuth client secret, users' refresh tokens) goes to the
        // stored host at use time. Moving the host therefore re-enters the secrets that would follow it, and drops the
        // user tokens the old host issued, instead of handing them to a host chosen through the admin UI.
        const env = deps.githubOAuthConfig ?? {};
        const before = existing ? { edition: existing.edition ?? "github", base: existing.ghe_base_url ?? null, sub: existing.ghe_subdomain ?? null }
          : { edition: env.GITHUB_EDITION ?? "github", base: env.GITHUB_API_BASE_URL ?? null, sub: env.GITHUB_GHE_SUBDOMAIN ?? null };
        const after = { edition: input.edition ?? before.edition, base: updateHost ? input.gheBaseUrl ?? null : before.base,
          sub: input.edition !== undefined ? input.gheSubdomain ?? null : before.sub };
        const hostChanged = after.edition !== before.edition || after.base !== before.base || after.sub !== before.sub;
        if (hostChanged) {
          if (existing && input.privateKey === undefined) throw new ValidationError("privateKey is required when changing the GitHub host");
          const secretStored = existing?.client_secret_v1 ? true : !existing?.client_id && Boolean(env.GITHUB_CLIENT_SECRET);
          if (secretStored && input.clientSecret === undefined) throw new ValidationError("clientSecret is required when changing the GitHub host");
        }
        const key = input.privateKey === undefined ? null : encryptSecret(input.privateKey, deps.tokenKey);
        const hook = input.webhookSecret === undefined ? null : encryptSecret(input.webhookSecret, deps.tokenKey);
        await conn.query(`INSERT INTO github_app_config (id, app_id, private_key_v1, webhook_secret_v1, ghe_base_url) VALUES (1, $1, $2, $3, $4)
          ON CONFLICT (id) DO UPDATE SET app_id = EXCLUDED.app_id,
          ghe_base_url = CASE WHEN $7::boolean THEN EXCLUDED.ghe_base_url ELSE github_app_config.ghe_base_url END,
          private_key_v1 = COALESCE($5, github_app_config.private_key_v1), webhook_secret_v1 = COALESCE($6, github_app_config.webhook_secret_v1)`,
          [input.appId, key ?? "", hook ?? "", input.gheBaseUrl, key, hook, updateHost]);
        await saveGithubAppClient(conn, { ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
          ...(input.appSlug !== undefined ? { appSlug: input.appSlug } : {}),
          ...(input.clientSecret !== undefined ? { clientSecretCiphertext: encryptSecret(input.clientSecret, deps.tokenKey) } : {}),
          ...(input.edition !== undefined ? { edition: input.edition, gheSubdomain: input.gheSubdomain } : {}) });
        if (hostChanged) {
          const dropped = await conn.query(`DELETE FROM user_tokens WHERE kind = 'github_oauth' RETURNING plane_user_id`);
          await appendAudit(conn, { kind: "github_host_changed", source: "github", outcome: "applied",
            detail: { edition: after.edition, githubTokensDropped: dropped.rows.length } });
        }
        await conn.exec("COMMIT");
      } catch (err) { await conn.exec("ROLLBACK"); throw err; }
    };
    await (db.withConnection ? db.withConnection(save) : save(db));
    sendJson(res, 200, await githubAppDto());
  });

  async function magicWords(): Promise<Record<MagicTier, string[]>> {
    const { rows } = await db.query(`SELECT tier, words FROM magic_words`);
    const out = { closing: [...DEFAULT_MAGIC_WORDS.closing], non_closing: [...DEFAULT_MAGIC_WORDS.non_closing], relation: [...DEFAULT_MAGIC_WORDS.relation] };
    for (const r of rows) if ((MAGIC_TIERS as readonly string[]).includes(r.tier)) out[r.tier as MagicTier] = r.words;
    return out;
  }

  instance("GET", "/magic-words", async ({ res }) => sendJson(res, 200, await magicWords()));

  instance("PUT", "/magic-words", async ({ res, body }) => {
    const words = parseMagicWords(await body());
    const values: unknown[] = [];
    const tuples = MAGIC_TIERS.map((tier) => {
      values.push(tier, words[tier]);
      return `($${values.length - 1}, $${values.length}::text[])`;
    });
    await db.query(
      `INSERT INTO magic_words (tier, words) VALUES ${tuples.join(", ")} ON CONFLICT (tier) DO UPDATE SET words = EXCLUDED.words`, values);
    sendJson(res, 200, await magicWords());
  });

  instance("GET", "/settings", async ({ res }) => sendJson(res, 200, await readInstanceSettings()));

  instance("PUT", "/settings", async ({ res, body }) => {
    const patch = parseInstanceSettings(await body());
    const next = { ...(await readInstanceSettings()), ...patch };
    await db.query(
      `INSERT INTO instance_settings (id, smart_commits_default, reconciliation_interval_minutes, op_ttl_minutes) VALUES (1, $1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET smart_commits_default = EXCLUDED.smart_commits_default,
         reconciliation_interval_minutes = EXCLUDED.reconciliation_interval_minutes, op_ttl_minutes = EXCLUDED.op_ttl_minutes`,
      [next.smartCommitsDefault, next.reconciliationIntervalMinutes, next.opTtlMinutes]);
    if (patch.requireVerifiedCommits !== undefined) await writeRequireVerifiedCommits(db, patch.requireVerifiedCommits);
    sendJson(res, 200, next);
  });

  // ---- instance: which GitHub App installations each workspace may map repositories from (F4) -----------
  const installationId = (raw: string | undefined): number => {
    if (!raw || !/^\d{1,15}$/.test(raw) || Number(raw) < 1) throw new HttpError(404, "Installation not found");
    return Number(raw);
  };
  const installationJson = (r: Row) => ({ installationId: Number(r.installation_id), workspaceSlug: r.workspace_slug as string, accountLogin: (r.account_login ?? null) as string | null, createdAt: r.created_at });

  instance("GET", "/installations", async ({ res }) => {
    const { rows } = await db.query(`SELECT installation_id, workspace_slug, account_login, created_at FROM workspace_installations ORDER BY workspace_slug, installation_id`);
    sendJson(res, 200, rows.map(installationJson));
  });

  instance("PUT", "/installations/:installationId", async ({ res, params, body }) => {
    const id = installationId(params.installationId);
    const input = parseInstallationEntry(await body());
    const existing = (await db.query(`SELECT workspace_slug FROM workspace_installations WHERE installation_id = $1`, [id])).rows[0];
    if (existing && existing.workspace_slug !== input.workspaceSlug) throw new HttpError(409, "That installation is already allowed for another workspace; remove it there first");
    try {
      const { rows } = await db.query(
        `INSERT INTO workspace_installations (installation_id, workspace_slug, account_login) VALUES ($1, $2, $3)
         ON CONFLICT (installation_id) DO UPDATE SET account_login = EXCLUDED.account_login
           WHERE workspace_installations.workspace_slug = EXCLUDED.workspace_slug
         RETURNING installation_id, workspace_slug, account_login, created_at`,
        [id, input.workspaceSlug, input.accountLogin]);
      if (!rows[0]) throw new HttpError(409, "That installation is already allowed for another workspace; remove it there first"); // lost a race
      if (deps.refreshInstallation) await deps.refreshInstallation(id);
      sendJson(res, 200, installationJson(rows[0]));
    } catch (e) {
      if (errorCode(e) === "23505") throw new HttpError(409, "That installation is already allowed for another workspace; remove it there first");
      throw e;
    }
  });

  instance("DELETE", "/installations/:installationId", async ({ res, params }) => {
    const del = await db.query(`DELETE FROM workspace_installations WHERE installation_id = $1 RETURNING installation_id`, [installationId(params.installationId)]);
    if (!del.rows.length) throw new HttpError(404, "Installation not found");
    sendJson(res, 204);
  });

  async function credentialStatus(rowExists: boolean, rowDecrypts: boolean): Promise<{ source: "database" | "environment"; decryptOk: boolean }> {
    if (deps.credentialStatus) {
      try { return await deps.credentialStatus(); } catch (e) { console.error("credential status failed:", e instanceof Error ? e.message : "unknown"); return { source: rowExists ? "database" : "environment", decryptOk: false }; }
    }
    return { source: rowExists ? "database" : "environment", decryptOk: rowDecrypts };
  }

  // Connection health from our own database: is the App configured, what is mapped, is sync failing.
  instance("GET", "/health", async ({ res }) => {
    const database = await databaseReachable();
    if (!database) {
      sendJson(res, 200, { database, githubAppConfigured: false, githubAppCredentials: { source: "unavailable", decryptOk: false },
        mappings: null, lastActivityAt: null, failuresLast24h: null, healthError: "Database is unreachable" });
      return;
    }
    try {
    const app = await db.query(`SELECT private_key_v1, webhook_secret_v1 FROM github_app_config WHERE id = 1`);
    // Which credentials the service verifies with: the stored row when there is one (authoritative), else the
    // environment bootstrap. A stored row that no longer decrypts makes every GitHub webhook fail, so say so.
    let decryptOk = true;
    if (app.rows[0]) {
      try {
        decryptSecret(String(app.rows[0].private_key_v1), deps.tokenKey);
        decryptSecret(String(app.rows[0].webhook_secret_v1), deps.tokenKey);
      } catch { decryptOk = false; }
    }
    const maps = await db.query(`SELECT count(*)::int AS n FROM repo_mappings`);
    const audit = await db.query(
      `SELECT max(created_at) AS last_at,
              count(*) FILTER (WHERE (error IS NOT NULL OR outcome IN ('failed', 'error')) AND created_at > now() - interval '24 hours')::int AS failures
         FROM audit_log`);
    sendJson(res, 200, {
      database,
      githubAppConfigured: app.rows.length > 0,
      githubAppCredentials: await credentialStatus(app.rows.length > 0, decryptOk),
      mappings: Number(maps.rows[0].n),
      lastActivityAt: audit.rows[0].last_at ?? null,
      failuresLast24h: Number(audit.rows[0].failures),
    });
    } catch { sendJson(res, 200, { database, githubAppConfigured: false, mappings: null, lastActivityAt: null, failuresLast24h: null, healthError: "Sync health details could not be loaded; try again" }); }
  });

  return routes;
}
