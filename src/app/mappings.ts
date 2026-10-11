import type { Db } from "../db/migrate.ts";

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

export async function mappingsForRepo(db: Db, ghRepoId: number): Promise<Mapping[]> {
  return (await db.query("SELECT * FROM repo_mappings WHERE gh_repo_id = $1 ORDER BY id", [ghRepoId])).rows.map(toMapping);
}

/** Mappings of a Plane project, optionally narrowed to one workspace (F2: a project id alone is not an authority). */
export async function mappingsForProject(db: Db, planeProjectId: string, workspaceSlug?: string): Promise<Mapping[]> {
  const rows = workspaceSlug === undefined
    ? (await db.query("SELECT * FROM repo_mappings WHERE plane_project_id = $1 ORDER BY id", [planeProjectId])).rows
    : (await db.query("SELECT * FROM repo_mappings WHERE plane_project_id = $1 AND workspace_slug = $2 ORDER BY id", [planeProjectId, workspaceSlug])).rows;
  return rows.map(toMapping);
}

export async function mappingForRepoName(db: Db, ghRepoId: number): Promise<Mapping | null> {
  return (await mappingsForRepo(db, ghRepoId))[0] ?? null;
}

export async function rememberInstallation(db: Db, mappingId: number, installationId: number): Promise<void> {
  await db.query("UPDATE repo_mappings SET installation_id = $1 WHERE id = $2 AND installation_id IS DISTINCT FROM $1", [installationId, mappingId]);
}
