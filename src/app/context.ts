import { classifyGithubError } from "../github/errors.ts";
import { PgTokenStore } from "../db/token-store.ts";
import { TokenVault, resolveActor } from "../auth/identity.ts";
import type { GithubSender, SecretString, UserMapLookup } from "../auth/identity.ts";
import type { Config } from "../config/env.ts";
import { appendAudit } from "../db/ledgers.ts";
import type { Db } from "../db/migrate.ts";
import { DEFAULT_MAGIC_WORDS } from "../parse/magicWords.ts";
import type { MagicWords } from "../parse/magicWords.ts";
import type { GithubWrite } from "../sync/github.ts";
import { PlaneApiError, planeWorkspacePath } from "../sync/plane.ts";
import type { PlaneClient, PlaneWrite, PlaneWriteResult } from "../sync/plane.ts";
import type { GithubClient } from "./github.ts";
import type { IssueMutation, PlanWriter } from "./writers.ts";
import { ensureLinkedByEmail } from "./identity.ts";
import { assertInstallationAllowed, rememberInstallation } from "./mappings.ts";
import type { Mapping } from "./mappings.ts";
import { readGithubAppClient } from "../db/parity.ts";
import { hostsFromAppConfig, hostsFromBootstrap } from "./credentials.ts";
import type { GithubHosts } from "../github/hosts.ts";

/** What reducers write through. In the running service these are the ordered outbox (src/app/writers.ts). */
export interface PlaneWriter {
  apply(write: PlaneWrite, opts?: { actorToken?: SecretString }): Promise<PlaneWriteResult>;
  /** Read-modify-write of one label/assignee under the worker's target lock; absent on raw test writers. */
  /** Registers a serializable plan whose later steps use earlier results by reference (ids are never read synchronously). */
  plan?: PlanWriter;
  /** Create-or-update one dev-info rollup link; the outbox resolves the Plane link id at execution, so a queued create's id is never read here. */
  upsertRollup?(target: { slug: string; projectId: string; issueId: string }, key: string, link: { title: string; url: string }): Promise<PlaneWriteResult>;
  mutateIssue?(target: { slug: string; projectId: string; issueId: string }, mutation: IssueMutation, opts?: { actorToken?: SecretString }): Promise<PlaneWriteResult>;
}
export interface GithubWriter {
  apply(write: GithubWrite): Promise<{ ok: true; id?: number; number?: number }>;
  /** Declares the desired mapped assignee set (including empty), ordered with earlier intents; absent on raw test writers. */
  plan?: PlanWriter;
  setAssignees?(write: Extract<GithubWrite, { kind: "add_assignees" }>, workspaceSlug: string): Promise<{ ok: true }>;
}

export interface AppContext {
  config: Config;
  db: Db;
  planeClient: PlaneClient;
  plane: PlaneWriter;
  github: GithubWriter;
  ghClient: GithubClient;
  vault: TokenVault;
}

/** Production clients resolve current credentials; lightweight reducer clients use the same DB reader. */
export async function githubHostsFor(ctx: Pick<AppContext, "ghClient" | "db" | "config">): Promise<GithubHosts> {
  if (ctx.ghClient.hosts) return ctx.ghClient.hosts();
  const stored = await readGithubAppClient(ctx.db);
  return stored ? hostsFromAppConfig(stored) : hostsFromBootstrap(ctx.config);
}

export function createVault(db: Db, key: Buffer): TokenVault {
  return new TokenVault(new PgTokenStore(db), key);
}

export interface WorkspaceUsers extends UserMapLookup {
  githubLoginForPlaneUserId(planeUserId: string): Promise<string | null>;
}

/** The identity map is per workspace (§9); a login in one workspace says nothing about another. */
export function usersFor(db: Db, workspaceSlug: string): WorkspaceUsers {
  return {
    async planeUserIdForGithubLogin(login) {
      const r = await db.query<{ plane_user_id: string }>("SELECT plane_user_id FROM user_map WHERE workspace_slug = $1 AND lower(gh_login) = lower($2)", [workspaceSlug, login]);
      return r.rows[0]?.plane_user_id ?? null;
    },
    async githubLoginForPlaneUserId(planeUserId) {
      const r = await db.query<{ gh_login: string }>("SELECT gh_login FROM user_map WHERE workspace_slug = $1 AND plane_user_id = $2", [workspaceSlug, planeUserId]);
      return r.rows[0]?.gh_login ?? null;
    },
  };
}

/**
 * F12: the sender is resolved by its stable GitHub id (every event carries `sender.id`), not by the login, which
 * can be renamed and later re-registered by someone else. A match refreshes the stored login. A sender without a
 * usable id falls back to the login lookup.
 */
export function usersByGithubId(db: Db, workspaceSlug: string, sender: GithubSender | null | undefined): UserMapLookup {
  const byLogin = usersFor(db, workspaceSlug);
  return {
    async planeUserIdForGithubLogin(login) {
      if (!Number.isSafeInteger(sender?.id)) return byLogin.planeUserIdForGithubLogin(login);
      const r = await db.query<{ plane_user_id: string; gh_login: string }>("SELECT plane_user_id, gh_login FROM user_map WHERE workspace_slug = $1 AND gh_id = $2", [workspaceSlug, sender!.id]);
      const row = r.rows[0];
      if (!row) return null;
      if (row.gh_login !== login) await db.query("UPDATE user_map SET gh_login = $3 WHERE workspace_slug = $1 AND gh_id = $2", [workspaceSlug, sender!.id, login]);
      return row.plane_user_id;
    },
  };
}

/** Instance-scope word lists (§8); a tier with no row keeps the §6 default. */
export async function loadMagicWords(db: Db): Promise<MagicWords> {
  const words: MagicWords = { closing: [...DEFAULT_MAGIC_WORDS.closing], non_closing: [...DEFAULT_MAGIC_WORDS.non_closing], relation: [...DEFAULT_MAGIC_WORDS.relation] };
  const { rows } = await db.query<{ tier: keyof MagicWords; words: string[] }>("SELECT tier, words FROM magic_words");
  for (const r of rows) if (r.tier in words && Array.isArray(r.words)) words[r.tier] = r.words;
  return words;
}

/**
 * Who a write on behalf of a GitHub sender is made as (§9): the mapped user's stored PAT when there is one,
 * otherwise the service identity, and the fallback is audited. The sender is the only trusted input.
 */
export async function actorTokenFor(ctx: AppContext, mapping: Mapping, sender: GithubSender | null | undefined, why: string, payload?: unknown): Promise<SecretString | undefined> {
  await ensureLinkedByEmail(ctx, mapping, sender, payload);
  const actor = await resolveActor(sender, usersByGithubId(ctx.db, mapping.workspaceSlug, sender));
  let reason: string;
  if (actor.kind === "user") {
    const token = await ctx.vault.load(actor.planeUserId, "plane_pat");
    if (token) return token;
    reason = "no_stored_token";
  } else {
    reason = actor.reason;
  }
  await appendAudit(ctx.db, { kind: "identity_fallback", source: "github", workspaceSlug: mapping.workspaceSlug, outcome: "service_identity", detail: { reason, githubLogin: actor.githubLogin, for: why } });
  return undefined;
}

/** Reconcile repository installation authority before admitting writes, including Plane-only work. */
export async function installationFor(ctx: AppContext, mapping: Mapping, _payload?: any): Promise<number> {
  let id: number;
  try {
    // A remembered ID or delayed webhook cannot establish current installation access.
    id = await ctx.ghClient.installationIdFor(mapping.owner, mapping.repo);
  } catch (err) {
    const kind = classifyGithubError(err).kind;
    if ((kind === "not_found" || kind === "permission") && mapping.installationId !== null) {
      await invalidateInstallationMappings(ctx, mapping.installationId, [mapping.ghRepoId]);
      mapping.installationId = null;
    }
    throw err;
  }
  await assertInstallationAllowed(ctx.db, id, mapping.workspaceSlug);
  if (id !== mapping.installationId) {
    if (mapping.installationId !== null) ctx.ghClient.invalidateInstallation?.(mapping.installationId);
    await rememberInstallation(ctx.db, mapping.id, id);
    mapping.installationId = id;
  }
  return id;
}

/** Invalidate only mappings still attached to this installation, never a later replacement. */
export async function invalidateInstallationMappings(ctx: AppContext, installationId: number, repoIds?: number[]): Promise<void> {
  ctx.ghClient.invalidateInstallation?.(installationId);
  const result = await ctx.db.query<{ id: number; workspace_slug: string }>(
    `UPDATE repo_mappings SET installation_id = NULL WHERE installation_id = $1
      ${repoIds ? "AND gh_repo_id = ANY($2::bigint[])" : ""} RETURNING id, workspace_slug`,
    repoIds ? [installationId, repoIds] : [installationId]);
  for (const row of result.rows) await appendAudit(ctx.db, {
    kind: "installation_invalidated", source: "github", workspaceSlug: row.workspace_slug,
    detail: { mappingId: Number(row.id), installationId }, outcome: "disabled",
  });
}

/** Refresh existing mappings after creation/addition/permission acceptance or explicit approval. */
export async function refreshInstallationMappings(ctx: AppContext, installationId: number, repoIds?: number[]): Promise<void> {
  ctx.ghClient.invalidateInstallation?.(installationId);
  const allowed = (await ctx.db.query<{ workspace_slug: string }>(
    "SELECT workspace_slug FROM workspace_installations WHERE installation_id = $1", [installationId])).rows[0];
  if (!allowed) return; // lifecycle delivery never creates workspace approval
  const candidates = (await ctx.db.query<{ id: number; gh_repo_id: number | string; gh_repo_full_name: string; installation_id: number | string | null }>(
    `SELECT id, gh_repo_id, gh_repo_full_name, installation_id FROM repo_mappings WHERE workspace_slug = $1
      ${repoIds ? "AND gh_repo_id = ANY($2::bigint[])" : ""} ORDER BY id`,
    repoIds ? [allowed.workspace_slug, repoIds] : [allowed.workspace_slug])).rows;
  for (const row of candidates) {
    const [owner, repo] = row.gh_repo_full_name.split("/");
    if (!owner || !repo) continue;
    try {
      const currentId = await ctx.ghClient.installationIdFor(owner, repo);
      if (currentId !== installationId) {
        if (Number(row.installation_id) === installationId) await invalidateInstallationMappings(ctx, installationId, [Number(row.gh_repo_id)]);
        continue;
      }
      await assertInstallationAllowed(ctx.db, installationId, allowed.workspace_slug);
      const octokit = await ctx.ghClient.installationOctokit(installationId);
      const { data } = await octokit.request("GET /repos/{owner}/{repo}", { owner, repo });
      if (Number(data?.id) !== Number(row.gh_repo_id) || String(data?.full_name ?? "").toLowerCase() !== row.gh_repo_full_name.toLowerCase()) {
        if (Number(row.installation_id) === installationId) await invalidateInstallationMappings(ctx, installationId, [Number(row.gh_repo_id)]);
        continue;
      }
      // Compare identity again in the update: a concurrent mapping edit or allow-list revocation wins.
      await ctx.db.query(`UPDATE repo_mappings rm SET installation_id = $1 WHERE rm.id = $2
        AND rm.gh_repo_id = $3 AND rm.gh_repo_full_name = $4 AND rm.workspace_slug = $5
        AND EXISTS (SELECT 1 FROM workspace_installations wi WHERE wi.installation_id = $1 AND wi.workspace_slug = rm.workspace_slug)`,
      [installationId, Number(row.id), Number(row.gh_repo_id), row.gh_repo_full_name, allowed.workspace_slug]);
    } catch (err) {
      const kind = classifyGithubError(err).kind;
      if (kind !== "not_found" && kind !== "permission") throw err;
      if (Number(row.installation_id) === installationId) await invalidateInstallationMappings(ctx, installationId, [Number(row.gh_repo_id)]);
    }
  }
}

export function planeIssueUrl(origin: string): (slug: string, projectId: string, issueId: string) => string {
  return (slug, projectId, issueId) => `${origin.replace(/\/+$/, "")}/${slug}/projects/${projectId}/issues/${issueId}`;
}

/** `{projectId, issueId}` for a `KEY-n` identifier, or null when Plane does not know it. */
export function issueResolver(ctx: AppContext, slug: string): (key: string) => Promise<{ projectId: string; issueId: string } | null> {
  return async (key) => {
    try {
      const issue: any = await ctx.planeClient.getIssueByIdentifier(slug, key);
      const projectId = projectOf(issue);
      return issue?.id && projectId ? { projectId, issueId: String(issue.id) } : null;
    } catch (err) {
      // 403 is what Plane answers for a project that does not exist or one we are not a member of (F1).
      if (err instanceof PlaneApiError && (err.status === 404 || err.status === 403)) return null;
      throw err;
    }
  };
}

export function projectOf(issue: any): string | null {
  const p = issue?.project_id ?? issue?.project;
  return typeof p === "string" ? p : typeof p?.id === "string" ? p.id : null;
}

/**
 * Serialises work on one GitHub object across replicas with a session advisory lock on a dedicated
 * connection. Without it two simultaneous deliveries both see "no link yet" and both create an item.
 */
export async function withObjectLock<T>(db: Db, key: string, fn: () => Promise<T>): Promise<T> {
  if (!db.withConnection) return fn(); // single-connection engines serialise on their own
  return db.withConnection(async (conn) => {
    await conn.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [key]);
    try {
      return await fn();
    } finally {
      await conn.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
    }
  });
}

/** GitHub logins that have a row in the workspace's user map — the only GitHub assignees Plane can represent (F5). */
export async function mappedLogins(db: Db, workspaceSlug: string): Promise<Set<string>> {
  const { rows } = await db.query<{ gh_login: string }>("SELECT gh_login FROM user_map WHERE workspace_slug = $1", [workspaceSlug]);
  return new Set(rows.map((r) => r.gh_login.toLowerCase()));
}

// ---- workspace authority for Plane payloads (F2) -----------------------------------------------------
const workspaceIds = new Map<string, string | null>();

/** The workspace UUID that owns the mapping's project, asked of Plane once and remembered. */
async function mappingWorkspaceId(ctx: AppContext, mapping: Mapping): Promise<string | null> {
  const key = `${mapping.workspaceSlug}/${mapping.planeProjectId}`;
  if (workspaceIds.has(key)) return workspaceIds.get(key) ?? null;
  try {
    const project: any = await ctx.planeClient.request("GET", planeWorkspacePath(mapping.workspaceSlug, "projects", mapping.planeProjectId));
    const id = typeof project?.workspace === "string" ? project.workspace : typeof project?.workspace_id === "string" ? project.workspace_id : null;
    workspaceIds.set(key, id);
    return id;
  } catch (err) {
    if (err instanceof PlaneApiError && (err.status === 403 || err.status === 404)) { workspaceIds.set(key, null); return null; }
    throw err;
  }
}

/**
 * A Plane delivery may only drive a mapping of the workspace it came from. Plane's payload carries the
 * workspace UUID (`workspace_id`); a slug, when present, is compared directly. A payload that names neither
 * is refused: a project id alone proves nothing about whose project it is.
 */
export async function payloadBelongsToMapping(ctx: AppContext, mapping: Mapping, payload: any): Promise<boolean> {
  if (typeof payload?.workspace_slug === "string") return payload.workspace_slug === mapping.workspaceSlug;
  const claimed = typeof payload?.workspace_id === "string" ? payload.workspace_id : typeof payload?.data?.workspace === "string" ? payload.data.workspace : null;
  if (!claimed) return false;
  return (await mappingWorkspaceId(ctx, mapping)) === claimed;
}

/** For tests: forget remembered workspace ids. */
export function resetWorkspaceIdCache(): void { workspaceIds.clear(); }
