import { createServer } from "node:http";
import type { Server } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { startServer } from "../../src/index.ts";
import type { Route } from "../../src/index.ts";
import { migrate } from "../../src/db/migrate.ts";
import { createConfigRoutes } from "../../src/ui/api.ts";
import type { ConfigApiDeps, OperationsDeps } from "../../src/ui/api.ts";
import type { MappingVerifier } from "../../src/ui/mapping-check.ts";

export const ORIGIN = "https://tasks.example.test";
export const KEY = Buffer.alloc(32, 7);

export interface PlaneCall { method: string; url: string; cookie: string }

/** A stand-in for Plane's session endpoints that records every request it receives. */
export async function startFakePlane() {
  const calls: PlaneCall[] = [];
  const roles: Record<string, Record<string, number>> = { "u-adm": { acme: 20, other: 15 }, "u-mem": { acme: 15 } };
  const sessions: Record<string, { id: string; email: string }> = {
    adm: { id: "u-adm", email: "adm@x.y" },
    mem: { id: "u-mem", email: "mem@x.y" },
  };
  const state = { instanceAdminCookie: "inst", unavailable: false };
  const server: Server = createServer((req, res) => {
    const cookie = req.headers.cookie ?? "";
    calls.push({ method: req.method ?? "", url: req.url ?? "", cookie });
    const send = (s: number, o: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (state.unavailable) return send(503, { error: "down" });
    const sid = /(?:^|;\s*)session-id=([^;]+)/.exec(cookie)?.[1];
    const aid = /(?:^|;\s*)admin-session-id=([^;]+)/.exec(cookie)?.[1];
    if (req.url === "/api/instances/admins/me/") {
      return aid === state.instanceAdminCookie ? send(200, { id: "u-inst", email: "root@x.y" }) : send(401, { error: "no" });
    }
    const user = sid ? sessions[sid] : undefined;
    if (!user) return send(401, { error: "no" });
    if (req.url === "/api/users/me/") return send(200, user);
    const m = /^\/api\/workspaces\/([^/]+)\/workspace-members\/me\/$/.exec(req.url ?? "");
    if (m) {
      const role = roles[user.id]?.[m[1]!];
      return role ? send(200, { id: "wm", role }) : send(403, { error: "no" });
    }
    send(404, { error: "no" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    calls, roles, sessions, state, url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }),
  };
}

export const ADM = "session-id=adm; csrftoken=abc; ajs_anonymous_id=zzz";
export const MEM = "session-id=mem";
export const INST = "admin-session-id=inst";

export const MAPPING = {
  ghRepoId: 555, ghRepoFullName: "acme/web", planeProjectId: "p1", syncDirection: "bidirectional",
  smartCommitsEnabled: true, linkbackComments: true,
};

export interface CallOpts { cookie?: string; body?: unknown; origin?: string | null; type?: string | null; headers?: Record<string, string> }

export async function setup(extraRoutes: Route[] = [], operations?: OperationsDeps, verifyMapping?: MappingVerifier | null, more: Partial<ConfigApiDeps> = {}) {
  const db = new PGlite();
  await db.waitReady;
  await migrate(db);
  // F4: the allow-list table is created by the storage migration; this keeps the harness valid on a tree where it is not there yet.
  await db.exec(`CREATE TABLE IF NOT EXISTS workspace_installations (
    installation_id BIGINT PRIMARY KEY, workspace_slug TEXT NOT NULL, account_login TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const plane = await startFakePlane();
  const routes = createConfigRoutes({ db, planeInternalUrl: plane.url, publicOrigin: ORIGIN, tokenKey: KEY, ...(operations ? { operations } : {}), ...(verifyMapping === null ? {} : { verifyMapping: verifyMapping ?? (async () => null) }),
    // Permissive defaults: every login exists with id 1 and every Plane user is a member. Tests of the checks pass their own.
    lookupGithubUser: async (login) => ({ login, id: 1 }), isWorkspaceMember: async () => true, ...more });
  const srv = await startServer({ port: 0, host: "127.0.0.1", routes: [...routes, ...extraRoutes] });
  const base = `http://127.0.0.1:${srv.port}`;
  const call = (method: string, path: string, o: CallOpts = {}) => {
    const origin = o.origin === undefined ? ORIGIN : o.origin;
    const type = o.type === undefined ? "application/json" : o.type;
    const raw = o.body === undefined ? undefined : typeof o.body === "string" ? o.body : JSON.stringify(o.body);
    return fetch(`${base}/git-sync/api${path}`, {
      method,
      headers: {
        ...(o.cookie ? { cookie: o.cookie } : {}),
        ...(origin ? { origin } : {}),
        ...(raw !== undefined && type ? { "content-type": type } : {}),
        ...(o.headers ?? {}),
      },
      body: raw,
    });
  };
  const count = async (table: string) => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;
  return {
    db, plane, base, call, count,
    async close() { await srv.close(); await plane.close(); await db.close(); },
  };
}

export type Harness = Awaited<ReturnType<typeof setup>>;
