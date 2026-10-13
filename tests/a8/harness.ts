// In-process composition of the service for the A8 suites: a real Postgres engine (PGlite), the real write
// paths and reducers, and fakes for the two network edges (Plane's HTTP API and GitHub's Octokit).
import { PGlite } from "@electric-sql/pglite";
import { randomBytes, randomUUID } from "node:crypto";
import { SecretString } from "../../src/auth/identity.ts";
import type { AppContext } from "../../src/app/context.ts";
import { createVault } from "../../src/app/context.ts";
import { createRouter, inboundHandler } from "../../src/app/reducers.ts";
import { processInbound } from "../../src/queue/workers.ts";
import type { InboundOutcome } from "../../src/queue/workers.ts";
import type { InboundJob } from "../../src/queue/index.ts";
import { migrate } from "../../src/db/migrate.ts";
import { upsertSyncLink } from "../../src/db/ledgers.ts";
import { GithubWritePath } from "../../src/sync/github.ts";
import { PlaneClient, PlaneWritePath } from "../../src/sync/plane.ts";

export const STATES = [
  { id: "s-backlog", name: "Backlog", group: "backlog", default: true },
  { id: "s-todo", name: "Todo", group: "unstarted" },
  { id: "s-prog", name: "In Progress", group: "started" },
  { id: "s-review", name: "In Review", group: "started" },
  { id: "s-done", name: "Done", group: "completed" },
  { id: "s-cancelled", name: "Won't Do", group: "cancelled" },
  { id: "s-triage", name: "Triage", group: "triage" },
];

// UUIDs and expanded labels mirror the recorded Plane v1.4.2 delivery shape.
export const LABELS = [
  { id: "95a43702-0992-4e30-95a0-d20ed54629ef", name: "github" },
  { id: "1f10db54-a763-46d9-962c-bc0c0f67b6cb", name: "bug" },
  { id: "7dbdb2a4-5202-4b6e-86b0-641c092b3f32", name: "feature" },
];

export interface PlaneCall { method: string; path: string; body: any; key: string | null }
export interface GhCall { route: string; params: any }
export interface PlaneIssueFake { id: string; project: string; state?: string | { id: string; group?: string }; labels?: string[]; assignees?: string[] }

export interface Harness {
  db: PGlite;
  ctx: AppContext;
  /** `deleteIssue` removes a created work item the way Plane's soft delete does: its external-id lookup is 404 too (E2E-2). */
  plane: { calls: PlaneCall[]; createdIssueIds: string[]; issues: Map<string, PlaneIssueFake>; writes(): PlaneCall[]; deleteIssue(id: string): void };
  gh: { calls: GhCall[]; writes(): GhCall[]; respond(match: RegExp, reply: (params: any) => unknown): void };
  feed(job: InboundJob): Promise<InboundOutcome>;
  mapping(opts?: { slug?: string; repoId?: number; projectId?: string; direction?: "bidirectional" | "github_to_plane"; linkback?: boolean; smartCommits?: boolean; rules?: string; policies?: Record<string, string>; installationId?: number | null }): Promise<number>;
  link(planeIssueId: string, ghNumber: number, extra?: { kind?: "issue" | "pr"; tier?: "closing" | "non_closing" | "relation"; slug?: string; project?: string }): Promise<void>;
  audit(kind: string): Promise<any[]>;
  close(): Promise<void>;
}

let seq = 0;

export async function makeHarness(over: { requireVerified?: boolean; serviceUserId?: string } = {}): Promise<Harness> {
  const db = new PGlite();
  await db.waitReady;
  await migrate(db);

  const planeCalls: PlaneCall[] = [];
  const issues = new Map<string, PlaneIssueFake>();
  issues.set("QLL-1", { id: "iss-1", project: "p-qll", state: "s-backlog" });
  issues.set("QLL-2", { id: "iss-2", project: "p-qll", state: "s-backlog" });
  issues.set("WEB-9", { id: "iss-9", project: "p-web", state: "s-backlog" });
  let created = 0;
  const createdIssueIds: string[] = [];
  const labels = LABELS.map((label) => ({ ...label }));

  // Created objects keep their external id, so the duplicate-recovery lookups of PlaneWritePath behave like Plane's (F9).
  const createdByIntent = new Map<string, { id: string; external_source: string; external_id: string }>();
  const commentsByPath = new Map<string, { id: string; external_source?: string; external_id?: string }[]>();

  const fetchFake = (async (url: string, init: any) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/api\/v1/, "");
    const method: string = init.method;
    const body = init.body ? JSON.parse(init.body) : null;
    planeCalls.push({ method, path, body, key: init.headers["X-API-Key"] ?? null });
    const json = (status: number, obj: unknown) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
    let m: RegExpExecArray | null;
    if (method === "GET" && (m = /\/work-items\/([A-Z]+-\d+)\/$/.exec(path))) {
      const i = issues.get(m[1]!);
      return i ? json(200, { ...i, labels: i.labels ?? [], assignees: i.assignees ?? [] }) : json(404, { error: "Not found" });
    }
    if (method === "GET" && /\/work-items\/$/.test(path) && u.searchParams.has("external_id")) {
      const found = createdByIntent.get(`${u.searchParams.get("external_source")}:${u.searchParams.get("external_id")}`);
      return found ? json(200, found) : json(404, { error: "Not found" });
    }
    if (method === "GET" && /\/work-items\/[^/]+\/comments\/$/.test(path)) return json(200, { results: commentsByPath.get(path) ?? [], next_cursor: null, next_page_results: false });
    if (method === "GET" && /\/states\/$/.test(path)) return json(200, { results: STATES, next_cursor: null, next_page_results: false });
    if (method === "GET" && /\/labels\/$/.test(path)) return json(200, { results: labels, next_cursor: null, next_page_results: false });
    if (method === "GET" && /\/projects\/$/.test(path)) return json(200, { results: [{ id: "p-qll", identifier: "QLL" }, { id: "p-web", identifier: "WEB" }], next_cursor: null, next_page_results: false });
    if (method === "GET" && /\/links\/$/.test(path)) return json(200, []);
    if (method === "GET" && (m = /\/work-items\/([^/]+)\/$/.exec(path))) {
      const i = [...issues.values()].find((x) => x.id === m![1]);
      return i ? json(200, { ...i, labels: i.labels ?? [], assignees: i.assignees ?? [] }) : json(404, { error: "Not found" });
    }
    if (method === "PATCH") return json(200, { id: "x" });
    if (method === "POST" && /\/work-items\/$/.test(path)) {
      const id = `new-${++created}`; createdIssueIds.push(id);
      const ext = body?.external_id ? { external_source: String(body.external_source ?? ""), external_id: String(body.external_id) } : {};
      if (body?.external_id) createdByIntent.set(`${ext.external_source}:${ext.external_id}`, { id, external_source: ext.external_source!, external_id: ext.external_id! });
      return json(201, { id, ...ext });
    }
    if (method === "POST" && /\/comments\/$/.test(path)) {
      const comment = { id: `c-${++created}`, ...(body?.external_id ? { external_source: String(body.external_source ?? ""), external_id: String(body.external_id) } : {}) };
      commentsByPath.set(path, [...(commentsByPath.get(path) ?? []), comment]);
      return json(201, comment);
    }
    if (method === "POST" && /\/links\/$/.test(path)) return json(201, { id: `l-${++created}` });
    if (method === "POST" && /\/labels\/$/.test(path)) {
      const existing = labels.find((label) => label.name === body.name);
      if (existing) return json(409, existing);
      const label = { id: randomUUID(), name: String(body.name) };
      labels.push(label);
      return json(201, label);
    }
    return json(200, {});
  }) as unknown as typeof fetch;

  const ghCalls: GhCall[] = [];
  const responders: [RegExp, (params: any) => unknown][] = [];
  const octokit = {
    request: async (route: string, params: any) => {
      ghCalls.push({ route, params });
      const r = responders.find(([re]) => re.test(route));
      if (r) return { data: r[1](params), status: 200, headers: {} };
      seq++;
      return { data: { id: 9000 + seq, number: 100 + seq }, status: 200, headers: {} };
    },
  };

  const planeClient = new PlaneClient({ baseUrl: "http://plane.test", token: new SecretString("svc-pat"), fetch: fetchFake, sleep: async () => {}, maxRetries: 0 });
  const plane = new PlaneWritePath({ client: planeClient, db });
  const ghClient = { installationOctokit: async () => octokit, installationIdFor: async () => 1 };
  const github = new GithubWritePath({ app: ghClient, db, sleep: async () => {} });
  const key = randomBytes(32);
  const ctx: AppContext = {
    config: {
      PORT: 0, HOST: "127.0.0.1", DATABASE_URL: "", REDIS_URL: "", QUEUE_PREFIX: "t", PLANE_BASE_URL: "http://plane.test", PLANE_SERVICE_PAT: "svc-pat",
      PLANE_WEBHOOK_SECRET: "x", GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY_PATH: "/nope", GITHUB_WEBHOOK_SECRET: "y", GITSYNC_TOKEN_KEY: key.toString("base64"),
      PUBLIC_ORIGIN: "https://tasks.example", REQUIRE_VERIFIED_COMMITS: over.requireVerified ?? false,
      PLANE_SERVICE_USER_ID: over.serviceUserId ?? "svc-user-default", // required config (prev F17); a test overrides it when it needs a specific id
    },
    db, planeClient, plane, github, ghClient, vault: createVault(db, key),
  };
  const router = createRouter(ctx);
  const deps = { db, opTtlMinutes: 30, ...(over.serviceUserId ? { serviceUserId: over.serviceUserId } : {}), onPlaneEvent: inboundHandler(ctx, router, "plane"), onGithubEvent: inboundHandler(ctx, router, "github") };

  return {
    db, ctx,
    plane: { calls: planeCalls, createdIssueIds, issues, writes: () => planeCalls.filter((c) => c.method !== "GET"),
      deleteIssue: (id) => {
        for (const [key, item] of createdByIntent) if (item.id === id) createdByIntent.delete(key);
        for (const [key, item] of issues) if (item.id === id) issues.delete(key);
      } },
    gh: { calls: ghCalls, writes: () => ghCalls.filter((c) => !c.route.startsWith("GET ")), respond: (re, fn) => { responders.unshift([re, fn]); } },
    feed: (job) => processInbound(job, deps),
    async mapping(o = {}) {
      // The real allow-list applies (round 4 F5): a mapping syncs only when its installation is listed for its workspace.
      const installationId = o.installationId === undefined ? 1 : o.installationId;
      if (installationId !== null) await db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES ($1, $2) ON CONFLICT (installation_id) DO NOTHING", [installationId, o.slug ?? "ws"]);
      const r = await db.query<{ id: number }>(
        `INSERT INTO repo_mappings (workspace_slug, gh_repo_id, gh_repo_full_name, plane_project_id, sync_direction, smart_commits_enabled, linkback_enabled, installation_id)
         VALUES ($1, $2, 'acme/web', $3, $4, $5, $6, $7) RETURNING id`,
        [o.slug ?? "ws", o.repoId ?? 555, o.projectId ?? "p-qll", o.direction ?? "bidirectional", o.smartCommits ?? true, o.linkback ?? false, installationId]);
      const id = r.rows[0]!.id;
      for (const [field, policy] of Object.entries(o.policies ?? {})) await db.query("INSERT INTO conflict_policies (mapping_id, field, policy) VALUES ($1, $2, $3)", [id, field, policy]);
      if (o.rules) await db.query("INSERT INTO rule_sets (mapping_id, yaml_source, version) VALUES ($1, $2, 1)", [id, o.rules]);
      return id;
    },
    async link(planeIssueId, ghNumber, extra = {}) {
      await upsertSyncLink(db, { planeWorkspaceSlug: extra.slug ?? "ws", planeProjectId: extra.project ?? "p-qll", planeIssueId, ghRepoId: 555, ghNumber, ghKind: extra.kind ?? "issue", tier: extra.tier ?? "relation", createdBy: "label_sync" });
    },
    async audit(kind) { return (await db.query<any>("SELECT * FROM audit_log WHERE kind = $1 ORDER BY id", [kind])).rows; },
    close: () => db.close(),
  };
}

// ---- payload builders --------------------------------------------------------------------------------
let delivery = 0;
const did = () => `d${++delivery}`;
export const REPO = { id: 555, default_branch: "main", name: "web", full_name: "acme/web", owner: { login: "acme" } };
export const BOT = { login: "gitsync[bot]", id: 77, type: "Bot" };
export const HUMAN = { login: "octo", id: 1, type: "User" };

export const ghJob = (event: string, payload: Record<string, unknown>, id = did()): InboundJob =>
  ({ source: "github", deliveryId: id, event, receivedAt: new Date().toISOString(), payload: { repository: REPO, installation: { id: 1 }, sender: HUMAN, ...payload } });
export const planeJob = (event: string, payload: Record<string, unknown>, id = did()): InboundJob =>
  ({ source: "plane", deliveryId: id, event, receivedAt: new Date().toISOString(), payload: { event, workspace_slug: "ws", ...payload } });

export const prPayload = (action: string, over: Record<string, unknown> = {}, pr: Record<string, unknown> = {}) => ({
  action,
  pull_request: { number: 12, title: "Fix login", body: "", draft: false, merged: false, state: "open", html_url: "https://github.com/acme/web/pull/12", base: { ref: "main" }, head: { ref: "octo/login" }, labels: [], user: { login: "octo" }, ...pr },
  ...over,
});
export const sha = (c: string) => c.repeat(40);
