// Authenticates a browser request against Plane's own session (spec §8: no second auth system).
// Every call goes to Plane; nothing is cached, so a demoted admin's next request fails. Only the
// relevant Plane session is forwarded, and only GET requests are ever made.
import type { IncomingMessage } from "node:http";
import { HttpError } from "./http.ts";
import type { PlaneWorkspace } from "./client/types.ts";

export interface PlaneAuthDeps {
  planeInternalUrl: string;
  planeSessionCookieName?: string;
  fetch?: typeof fetch;
}

/** `workspaceId`: the Plane workspace the session's membership row belongs to (workspace routes only; audit S2). */
export interface Viewer { id: string; email: string | null; workspaceId?: string }

/** Plane v1.4.2 serialises every field of the membership row (`fields = "__all__"`), so `workspace` is its id. */
export const membershipWorkspace = (json: unknown): { workspaceId?: string } => {
  const id = field(json, "workspace");
  return typeof id === "string" && id ? { workspaceId: id } : {};
};

export const WORKSPACE_ADMIN_ROLE = 20;
const WEB_COOKIE = "session-id";
const ADMIN_COOKIE = "admin-session-id";
const PLANE_TIMEOUT_MS = 8000;
// RFC 6265 cookie-octet: nothing that could break out of the Cookie header we build.
const COOKIE_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]{1,2048}$/;

export function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return COOKIE_VALUE.test(value) ? value : null;
  }
  return null;
}

async function planeGet(deps: PlaneAuthDeps, path: string, cookie: string): Promise<{ status: number; json: unknown }> {
  const doFetch = deps.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(deps.planeInternalUrl.replace(/\/+$/, "") + path, {
      method: "GET",
      headers: { cookie, accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(PLANE_TIMEOUT_MS),
    });
  } catch {
    throw new HttpError(502, "Plane is unreachable");
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    return { status: res.status, json: null };
  }
  try {
    return { status: 200, json: await res.json() };
  } catch {
    throw new HttpError(502, "Plane returned an unreadable response");
  }
}

function field(json: unknown, key: string): unknown {
  return typeof json === "object" && json !== null ? (json as Record<string, unknown>)[key] : undefined;
}

/** Valid Plane web session, workspace role 20 (admin). 401 without a session, 403 below admin. */
export async function authenticateWorkspaceAdmin(deps: PlaneAuthDeps, req: IncomingMessage, slug: string): Promise<Viewer> {
  const webCookie = deps.planeSessionCookieName ?? WEB_COOKIE;
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(webCookie)) throw new HttpError(502, "Plane session cookie name is invalid");
  const sid = cookieValue(req.headers.cookie, webCookie);
  if (!sid) throw new HttpError(401, "Sign in to Plane to continue");
  const cookie = `${webCookie}=${sid}`;

  const me = await planeGet(deps, "/api/users/me/", cookie);
  if (me.status === 401 || me.status === 403) throw new HttpError(401, "Sign in to Plane to continue");
  if (me.status !== 200) throw new HttpError(502, "Plane could not verify the session");
  const id = field(me.json, "id");
  if (typeof id !== "string" || id === "") throw new HttpError(502, "Plane could not verify the session");
  const email = field(me.json, "email");

  // Plane v1.4.2 selects ADMIN_SESSION_COOKIE_NAME whenever the decoded path contains
  // "instances". Both names use the same session store: alias this verified web session,
  // never substitute the browser's potentially different instance-admin identity.
  const memberCookie = slug.includes("instances") ? `${cookie}; ${ADMIN_COOKIE}=${sid}` : cookie;
  const member = await planeGet(deps, `/api/workspaces/${encodeURIComponent(slug)}/workspace-members/me/`, memberCookie);
  if (member.status === 401) throw new HttpError(401, "Sign in to Plane to continue");
  if (member.status === 403 || member.status === 404) throw new HttpError(403, "Workspace admin access is required");
  if (member.status !== 200) throw new HttpError(502, "Plane could not verify the workspace role");
  const role = Number(field(member.json, "role"));
  if (!Number.isFinite(role) || role < WORKSPACE_ADMIN_ROLE) throw new HttpError(403, "Workspace admin access is required");
  return { id, email: typeof email === "string" ? email : null, ...membershipWorkspace(member.json) };
}

/** Valid Plane instance-admin session (the admin app's own cookie). */
export async function authenticateInstanceAdmin(deps: PlaneAuthDeps, req: IncomingMessage): Promise<Viewer> {
  const aid = cookieValue(req.headers.cookie, ADMIN_COOKIE);
  if (!aid) throw new HttpError(401, "Sign in to the Plane admin app to continue");
  const me = await planeGet(deps, "/api/instances/admins/me/", `${ADMIN_COOKIE}=${aid}`);
  if (me.status === 401 || me.status === 403) throw new HttpError(401, "Sign in to the Plane admin app to continue");
  if (me.status !== 200) throw new HttpError(502, "Plane could not verify the admin session");
  const id = field(me.json, "id");
  if (typeof id !== "string" || id === "") throw new HttpError(502, "Plane could not verify the admin session");
  const email = field(me.json, "email");
  return { id, email: typeof email === "string" ? email : null };
}

/** The v1.4.2 instance-admin endpoint paginates all workspaces using the admin session. */
export async function listInstanceWorkspaces(deps: PlaneAuthDeps, req: IncomingMessage): Promise<PlaneWorkspace[]> {
  const sid = cookieValue(req.headers.cookie, ADMIN_COOKIE);
  if (!sid) throw new HttpError(401, "Sign in to the Plane admin app to continue");
  const out: PlaneWorkspace[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const result = await planeGet(deps, `/api/instances/workspaces/${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, `${ADMIN_COOKIE}=${sid}`);
    if (result.status === 401 || result.status === 403) throw new HttpError(401, "Sign in to the Plane admin app to continue");
    if (result.status !== 200) throw new HttpError(502, "Plane could not load workspaces");
    const rows = Array.isArray(result.json) ? result.json : field(result.json, "results");
    if (!Array.isArray(rows)) throw new HttpError(502, "Plane returned an unreadable workspace list");
    for (const row of rows) {
      const id = field(row, "id"), slug = field(row, "slug"), name = field(row, "name");
      if (typeof id !== "string" || typeof slug !== "string" || typeof name !== "string" || !id || !slug || !name)
        throw new HttpError(502, "Plane returned an unreadable workspace");
      out.push({ id, slug, name });
    }
    if (Array.isArray(result.json) || field(result.json, "next_page_results") !== true)
      return out.sort((a, b) => a.name.localeCompare(b.name));
    const next = field(result.json, "next_cursor");
    if (typeof next !== "string" || !next || seen.has(next)) throw new HttpError(502, "Plane workspace pagination did not complete");
    seen.add(next); cursor = next;
  }
  throw new HttpError(502, "Plane workspace pagination did not complete");
}
