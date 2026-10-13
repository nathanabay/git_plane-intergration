// Development panel (spec §12.8 N3): the data behind the iframe in Plane's work-item sidebar, and Create branch.
// Every request is authorized by Plane itself with the viewer's own session: the work item must be readable
// by the viewer (Plane applies its guest rules), and creating a branch needs project role member (15) or admin.
// GitHub is reached only through the installation of a mapping that is still allow-listed for the workspace.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Route } from "../index.ts";
import type { Db } from "../db/migrate.ts";
import { appendAudit } from "../db/ledgers.ts";
import { readMappingParity } from "../db/parity.ts";
import { mappingsForProject } from "../app/mappings.ts";
import type { Mapping } from "../app/mappings.ts";
import { githubErrorStatus } from "../github/errors.ts";
import { githubRepositoryWebUrl } from "../github/pr-automation.ts";
import type { GithubRequester } from "../operations/tooling.ts";
import {
  branchRollupKey, branchTreeUrl, categorisedTitle, isValidGitBranchName, parseDevLinks, renderBranchName,
} from "../sync/dev-info.ts";
import type { DevLink, PrStatus } from "../sync/dev-info.ts";
import { HttpError, hasBody, isJsonContentType, readJsonBody, sendJson } from "./http.ts";
import { cookieValue } from "./plane-auth.ts";
import { SLUG_PATTERN, isValidPlaneId } from "./validate.ts";

export const PROJECT_MEMBER_ROLE = 15;
const WEB_COOKIE = "session-id";
const PLANE_TIMEOUT_MS = 8000;

export interface DevPanelDeps {
  db: Db;
  planeInternalUrl: string;
  planeSessionCookieName?: string;
  publicOrigin: string;
  /** Web origin of the configured GitHub host (hosts.ts `webOrigin`), for links when GitHub is not asked. */
  githubWebOrigin: string;
  /** Installation-token client for a mapping (installationFor + installationOctokit). */
  githubFor(mapping: Mapping): Promise<GithubRequester>;
  /**
   * Records the created branch on the work item as `[Branch] <name>` with the rollup key push.ts uses
   * (wire to upsertRollupLink with the service writer). Optional: the first push adds the link anyway.
   */
  linkBranch?(target: { slug: string; projectId: string; issueId: string }, mapping: Mapping, link: { key: string; title: string; url: string }): Promise<void>;
  fetch?: typeof fetch;
}

export interface DevPanelPr { title: string; url: string; status: PrStatus | null; review: string | null }
export interface DevPanelRepo {
  mappingId: number;
  repo: string;
  /** Branch name from the mapping's template and the viewer's linked GitHub login. */
  branchName: string;
  branchUrl: string;
}
export interface DevPanelData {
  key: string;
  title: string;
  /** Jira roll-up across the item's PRs: OPEN if any is open, else MERGED if any merged, else DECLINED. */
  prStatus: PrStatus | null;
  prs: DevPanelPr[];
  builds: DevLink[];
  deployments: DevLink[];
  previews: DevLink[];
  branches: DevLink[];
  repos: DevPanelRepo[];
  canCreateBranch: boolean;
}
export interface CreateBranchResult { created: boolean; branch: string; url: string }

const DEV_PATH = "/git-sync/api/workspaces/:slug/projects/:projectId/work-items/:issueId";

// ---- Plane, as the viewer ------------------------------------------------------------------------------------
interface ViewerSession { cookie: string }

async function planeGet(deps: DevPanelDeps, s: ViewerSession, path: string): Promise<{ status: number; json: any }> {
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(deps.planeInternalUrl.replace(/\/+$/, "") + path, {
      method: "GET", headers: { cookie: s.cookie, accept: "application/json" }, redirect: "manual",
      signal: AbortSignal.timeout(PLANE_TIMEOUT_MS),
    });
  } catch {
    throw new HttpError(502, "Plane is unreachable");
  }
  if (res.status !== 200) { await res.body?.cancel().catch(() => undefined); return { status: res.status, json: null }; }
  try { return { status: 200, json: await res.json() }; } catch { throw new HttpError(502, "Plane returned an unreadable response"); }
}

function session(deps: DevPanelDeps, req: IncomingMessage): ViewerSession {
  const name = deps.planeSessionCookieName ?? WEB_COOKIE;
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new HttpError(502, "Plane session cookie name is invalid");
  const sid = cookieValue(req.headers.cookie, name);
  if (!sid) throw new HttpError(401, "Sign in to Plane to continue");
  return { cookie: `${name}=${sid}` };
}

interface ItemAccess {
  viewerId: string;
  key: string;
  title: string;
  role: number;
  links: { title?: unknown; url?: unknown }[];
}

/**
 * Plane v1.4.2 web API, with the viewer's session: users/me, the work item (404/403 when the viewer may not
 * see it, including guests without guest_view_all_features), the project (for its identifier), the viewer's
 * project role, and the item's links.
 */
async function itemAccess(deps: DevPanelDeps, req: IncomingMessage, p: Record<string, string>, withLinks: boolean): Promise<ItemAccess> {
  const { slug = "", projectId = "", issueId = "" } = p;
  if (!SLUG_PATTERN.test(slug) || !isValidPlaneId(projectId) || !isValidPlaneId(issueId)) throw new HttpError(404, "Not Found");
  const s = session(deps, req);
  const base = `/api/workspaces/${encodeURIComponent(slug)}/projects/${encodeURIComponent(projectId)}`;
  const me = await planeGet(deps, s, "/api/users/me/");
  if (me.status === 401 || me.status === 403) throw new HttpError(401, "Sign in to Plane to continue");
  if (me.status !== 200 || typeof me.json?.id !== "string" || !me.json.id) throw new HttpError(502, "Plane could not verify the session");

  const item = await planeGet(deps, s, `${base}/issues/${encodeURIComponent(issueId)}/`);
  if (item.status === 401) throw new HttpError(401, "Sign in to Plane to continue");
  if (item.status === 403 || item.status === 404) throw new HttpError(404, "Work item not found");
  if (item.status !== 200) throw new HttpError(502, "Plane could not load the work item");
  if (String(item.json?.project_id) !== projectId || String(item.json?.id) !== issueId) throw new HttpError(404, "Work item not found");

  const project = await planeGet(deps, s, `${base}/`);
  if (project.status !== 200 || typeof project.json?.identifier !== "string") throw new HttpError(502, "Plane could not load the project");
  const sequence = Number(item.json?.sequence_id);
  if (!Number.isSafeInteger(sequence) || sequence <= 0) throw new HttpError(502, "Plane returned an unreadable work item");

  const member = await planeGet(deps, s, `${base}/project-members/me/`);
  const role = member.status === 200 ? Number(member.json?.role) : 0;

  let links: { title?: unknown; url?: unknown }[] = [];
  if (withLinks) {
    const l = await planeGet(deps, s, `${base}/issues/${encodeURIComponent(issueId)}/issue-links/`);
    if (l.status !== 200) throw new HttpError(502, "Plane could not load the work item's links");
    links = Array.isArray(l.json) ? l.json : Array.isArray(l.json?.results) ? l.json.results : [];
  }
  return {
    viewerId: me.json.id, key: `${project.json.identifier}-${sequence}`, title: String(item.json?.name ?? ""),
    role: Number.isFinite(role) ? role : 0, links,
  };
}

async function githubLogin(db: Db, slug: string, planeUserId: string): Promise<string | null> {
  const r = (await db.query<{ gh_login: string }>(`SELECT gh_login FROM user_map WHERE workspace_slug = $1 AND plane_user_id = $2`, [slug, planeUserId])).rows[0];
  return r?.gh_login ?? null;
}

function repoWebUrl(deps: DevPanelDeps, m: Mapping): string {
  return `${deps.githubWebOrigin.replace(/\/+$/, "")}/${encodeURIComponent(m.owner)}/${encodeURIComponent(m.repo)}`;
}

// ---- data ---------------------------------------------------------------------------------------------------

/** `#12 Title · OPEN · REVIEW` (prRollupTitle) back into its parts. */
export function parsePrLink(l: DevLink): DevPanelPr {
  const parts = l.text.split(" · ");
  const status = (["OPEN", "MERGED", "DECLINED"] as const).find((s) => s === parts[1]) ?? null;
  const review = status === "OPEN" && parts[2] ? parts[2] : null;
  return { title: parts[0] ?? l.text, url: l.url, status, review };
}

export function rollupPrStatus(prs: DevPanelPr[]): PrStatus | null {
  for (const s of ["OPEN", "MERGED", "DECLINED"] as const) if (prs.some((p) => p.status === s)) return s;
  return null;
}

export async function loadDevPanel(deps: DevPanelDeps, req: IncomingMessage, params: Record<string, string>): Promise<DevPanelData> {
  const a = await itemAccess(deps, req, params, true);
  const slug = params.slug!;
  const links = parseDevLinks(a.links);
  const prs = links.filter((l) => l.category === "PR").map(parsePrLink);
  const login = await githubLogin(deps.db, slug, a.viewerId);
  const repos: DevPanelRepo[] = [];
  for (const m of await mappingsForProject(deps.db, params.projectId!, slug)) {
    const parity = await readMappingParity(deps.db, m.id);
    const branchName = renderBranchName(parity?.branchTemplate ?? null, { key: a.key, title: a.title, username: login });
    if (!isValidGitBranchName(branchName)) continue;
    repos.push({ mappingId: m.id, repo: m.ghRepoFullName, branchName, branchUrl: branchTreeUrl(repoWebUrl(deps, m), branchName) });
  }
  return {
    key: a.key, title: a.title, prStatus: rollupPrStatus(prs), prs,
    builds: links.filter((l) => l.category === "CI"),
    deployments: links.filter((l) => l.category === "Deploy"),
    previews: links.filter((l) => l.category === "Preview"),
    branches: links.filter((l) => l.category === "Branch"),
    repos,
    canCreateBranch: a.role >= PROJECT_MEMBER_ROLE && repos.length > 0,
  };
}

// ---- Create branch --------------------------------------------------------------------------------------------

function parseCreateBody(body: unknown): { mappingId: number } {
  const id = typeof body === "object" && body !== null ? (body as { mappingId?: unknown }).mappingId : undefined;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, "mappingId must be a positive integer");
  const extra = Object.keys(body as object).filter((k) => k !== "mappingId");
  if (extra.length) throw new HttpError(400, `Unknown field: ${extra[0]}`);
  return { mappingId: id };
}

/**
 * Creates the branch from the repository's default branch with the installation token:
 * GET /repos/{owner}/{repo} (default_branch), GET /repos/{owner}/{repo}/git/ref/heads/<default> (object.sha),
 * POST /repos/{owner}/{repo}/git/refs { ref: "refs/heads/<name>", sha }. A 422 for an existing branch is
 * success (created: false), so a double click or a retry is harmless; 409 means the repository is empty.
 */
export async function createBranch(deps: DevPanelDeps, req: IncomingMessage, params: Record<string, string>, body: unknown): Promise<CreateBranchResult> {
  const { mappingId } = parseCreateBody(body);
  const a = await itemAccess(deps, req, params, false);
  if (a.role < PROJECT_MEMBER_ROLE) throw new HttpError(403, "Only project members can create branches");
  const slug = params.slug!, projectId = params.projectId!, issueId = params.issueId!;
  const mapping = (await mappingsForProject(deps.db, projectId, slug)).find((m) => m.id === mappingId);
  if (!mapping) throw new HttpError(404, "This repository is not mapped to the project, or its installation is not approved");
  const parity = await readMappingParity(deps.db, mapping.id);
  const branch = renderBranchName(parity?.branchTemplate ?? null, { key: a.key, title: a.title, username: await githubLogin(deps.db, slug, a.viewerId) });
  if (!isValidGitBranchName(branch)) throw new HttpError(422, "The mapping's branch template does not give a valid branch name");

  const gh = await deps.githubFor(mapping);
  const repo = { owner: mapping.owner, repo: mapping.repo };
  const info = await githubStep(() => gh.request("GET /repos/{owner}/{repo}", repo), {});
  const base = typeof info.data?.default_branch === "string" ? info.data.default_branch : "";
  if (!base) throw new HttpError(409, EMPTY_REPO);
  const webUrl = await githubRepositoryWebUrl(gh, { ...repo, id: mapping.ghRepoId }, info.data);
  const url = branchTreeUrl(webUrl, branch);

  // An empty repository has no commit to branch from: its default branch ref is missing (404/409).
  const head = await githubStep(() => gh.request("GET /repos/{owner}/{repo}/git/ref/{ref}", { ...repo, ref: `heads/${base}` }), { 404: EMPTY_REPO, 409: EMPTY_REPO });
  const sha = head.data?.object?.sha;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) throw new HttpError(502, "GitHub returned an unreadable default branch");
  let created = true;
  try {
    await gh.request("POST /repos/{owner}/{repo}/git/refs", { ...repo, ref: `refs/heads/${branch}`, sha });
  } catch (err) {
    // 422 is GitHub's answer for an existing reference; confirm it rather than trust the status alone.
    if (githubErrorStatus(err) === 422 && await branchExists(gh, repo, branch)) created = false;
    else throw githubFailure(err, { 409: EMPTY_REPO });
  }
  await appendAudit(deps.db, {
    kind: "branch_created", source: "dev_panel", workspaceSlug: slug, outcome: created ? "applied" : "skipped",
    detail: { mappingId: mapping.id, ghRepoId: mapping.ghRepoId, branch, issueId, planeUserId: a.viewerId, existed: !created },
  });
  if (deps.linkBranch) {
    await deps.linkBranch({ slug, projectId, issueId }, mapping, { key: branchRollupKey(mapping.ghRepoId, branch), title: categorisedTitle("Branch", branch), url });
  }
  return { created, branch, url };
}

const EMPTY_REPO = "The repository is empty; push a first commit before creating branches";

function githubFailure(err: unknown, conflict: Partial<Record<404 | 409, string>>): HttpError {
  if (err instanceof HttpError) return err;
  const status = githubErrorStatus(err);
  if ((status === 404 || status === 409) && conflict[status]) return new HttpError(409, conflict[status]!);
  if (status === 403 || status === 404) return new HttpError(403, "The GitHub App cannot create branches in this repository (it needs Contents: write)");
  return new HttpError(502, "GitHub could not create the branch");
}

async function githubStep<T>(fn: () => Promise<T>, conflict: Partial<Record<404 | 409, string>>): Promise<T> {
  try { return await fn(); } catch (err) { throw githubFailure(err, conflict); }
}

async function branchExists(gh: GithubRequester, repo: { owner: string; repo: string }, branch: string): Promise<boolean> {
  try {
    await gh.request("GET /repos/{owner}/{repo}/git/ref/{ref}", { ...repo, ref: `heads/${branch}` });
    return true;
  } catch {
    return false;
  }
}

// ---- routes (registered by api.ts / main.ts) -------------------------------------------------------------------

export function createDevPanelRoutes(deps: DevPanelDeps): Route[] {
  const origin = new URL(deps.publicOrigin).origin;
  const fail = (res: ServerResponse, err: unknown) => {
    if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
    else sendJson(res, 500, { error: "Internal error" });
  };
  return [
    {
      method: "GET", path: `${DEV_PATH}/development`,
      handler: async (req, res, params) => {
        try { sendJson(res, 200, await loadDevPanel(deps, req, params)); } catch (err) { fail(res, err); }
      },
    },
    {
      method: "POST", path: `${DEV_PATH}/branches`,
      handler: async (req, res, params) => {
        try {
          // Cookies authorize this write, so refuse cross-site requests first (same rule as the config API).
          if (req.headers.origin !== origin) throw new HttpError(403, "Cross-site request refused");
          if (!hasBody(req) || !isJsonContentType(req.headers["content-type"])) throw new HttpError(415, "Content-Type must be application/json");
          const result = await createBranch(deps, req, params, await readJsonBody(req));
          sendJson(res, result.created ? 201 : 200, result);
        } catch (err) { fail(res, err); }
      },
    },
  ];
}
