import type { Db } from "../db/migrate.ts";
import { appendAudit } from "../db/ledgers.ts";
import { PlaneApiError } from "../sync/plane.ts";
import type { SyncLinkRow } from "../db/schema.ts";
import { resolvePlanValue } from "../operations/plans.ts";

export interface Mapping {
  id: number;
  workspaceSlug: string;
  ghRepoId: number;
  ghRepoFullName: string;
  owner: string;
  repo: string;
  planeProjectId: string;
  syncDirection: "bidirectional" | "github_to_plane";
  smartCommitsEnabled: boolean;
  linkbackEnabled: boolean;
  autolinksEnabled: boolean;
  installationId: number | null;
}

export interface FrozenWriteAuthority {
  workspaceSlug: string;
  mappingId: string;
  repoId: number;
  installationId: number;
}

/** Snapshot the verified mapping before registering any intent; queued ownership never follows later edits. */
export function freezeMappingAuthority(mapping: Pick<Mapping, "id" | "workspaceSlug" | "ghRepoId" | "installationId">): FrozenWriteAuthority {
  if (!Number.isSafeInteger(mapping.installationId) || Number(mapping.installationId) <= 0)
    throw new PlaneApiError(403, {}, "A verified installation is required for outbound authority");
  return Object.freeze({ workspaceSlug: mapping.workspaceSlug, mappingId: String(mapping.id),
    repoId: mapping.ghRepoId, installationId: mapping.installationId! });
}

function toMapping(r: any): Mapping {
  const [owner = "", repo = ""] = String(r.gh_repo_full_name).split("/");
  return {
    id: Number(r.id), workspaceSlug: r.workspace_slug, ghRepoId: Number(r.gh_repo_id), ghRepoFullName: r.gh_repo_full_name, owner, repo,
    planeProjectId: r.plane_project_id, syncDirection: r.sync_direction, smartCommitsEnabled: r.smart_commits_enabled,
    linkbackEnabled: r.linkback_enabled, autolinksEnabled: r.autolinks_enabled,
    installationId: r.installation_id === null || r.installation_id === undefined ? null : Number(r.installation_id),
  };
}

/**
 * A mapping syncs only while its verified installation is allow-listed for its own workspace.
 * Legacy unresolved rows stay disabled until an administrator verifies and saves them.
 * A mapping that fails the check is skipped and audited as `installation_not_allowed`.
 */
async function allowedMappings(db: Db, where: string, params: unknown[]): Promise<Mapping[]> {
  const rows = (await db.query(
    `SELECT rm.*, (wi.installation_id IS NOT NULL) AS allowed
       FROM repo_mappings rm
       LEFT JOIN workspace_installations wi ON wi.installation_id = rm.installation_id AND wi.workspace_slug = rm.workspace_slug
      WHERE ${where} ORDER BY rm.id`, params)).rows;
  for (const r of rows.filter((x: any) => !x.allowed)) {
    await appendAudit(db, {
      kind: "installation_not_allowed", source: "mapping", workspaceSlug: r.workspace_slug,
      detail: { mappingId: Number(r.id), ghRepoId: Number(r.gh_repo_id), installationId: r.installation_id == null ? null : Number(r.installation_id) }, outcome: "skipped",
    });
  }
  return rows.filter((x: any) => x.allowed).map(toMapping);
}

export async function mappingsForRepo(db: Db, ghRepoId: number): Promise<Mapping[]> {
  return allowedMappings(db, "rm.gh_repo_id = $1", [ghRepoId]);
}

export type OrphanSourceLink = Pick<SyncLinkRow, "gh_repo_id" | "gh_number" | "plane_issue_id" | "plane_workspace_slug"> &
  Partial<Pick<SyncLinkRow, "plane_project_id" | "gh_kind" | "created_by">>;

/** Resolve ownership, not a repository-wide default. A PR's target project does not identify its source mapping. */
export async function mappingForOrphanLink(db: Db, link: OrphanSourceLink): Promise<Mapping | null> {
  if (!link.plane_project_id) return null;
  const repoId = Number(link.gh_repo_id);
  const source = async (mappingId?: string) => {
    const matches = await allowedMappings(db, `rm.gh_repo_id = $1 AND rm.workspace_slug = $2 AND ${mappingId === undefined ? "rm.plane_project_id = $3" : "rm.id = $3"}`,
      [repoId, link.plane_workspace_slug, mappingId ?? link.plane_project_id]);
    return matches.length === 1 ? matches[0]! : null;
  };
  if (link.gh_kind === "issue" && link.created_by === "label_sync") return source();
  if (link.gh_kind !== "pr") return null;

  // A -NEW create stores its source authority alongside the exact sync-link action and saved remote ID.
  // Retention may remove this evidence; an unrelated current project mapping must never replace it.
  const candidates = (await db.query<{ write: any; result: any }>(`SELECT write, result FROM outbound_writes
    WHERE side = 'plane' AND write->>'kind' = 'create_issue' AND write->>'slug' = $1
      AND write->>'projectId' = $2 AND result->>'id' = $3 ORDER BY sequence`,
  [link.plane_workspace_slug, link.plane_project_id, link.plane_issue_id])).rows;
  const owners = new Set<string>();
  for (const { write, result } of candidates) {
    const plan = write._plan;
    if (!plan || !Array.isArray(plan.after)) continue;
    const results = { current: result, ...(typeof plan.bind === "string" ? { [plan.bind]: result } : {}) };
    const matchesLink = plan.after.some((step: any) => {
      if (step.kind !== "sync_link") return false;
      let saved: any;
      try { saved = resolvePlanValue(step.link, results); } catch { return false; }
      return saved.planeWorkspaceSlug === link.plane_workspace_slug && saved.planeProjectId === link.plane_project_id
        && saved.planeIssueId === link.plane_issue_id && Number(saved.ghRepoId) === repoId
        && saved.ghNumber === link.gh_number && saved.ghKind === "pr";
    });
    if (!matchesLink) continue;
    if (Object.hasOwn(write, "_authority")) {
      const authority = write._authority;
      if (!authority || authority.workspaceSlug !== link.plane_workspace_slug || authority.repoId !== repoId
        || typeof authority.mappingId !== "string" || !/^[1-9]\d*$/.test(authority.mappingId)) return null;
      owners.add(authority.mappingId);
    } else if (typeof plan.root === "string") {
      // Older workflows already retained the original PR continuation's source mapping, before _authority existed.
      const resumes = (await db.query<{ write: any }>(`SELECT write FROM outbound_writes
        WHERE write->'_plan'->>'root' = $1 AND write->>'kind' = 'resume_reducer'
          AND write->'continuation'->>'kind' = 'pr_created'`, [plan.root])).rows;
      for (const { write: resume } of resumes) {
        const c = resume.continuation;
        if (c.projectId === link.plane_project_id && Number(c.job?.payload?.repository?.id) === repoId
          && c.job?.payload?.pull_request?.number === link.gh_number && Number.isSafeInteger(c.mappingId) && c.mappingId > 0)
          owners.add(String(c.mappingId));
      }
    }
  }
  return owners.size === 1 ? source([...owners][0]!) : null;
}

/** Mappings of a Plane project, optionally narrowed to one workspace (F2: a project id alone is not an authority). */
export async function mappingsForProject(db: Db, planeProjectId: string, workspaceSlug?: string): Promise<Mapping[]> {
  return workspaceSlug === undefined
    ? allowedMappings(db, "rm.plane_project_id = $1", [planeProjectId])
    : allowedMappings(db, "rm.plane_project_id = $1 AND rm.workspace_slug = $2", [planeProjectId, workspaceSlug]);
}

export async function mappingForRepoName(db: Db, ghRepoId: number): Promise<Mapping | null> {
  return (await mappingsForRepo(db, ghRepoId))[0] ?? null;
}

export async function rememberInstallation(db: Db, mappingId: number, installationId: number): Promise<void> {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new PlaneApiError(403, {}, "GitHub installation is not allowed for this workspace");
  const saved = await db.query(`UPDATE repo_mappings rm SET installation_id = $1
    WHERE rm.id = $2 AND EXISTS (SELECT 1 FROM workspace_installations wi
      WHERE wi.installation_id = $1 AND wi.workspace_slug = rm.workspace_slug) RETURNING rm.id`, [installationId, mappingId]);
  if (!saved.rows.length) throw new PlaneApiError(403, {}, "GitHub installation is not allowed for this workspace");
}

/** Re-read authority at the point of use, including retries of durable writes. */
export async function assertInstallationAllowed(db: Db, installationId: number, workspaceSlug: string): Promise<void> {
  if (!workspaceSlug || !Number.isSafeInteger(installationId) || installationId <= 0
    || !(await db.query("SELECT 1 FROM workspace_installations WHERE installation_id = $1 AND workspace_slug = $2", [installationId, workspaceSlug])).rows.length)
    throw new PlaneApiError(403, {}, "GitHub installation is not allowed for this workspace");
}

/** Production outbox authority, using stored workflow context before resolving its result references. */
export function createOutboundAuthoriser(db: Db) {
  return async (side: "plane" | "github", write: unknown, workspaceSlug: string | undefined): Promise<void> => {
    const denied = () => new PlaneApiError(403, {}, "Outbound installation authority is missing or revoked");
    if (!workspaceSlug || !write || typeof write !== "object") throw denied();
    const w = write as Record<string, any>;
    const checkMapping = async (where: string, params: unknown[]) => {
      const { rows } = await db.query<{ installation_id: number | string | null }>(
        `SELECT installation_id FROM repo_mappings WHERE workspace_slug = $1 AND ${where}`, [workspaceSlug, ...params]);
      if (!rows.length) throw denied();
      for (const row of rows) await assertInstallationAllowed(db, Number(row.installation_id), workspaceSlug);
    };
    if (Object.hasOwn(w, "_authority")) {
      const authority: unknown = w._authority;
      if (!authority || typeof authority !== "object") throw denied();
      const a = authority as Partial<FrozenWriteAuthority>;
      if (a.workspaceSlug !== workspaceSlug || typeof a.mappingId !== "string" || !/^[1-9]\d*$/.test(a.mappingId)
        || !Number.isSafeInteger(a.repoId) || Number(a.repoId) <= 0
        || !Number.isSafeInteger(a.installationId) || Number(a.installationId) <= 0) throw denied();
      // Check exactly the frozen source mapping. Neither SHA completion nor another target mapping grants access.
      await checkMapping("id = $2 AND gh_repo_id = $3 AND installation_id = $4", [a.mappingId, a.repoId, a.installationId]);
      if (w.kind === "resume_reducer") {
        if (String(w.continuation?.mappingId) !== a.mappingId
          || (w.continuation?.workspaceSlug !== undefined && w.continuation.workspaceSlug !== workspaceSlug)) throw denied();
      } else if (side === "github") {
        if (w.installationId !== a.installationId || w.repoId !== a.repoId) throw denied();
      } else if (w.slug !== workspaceSlug) throw denied();
      return;
    }
    // Continuations are local reducer dispatches on either queue, not GitHub API writes.
    if (w.kind === "resume_reducer") {
      if (w.continuation?.workspaceSlug !== undefined && w.continuation.workspaceSlug !== workspaceSlug) throw denied();
      await checkMapping("id = $2", [w.continuation?.mappingId]);
      return;
    }
    if (side === "github") {
      await assertInstallationAllowed(db, Number(w.installationId), workspaceSlug);
      await checkMapping("gh_repo_id = $2 AND installation_id = $3", [w.repoId, w.installationId]);
      return;
    }
    if (w.slug !== workspaceSlug) throw denied();
    // Smart Commit targets may be in another workspace project; its durable claim owns the source repository.
    if (typeof w._smartCommit?.sha === "string") {
      const { rows } = await db.query<{ repo_id: number | string }>(
        "SELECT repo_id FROM processed_commits WHERE sha = $1 AND workspace_slug = $2", [w._smartCommit.sha, workspaceSlug]);
      if (!rows.length) throw denied();
      await checkMapping("gh_repo_id = $2", [rows[0]!.repo_id]);
      return;
    }
    // Create plans preserve their repository and installation in sibling GitHub steps / reducer continuations.
    // Inspect the durable group, so a cross-project PR create still uses the original mapping's authority.
    if (typeof w._plan?.root === "string") {
      const { rows } = await db.query<{ write: Record<string, any> }>(
        "SELECT write FROM outbound_writes WHERE id = $1 OR write->'_plan'->>'root' = $1 ORDER BY sequence", [w._plan.root]);
      let checked = false;
      for (const { write: step } of rows) {
        if (step.installationId !== undefined) {
          await assertInstallationAllowed(db, Number(step.installationId), workspaceSlug);
          await checkMapping("gh_repo_id = $2 AND installation_id = $3", [step.repoId, step.installationId]);
          checked = true;
        }
        if (step.continuation?.mappingId !== undefined) {
          await checkMapping("id = $2", [step.continuation.mappingId]); checked = true;
        }
        const repoId = step._plan?.marker?.link?.ghRepoId;
        if (repoId !== undefined) { await checkMapping("gh_repo_id = $2", [repoId]); checked = true; }
      }
      if (checked) return;
    }
    // Older standalone writes carry only their Plane target. Fail closed if any candidate mapping is revoked.
    // Include authorized cross-project links; their mapping's default project can differ from the target.
    await checkMapping(`(plane_project_id = $2 OR gh_repo_id IN
      (SELECT gh_repo_id FROM sync_links WHERE plane_workspace_slug = $1 AND plane_project_id = $2 AND plane_issue_id = $3))`,
    [w.projectId, typeof w.issueId === "string" ? w.issueId : null]);
  };
}

export interface DisabledMapping {
  id: number;
  workspaceSlug: string;
  ghRepoFullName: string;
  planeProjectId: string;
  installationId: number | null;
  reason: "unresolved" | "installation_not_allowed";
}

/** Instance-admin upgrade inventory; no unresolved mapping is silently treated as authorized. */
export async function disabledMappings(db: Db): Promise<DisabledMapping[]> {
  const { rows } = await db.query(`SELECT rm.* FROM repo_mappings rm
    LEFT JOIN workspace_installations wi ON wi.installation_id = rm.installation_id AND wi.workspace_slug = rm.workspace_slug
    WHERE wi.installation_id IS NULL ORDER BY rm.workspace_slug, rm.id`);
  return rows.map((r) => ({ id: Number(r.id), workspaceSlug: r.workspace_slug, ghRepoFullName: r.gh_repo_full_name,
    planeProjectId: r.plane_project_id, installationId: r.installation_id == null ? null : Number(r.installation_id),
    reason: r.installation_id == null ? "unresolved" : "installation_not_allowed" }));
}
