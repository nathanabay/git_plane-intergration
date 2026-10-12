// Config API (spec §8) under /git-sync/api/. Authenticated per request against Plane's own
// session; configuration lives only in the gitsync database (no Plane writes, ever).
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Route } from "../index.ts";
import type { Db } from "../db/migrate.ts";
import { PgTokenStore } from "../db/token-store.ts";
import { addUserLinkTombstone, clearUserLinkTombstone, withUserLinkTransaction } from "../db/ledgers.ts";
import { TokenVault, decryptSecret, encryptSecret } from "../auth/identity.ts";
import { parseRules } from "../rules/engine.ts";
import { QLL_DEFAULTS, compileLifecycleRules } from "../github/pr-automation.ts";
import { OperationError, backfill, dryRun, replayDelivery } from "../operations/tooling.ts";
import type { GithubRequester, ReplayJob } from "../operations/tooling.ts";
import { HttpError, hasBody, isJsonContentType, readJsonBody, sendJson } from "./http.ts";
import type { GithubUserLookup, MappingVerifier, WorkspaceMemberCheck } from "./mapping-check.ts";
import { authenticateInstanceAdmin, authenticateWorkspaceAdmin } from "./plane-auth.ts";
import type { Viewer } from "./plane-auth.ts";
import {
  CONFLICT_FIELDS, DEFAULT_CONFLICT_POLICIES, DEFAULT_INSTANCE_SETTINGS, DEFAULT_MAGIC_WORDS, MAGIC_TIERS, SLUG_PATTERN,
  ValidationError, isValidPlaneId, parseConflictPolicies, parseGithubApp, parseInstanceSettings, parseMagicWords,
  parseDryRun, parseInstallationEntry, parseMappingInput, parseRulesBody, parseUserLink,
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
  githubFor(repo: { ghRepoId: number; owner: string; repo: string }): Promise<GithubRequester>;
  resolveIssue(slug: string, key: string): Promise<{ projectId: string; issueId: string } | null | undefined>;
}

export interface ConfigApiDeps {
  db: Db;
  planeInternalUrl: string;
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
   * Resolves a GitHub login to its canonical login and numeric id through the App (see `createGithubUserLookup`);
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
  const authDeps = { planeInternalUrl: deps.planeInternalUrl, fetch: deps.fetch };
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
          if (e instanceof HttpError) {
            sendJson(res, e.status, { error: e.message }, e.status === 413 ? { connection: "close" } : {});
          } else if (e instanceof OperationError) {
            sendJson(res, e.status, { error: e.message });
          } else if (e instanceof ValidationError) {
            sendJson(res, 422, { error: e.message });
          } else {
            console.error("config api error:", e instanceof Error ? e.message : "unknown");
            sendJson(res, 500, { error: "Internal error" });
          }
        }
      },
    });
  }

  const workspace = (method: string, path: string, handler: (ctx: Ctx<Viewer> & { slug: string }) => Promise<void>) =>
    add<Viewer>(method, "/workspaces/:slug" + path, async (req, params) => {
      const slug = params.slug ?? "";
      if (!SLUG_PATTERN.test(slug)) throw new HttpError(404, "Not found");
      return authenticateWorkspaceAdmin(authDeps, req, slug);
    }, (ctx) => handler({ ...ctx, slug: ctx.params.slug! }));

  const instance = (method: string, path: string, handler: (ctx: Ctx<Viewer>) => Promise<void>) =>
    add<Viewer>(method, "/instance" + path, (req) => authenticateInstanceAdmin(authDeps, req), handler);

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
  });

  /** Refuses (422) a project outside the workspace or a repository the App cannot reach; Plane/GitHub outages are 502. */
  async function authoriseMapping(slug: string, check: { planeProjectId: string; repo: { id: number; fullName: string } }): Promise<number> {
    if (!deps.verifyMapping) throw new HttpError(503, "Mapping verification is not configured, so mappings cannot be changed");
    let reason: string | null;
    let installationId: number | undefined;
    try {
      reason = await deps.verifyMapping({ slug, ...check, onInstallationVerified: (id) => { installationId = id; } });
    } catch (e) {
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
    if (!r) return { ...DEFAULT_INSTANCE_SETTINGS };
    return {
      smartCommitsDefault: r.smart_commits_default,
      reconciliationIntervalMinutes: Number(r.reconciliation_interval_minutes),
      opTtlMinutes: Number(r.op_ttl_minutes),
    };
  }

  // ---- workspace: mappings -----------------------------------------------------------------------
  workspace("GET", "/mappings", async ({ res, slug }) => {
    const { rows } = await db.query(`SELECT * FROM repo_mappings WHERE workspace_slug = $1 ORDER BY id`, [slug]);
    sendJson(res, 200, rows.map(mappingDto));
  });

  workspace("POST", "/mappings", async ({ res, slug, body }) => {
    const input = parseMappingInput(await body(), false);
    const installationId = await authoriseMapping(slug, { planeProjectId: input.planeProjectId!, repo: { id: input.ghRepoId!, fullName: input.ghRepoFullName! } });
    const dup = await db.query(
      `SELECT 1 FROM repo_mappings WHERE workspace_slug = $1 AND gh_repo_id = $2 AND plane_project_id = $3`,
      [slug, input.ghRepoId, input.planeProjectId]);
    if (dup.rows.length) throw new HttpError(409, "That repository is already mapped to that project");
    const smartDefault = (await readInstanceSettings()).smartCommitsDefault;
    const { rows } = await db.query(
      `INSERT INTO repo_mappings (workspace_slug, gh_repo_id, gh_repo_full_name, plane_project_id, sync_direction,
         smart_commits_enabled, linkback_enabled, autolinks_enabled, installation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [slug, input.ghRepoId, input.ghRepoFullName, input.planeProjectId, input.syncDirection ?? "bidirectional",
        input.smartCommitsEnabled ?? smartDefault, input.linkbackComments ?? true, input.autolinks ?? false, installationId]);
    sendJson(res, 201, { id: Number(rows[0].id) });
  });

  workspace("PATCH", "/mappings/:id", async ({ res, slug, params, body }) => {
    const current = await loadMapping(slug, params.id);
    const input = parseMappingInput(await body(), true);
    const installationId = await authoriseMapping(slug, {
      planeProjectId: input.planeProjectId ?? current.plane_project_id,
      repo: { id: input.ghRepoId ?? Number(current.gh_repo_id), fullName: input.ghRepoFullName ?? current.gh_repo_full_name },
    });
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
    const { rows } = await db.query(
      `UPDATE repo_mappings SET ${sets.join(", ")} WHERE id = $${values.length - 1} AND workspace_slug = $${values.length} RETURNING *`, values);
    if (!rows[0]) throw new HttpError(404, "Mapping not found");
    sendJson(res, 200, mappingDto(rows[0]));
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

  workspace("PUT", "/mappings/:id/rules", async ({ res, slug, params, body, viewer }) => {
    const m = await loadMapping(slug, params.id);
    const source = parseRulesBody(await body());
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
           RETURNING version`, [m.id, source, viewer.id]);
        sendJson(res, 200, { version: Number(rows[0].version) });
        return;
      } catch (e) {
        if (errorCode(e) !== "23505" || attempt >= 4) throw e;
      }
    }
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
      `SELECT plane_user_id, gh_login, gh_id FROM user_map WHERE workspace_slug = $1 ORDER BY gh_login`, [slug]);
    sendJson(res, 200, rows.map((r) => ({ planeUserId: r.plane_user_id, githubLogin: r.gh_login, githubId: Number(r.gh_id) })));
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

  workspace("DELETE", "/user-links/:planeUserId", async ({ res, slug, params }) => {
    const userId = planeUserId(params.planeUserId);
    await withUserLinkTransaction(db, slug, async (conn) => {
      const del = await conn.query(`DELETE FROM user_map WHERE workspace_slug = $1 AND plane_user_id = $2 RETURNING id, gh_id`, [slug, userId]);
      if (!del.rows.length) throw new HttpError(404, "No link for that user");
      await addUserLinkTombstone(conn, slug, Number(del.rows[0].gh_id));
      // Tokens are per Plane user, so revocation also covers their links in other workspaces.
      await new PgTokenStore(conn).delete(userId);
    });
    sendJson(res, 204);
  });

  // ---- workspace: audit log (read only) -----------------------------------------------------------
  // audit_log has no workspace column, so a row is shown only when its detail names this workspace
  // or one of its mappings; unattributed rows stay instance-private.
  workspace("GET", "/audit", async ({ res, req, slug }) => {
    const q = new URL(req.url ?? "/", "http://localhost").searchParams;
    const limitRaw = q.get("limit");
    const beforeRaw = q.get("before");
    const limit = limitRaw === null || limitRaw === "" ? 50 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ValidationError("limit must be between 1 and 200");
    if (beforeRaw !== null && beforeRaw !== "" && !/^\d{1,15}$/.test(beforeRaw)) throw new ValidationError("before must be an audit entry id");
    const before = beforeRaw ? Number(beforeRaw) : null;
    const { rows } = await db.query(
      `SELECT id, kind, source, delivery_id, detail, outcome, error, replay_of, created_at FROM audit_log
        WHERE ($2::bigint IS NULL OR id < $2::bigint)
          AND (detail->>'workspaceSlug' = $1
               OR detail->>'workspace' = $1
               OR detail->>'workspace_slug' = $1
               OR workspace_slug = $1
               OR detail->>'mappingId' IN (SELECT id::text FROM repo_mappings WHERE workspace_slug = $1))
        ORDER BY id DESC LIMIT $3`, [slug, before, limit + 1]);
    const page = rows.slice(0, limit).map((r) => ({
      id: Number(r.id), kind: r.kind, source: r.source, deliveryId: r.delivery_id, detail: r.detail,
      outcome: r.outcome, error: r.error, replayOf: r.replay_of === null ? null : Number(r.replay_of), createdAt: r.created_at,
    }));
    sendJson(res, 200, { entries: page, nextBefore: rows.length > limit ? page[page.length - 1]!.id : null });
  });

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
    }
    try {
      sendJson(res, 200, await dryRun({ rulesYaml: yaml, event: input.event, payload }));
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

  workspace("POST", "/mappings/:id/backfill", async ({ res, slug, params }) => {
    const ops = operations();
    const m = await loadMapping(slug, params.id);
    const [owner, repo] = String(m.gh_repo_full_name).split("/");
    if (!owner || !repo) throw new HttpError(422, "The mapping has no valid repository name");
    const ghRepoId = Number(m.gh_repo_id);
    const github = await ops.githubFor({ ghRepoId, owner, repo });
    const result = await backfill({
      db, github,
      mapping: { id: Number(m.id), workspaceSlug: slug, planeProjectId: m.plane_project_id, ghRepoId, owner, repo },
      resolveIssue: (key) => ops.resolveIssue(slug, key),
    });
    sendJson(res, 200, result);
  });

  // ---- instance (Plane instance-admin session) ----------------------------------------------------
  instance("GET", "/github-app", async ({ res }) => {
    const { rows } = await db.query(`SELECT app_id, ghe_base_url FROM github_app_config WHERE id = 1`);
    const r = rows[0];
    sendJson(res, 200, r
      ? { appId: Number(r.app_id), gheBaseUrl: r.ghe_base_url, configured: true }
      : { appId: null, gheBaseUrl: null, configured: false });
  });

  instance("PUT", "/github-app", async ({ res, body }) => {
    const input = parseGithubApp(await body());
    const existing = (await db.query(`SELECT 1 FROM github_app_config WHERE id = 1`)).rows.length > 0;
    if (!existing && (input.privateKey === undefined || input.webhookSecret === undefined)) {
      throw new ValidationError("privateKey and webhookSecret are required the first time");
    }
    const key = input.privateKey === undefined ? null : encryptSecret(input.privateKey, deps.tokenKey);
    const hook = input.webhookSecret === undefined ? null : encryptSecret(input.webhookSecret, deps.tokenKey);
    await db.query(
      `INSERT INTO github_app_config (id, app_id, private_key_v1, webhook_secret_v1, ghe_base_url) VALUES (1, $1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET app_id = EXCLUDED.app_id, ghe_base_url = EXCLUDED.ghe_base_url,
         private_key_v1 = COALESCE($5, github_app_config.private_key_v1),
         webhook_secret_v1 = COALESCE($6, github_app_config.webhook_secret_v1)`,
      [input.appId, key ?? "", hook ?? "", input.gheBaseUrl, key, hook]);
    // Migration 008 retires bootstrap credentials in the same transaction as the row save.
    sendJson(res, 200, { appId: input.appId, gheBaseUrl: input.gheBaseUrl, configured: true });
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
    const next = { ...(await readInstanceSettings()), ...parseInstanceSettings(await body()) };
    await db.query(
      `INSERT INTO instance_settings (id, smart_commits_default, reconciliation_interval_minutes, op_ttl_minutes) VALUES (1, $1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET smart_commits_default = EXCLUDED.smart_commits_default,
         reconciliation_interval_minutes = EXCLUDED.reconciliation_interval_minutes, op_ttl_minutes = EXCLUDED.op_ttl_minutes`,
      [next.smartCommitsDefault, next.reconciliationIntervalMinutes, next.opTtlMinutes]);
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
      try { return await deps.credentialStatus(); } catch (e) { console.error("credential status failed:", e instanceof Error ? e.message : "unknown"); }
    }
    return { source: rowExists ? "database" : "environment", decryptOk: rowDecrypts };
  }

  // Connection health from our own database: is the App configured, what is mapped, is sync failing.
  instance("GET", "/health", async ({ res }) => {
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
              count(*) FILTER (WHERE error IS NOT NULL AND created_at > now() - interval '24 hours')::int AS failures
         FROM audit_log`);
    sendJson(res, 200, {
      database: true,
      githubAppConfigured: app.rows.length > 0,
      githubAppCredentials: await credentialStatus(app.rows.length > 0, decryptOk),
      mappings: Number(maps.rows[0].n),
      lastActivityAt: audit.rows[0].last_at ?? null,
      failuresLast24h: Number(audit.rows[0].failures),
    });
  });

  return routes;
}
