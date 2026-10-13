// Authorises a repository↔project mapping before it is stored (spec §8, §9). The viewer's role check
// proves they administer the workspace in the path; it does not prove the project belongs to that
// workspace or that the repository is one this deployment's GitHub App can reach. Without these checks a
// workspace admin could map another workspace's project, or any repository the App is installed on.
import { classifyGithubError } from "../github/errors.ts";
import { PlaneApiError, planeWorkspacePath } from "../sync/plane.ts";

/** Returns the reason a mapping is refused, or null when it is acceptable. Infrastructure errors throw. */
export type MappingVerifier = (check: {
  slug: string;
  planeProjectId?: string;
  repo?: { id: number; fullName: string };
  /** Called only after the repository identity and its workspace authority have both been verified. */
  onInstallationVerified?(installationId: number): void;
}) => Promise<string | null>;

export interface MappingVerifierDeps {
  /**
   * Instance-admin allow-list of installations per workspace (F4). A repository is accepted only when its installation is
   * listed for the requesting workspace; without this dependency every repository is refused (fail closed).
   */
  installationWorkspace?: InstallationWorkspace;
  /** Plane with the service PAT (`PlaneClient`); only GET requests are made. */
  plane: { request(method: string, path: string): Promise<unknown> };
  github: {
    installationIdFor(owner: string, repo: string): Promise<number>;
    installationOctokit(installationId: number): Promise<{ request(route: string, params?: Record<string, unknown>): Promise<{ data: any }> }>;
  };
}

/** Which workspace an installation is allow-listed for, or null. Backed by `workspace_installations` (F4). */
export type InstallationWorkspace = (installationId: number) => Promise<string | null>;

export function installationWorkspaceFromDb(db: { query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> }): InstallationWorkspace {
  return async (installationId) => {
    const { rows } = await db.query<{ workspace_slug: string }>(`SELECT workspace_slug FROM workspace_installations WHERE installation_id = $1`, [installationId]);
    return rows[0]?.workspace_slug ?? null;
  };
}

export function createMappingVerifier(deps: MappingVerifierDeps): MappingVerifier {
  return async ({ slug, planeProjectId, repo, onInstallationVerified }) => {
    if (planeProjectId !== undefined) {
      try {
        await deps.plane.request("GET", planeWorkspacePath(slug, "projects", planeProjectId));
      } catch (e) {
        // 404: no such project here. 403: the service account cannot see it, so it cannot sync it either.
        // 400: the id is not a Plane id at all (`..`, `/`, `%`), refused before any request (audit S1).
        if (e instanceof PlaneApiError && (e.status === 404 || e.status === 403 || e.status === 400)) return "That Plane project does not exist in this workspace";
        throw e;
      }
    }
    if (repo !== undefined) {
      const [owner, name] = repo.fullName.split("/");
      if (!owner || !name) return "The repository must be given as owner/repo";
      let data: any;
      let installationId: number;
      try {
        installationId = await deps.github.installationIdFor(owner, name);
        if (!Number.isSafeInteger(installationId) || installationId <= 0) return "The GitHub App is not installed on that repository";
        const allowedFor = deps.installationWorkspace ? await deps.installationWorkspace(installationId) : null;
        if (allowedFor !== slug) return "That GitHub installation is not allowed for this workspace; ask an instance admin to allow-list it";
        const octokit = await deps.github.installationOctokit(installationId);
        data = (await octokit.request("GET /repos/{owner}/{repo}", { owner, repo: name })).data;
      } catch (e) {
        const kind = classifyGithubError(e).kind;
        if (kind === "not_found" || kind === "permission") return "The GitHub App is not installed on that repository";
        throw e;
      }
      if (Number(data?.id) !== repo.id) return "The repository id does not match that repository on GitHub";
      if (String(data?.full_name ?? "").toLowerCase() !== repo.fullName.toLowerCase()) return "The repository name does not match the repository id on GitHub";
      // Re-read after GitHub's identity lookup: a concurrent move/revocation cannot certify the old workspace.
      if (await deps.installationWorkspace?.(installationId) !== slug) return "That GitHub installation is not allowed for this workspace; ask an instance admin to allow-list it";
      onInstallationVerified?.(installationId);
    }
    return null;
  };
}

/** Resolves a login to GitHub's canonical login and id; null when no such account exists. Outages throw. */
export type GithubUserLookup = (login: string) => Promise<{ login: string; id: number } | null>;

/** Resolve public profiles through an unauthenticated client or an authorized installation token. */
export function createGithubUserLookup(request: (route: string, params: Record<string, unknown>) => Promise<{ data: any }>): GithubUserLookup {
  return async (login) => {
    try {
      const { data } = await request("GET /users/{username}", { username: login });
      const id = Number(data?.id);
      return Number.isSafeInteger(id) && typeof data?.login === "string" ? { login: data.login, id } : null;
    } catch (e) {
      if (classifyGithubError(e).kind === "not_found") return null;
      throw e;
    }
  };
}

/** Whether a Plane user is a member of a workspace (service PAT, `GET /workspaces/{slug}/members/`). Outages throw. */
export type WorkspaceMemberCheck = (slug: string, planeUserId: string) => Promise<boolean>;

export function createPlaneMemberCheck(plane: { request(method: string, path: string): Promise<unknown> }): WorkspaceMemberCheck {
  return async (slug, planeUserId) => {
    const body = (await plane.request("GET", planeWorkspacePath(slug, "members"))) as any;
    const rows: any[] = Array.isArray(body) ? body : Array.isArray(body?.results) ? body.results : [];
    return rows.some((m) => String((m?.member && typeof m.member === "object" ? m.member.id : m?.member) ?? m?.id ?? "") === planeUserId);
  };
}
