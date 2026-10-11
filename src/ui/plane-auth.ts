// Authenticates a browser request against Plane's own session (spec §8: no second auth system).
// Every call goes to Plane; nothing is cached, so a demoted admin's next request fails. Only the
// one relevant Plane cookie is forwarded, and only GET requests are ever made.
import type { IncomingMessage } from "node:http";
import { HttpError } from "./http.ts";

export interface PlaneAuthDeps {
  planeInternalUrl: string;
  fetch?: typeof fetch;
}

export interface Viewer { id: string; email: string | null }

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
  const sid = cookieValue(req.headers.cookie, WEB_COOKIE);
  if (!sid) throw new HttpError(401, "Sign in to Plane to continue");
  const cookie = `${WEB_COOKIE}=${sid}`;

  const me = await planeGet(deps, "/api/users/me/", cookie);
  if (me.status === 401 || me.status === 403) throw new HttpError(401, "Sign in to Plane to continue");
  if (me.status !== 200) throw new HttpError(502, "Plane could not verify the session");
  const id = field(me.json, "id");
  if (typeof id !== "string" || id === "") throw new HttpError(502, "Plane could not verify the session");
  const email = field(me.json, "email");

  const member = await planeGet(deps, `/api/workspaces/${encodeURIComponent(slug)}/workspace-members/me/`, cookie);
  if (member.status === 401) throw new HttpError(401, "Sign in to Plane to continue");
  if (member.status === 403 || member.status === 404) throw new HttpError(403, "Workspace admin access is required");
  if (member.status !== 200) throw new HttpError(502, "Plane could not verify the workspace role");
  const role = Number(field(member.json, "role"));
  if (!Number.isFinite(role) || role < WORKSPACE_ADMIN_ROLE) throw new HttpError(403, "Workspace admin access is required");
  return { id, email: typeof email === "string" ? email : null };
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
