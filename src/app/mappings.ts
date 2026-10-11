import type { Db } from "../db/migrate.ts";
import { appendAudit } from "../db/ledgers.ts";

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
 * F5: a mapping syncs only while its installation is allow-listed for its own workspace. A row with no remembered
 * installation yet cannot be judged here; it is checked as soon as the installation is resolved and remembered.
 * A mapping that fails the check is skipped and audited as `installation_not_allowed`.
 */
async function allowedMappings(db: Db, where: string, params: unknown[]): Promise<Mapping[]> {
  const rows = (await db.query(
    `SELECT rm.*, (rm.installation_id IS NULL OR wi.installation_id IS NOT NULL) AS allowed
       FROM repo_mappings rm
       LEFT JOIN workspace_installations wi ON wi.installation_id = rm.installation_id AND wi.workspace_slug = rm.workspace_slug
      WHERE ${where} ORDER BY rm.id`, params)).rows;
  for (const r of rows.filter((x: any) => !x.allowed)) {
    await appendAudit(db, {
      kind: "installation_not_allowed", source: "mapping", workspaceSlug: r.workspace_slug,
      detail: { mappingId: Number(r.id), ghRepoId: Number(r.gh_repo_id), installationId: Number(r.installation_id) }, outcome: "skipped",
    });
  }
  return rows.filter((x: any) => x.allowed).map(toMapping);
}

export async function mappingsForRepo(db: Db, ghRepoId: number): Promise<Mapping[]> {
  return allowedMappings(db, "rm.gh_repo_id = $1", [ghRepoId]);
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
  await db.query("UPDATE repo_mappings SET installation_id = $1 WHERE id = $2 AND installation_id IS DISTINCT FROM $1", [installationId, mappingId]);
}
