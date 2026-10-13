// Composition of the running service. Ingress comes up first and keeps working while the database is down;
// migrations are retried, and only then do the workers and the maintenance schedule start.
import { createWebhookRoutes } from "../api/handler.ts";
import { GithubUserTokens, createUserClientFactory, loadGithubHosts, loadGithubOAuthApp } from "../auth/github-user.ts";
import { SecretString, loadTokenKey } from "../auth/identity.ts";
import { loadConfig } from "../config/env.ts";
import type { Config } from "../config/env.ts";
import { createDb } from "../db/client.ts";
import { migrate } from "../db/migrate.ts";
import { appendAudit, spoolInbound } from "../db/ledgers.ts";
import { createQueues } from "../queue/index.ts";
import { startMaintenance } from "../queue/cron.ts";
import { startWorkers } from "../queue/workers.ts";
import { GithubWritePath } from "../sync/github.ts";
import { PlaneClient, PlaneWritePath, planeItemsPath } from "../sync/plane.ts";
import { createGithubUserLookup, createMappingVerifier, installationWorkspaceFromDb, createPlaneMemberCheck } from "../ui/mapping-check.ts";
import { createConfigRoutes, createUiRoutes, defaultUiDistDir } from "../ui/api.ts";
import { createSetupCheckHandler } from "../ui/setup-check.ts";
import { createDevPanelRoutes } from "../ui/dev-panel.ts";
import { upsertRollupLink } from "../sync/dev-info.ts";
import { authenticateInstanceAdmin } from "../ui/plane-auth.ts";
import { HttpError, sendJson } from "../ui/http.ts";
import type { Route } from "../index.ts";
import type { AppContext } from "./context.ts";
import { createVault, installationFor, issueResolver, refreshInstallationMappings } from "./context.ts";
import { createCredentialSource } from "./credentials.ts";
import type { CredentialSource } from "./credentials.ts";
import { createGithubClient } from "./github.ts";
import type { GithubClient } from "./github.ts";
import type { InboundJob } from "../queue/index.ts";
import { createOrderedOutbox } from "./writers.ts";
import { createOutboundAuthoriser, disabledMappings, freezeMappingAuthority, mappingForOrphanLink, mappingsForRepo } from "./mappings.ts";
import type { OrphanSourceLink } from "./mappings.ts";
import { createRouter, inboundHandler } from "./reducers.ts";
import { handleMirroredIssue, handlePendingMirroredIssue } from "./issues.ts";
import { handleCreatedPr } from "./pr.ts";

export interface RunningService { close(): Promise<void> }

export interface RouteParts {
  config: Config;
  db: AppContext["db"];
  tokenKey: Buffer;
  ctx: AppContext;
  planeClient: PlaneClient;
  ghClient: GithubClient;
  credentials: CredentialSource;
  enqueue(job: InboundJob): Promise<void>;
  /** F3: explicit retry of a failed outbound write, scoped to its stored workspace; unwired → the route answers 503. */
  retryFailed?(id: string, workspaceSlug: string): Promise<{ ok: true; retried: boolean }>;
}

/** Every HTTP route of the running service. Split from `runService` so a test can drive the real wiring (F1). */
export function composeRoutes({ config, db, tokenKey, ctx, planeClient, ghClient, credentials, enqueue, retryFailed }: RouteParts): Route[] {
  const devDeps: import("../ui/dev-panel.ts").DevPanelDeps = { db, planeInternalUrl: config.PLANE_BASE_URL, planeSessionCookieName: config.PLANE_SESSION_COOKIE_NAME,
      publicOrigin: config.PUBLIC_ORIGIN, githubWebOrigin: config.GITHUB_WEB_ORIGIN ?? "https://github.com",
      githubFor: async (mapping) => ghClient.installationOctokit(await installationFor(ctx, mapping)),
      linkBranch: async (target, mapping, link) => {
        await installationFor(ctx, mapping);
        await upsertRollupLink({ db, writer: ctx.plane, findLinkId: async (t, url) => {
          const links = await planeClient.listAll<{ id: string; url: string }>(planeItemsPath(t.slug, t.projectId, t.issueId) + "links/");
          return links.find((entry) => entry.url === url)?.id ?? null;
        } }, { ...target, _authority: freezeMappingAuthority(mapping) }, link.key, { title: link.title, url: link.url });
      },
  };
  return [
    ...createWebhookRoutes({
      planeSecret: [config.PLANE_WEBHOOK_SECRET, config.PLANE_WEBHOOK_SECRET_PREVIOUS].filter((secret): secret is string => Boolean(secret)),
      githubSecret: () => credentials.webhookSecret(),
      enqueue,
      spool: (job) => spoolInbound(db, job),
    }),
    ...createConfigRoutes({
      db,
      planeInternalUrl: config.PLANE_BASE_URL,
      planeSessionCookieName: config.PLANE_SESSION_COOKIE_NAME,
      planeDirectory: planeClient,
      requireVerifiedCommitsDefault: config.REQUIRE_VERIFIED_COMMITS,
      publicOrigin: config.PUBLIC_ORIGIN,
      tokenKey,
      githubOAuthConfig: config,
      appRequest: async (route, params) => { if (!ghClient.appRequest) throw new HttpError(503, "App authentication is unavailable"); return ghClient.appRequest(route, params); },
      credentialStatus: () => credentials.describe(),
      setupCheck: createSetupCheckHandler({ db, credentials, github: ghClient, plane: planeClient, config }),
      // F1: a mapping is only stored when its project is in the workspace and the App reaches its repository.
      verifyMapping: createMappingVerifier({ plane: planeClient, github: ghClient, installationWorkspace: installationWorkspaceFromDb(db) }),
      // F5: a manual user link is checked against the account GitHub reports for the login (id must match).
      lookupGithubUser: createGithubUserLookup(async (route, params) => {
        if (!ghClient.publicRequest) throw new Error("the GitHub client cannot read public profiles");
        return ghClient.publicRequest(route, params);
      }),
      lookupGithubRepo: async (slug, name) => {
        const [owner, repo] = name.split("/");
        const id = await ghClient.installationIdFor(owner!, repo!);
        if (await installationWorkspaceFromDb(db)(id) !== slug) throw new HttpError(403, "That GitHub installation is not allowed for this workspace");
        const octokit = await ghClient.installationOctokit(id);
        const { data } = await octokit.request("GET /repos/{owner}/{repo}", { owner, repo });
        if (await installationWorkspaceFromDb(db)(id) !== slug) throw new HttpError(403, "That GitHub installation is not allowed for this workspace");
        if (!Number.isSafeInteger(data?.id) || data.id <= 0 || typeof data?.full_name !== "string"
          || data.full_name.toLowerCase() !== name.toLowerCase()) throw new HttpError(502, "GitHub returned an unexpected repository");
        return { id: data.id, fullName: data.full_name };
      },
      refreshInstallation: (id) => refreshInstallationMappings(ctx, id),
      // F5: the Plane user being linked must be a member of the workspace in the path.
      isWorkspaceMember: createPlaneMemberCheck(planeClient),
      operations: {
        enqueue,
        ...(retryFailed ? { retryFailed } : {}),
        resolveIssue: (slug, key) => issueResolver(ctx, slug)(key),
        // Audit S5: the route passes the mapping's own allow-listed installation; never another workspace's.
        githubFor: async (repo) => {
          if (await ghClient.installationIdFor(repo.owner, repo.repo) !== repo.installationId)
            throw new HttpError(409, "The repository is no longer served by this mapping's GitHub installation");
          return ghClient.installationOctokit(repo.installationId);
        },
      },
    }),
    ...createDevPanelRoutes(devDeps).map((route, index): Route => ({ ...route, handler: async (req, res, params) => {
      try {
        const hosts = await loadGithubHosts(db, config);
        await createDevPanelRoutes({ ...devDeps, githubWebOrigin: hosts.webOrigin })[index]!.handler(req, res, params);
      } catch { sendJson(res, 500, { error: "Development settings could not be loaded" }); }
    } })),
    {
      method: "GET", path: "/git-sync/api/instance/disabled-mappings",
      handler: async (req, res) => {
        try {
          await authenticateInstanceAdmin({ planeInternalUrl: config.PLANE_BASE_URL, planeSessionCookieName: config.PLANE_SESSION_COOKIE_NAME }, req);
          sendJson(res, 200, await disabledMappings(db));
        } catch (err) {
          sendJson(res, err instanceof HttpError ? err.status : 500,
            { error: err instanceof HttpError ? err.message : "Could not read disabled mappings" });
        }
      },
    },
    ...createUiRoutes({ distDir: defaultUiDistDir() }),
  ];
}

export async function runService(
  env: NodeJS.ProcessEnv,
  hooks: { startServer(opts: { port: number; host: string; routes: Route[] }): Promise<{ port: number; close(): Promise<void> }> },
): Promise<RunningService> {
  const config: Config = loadConfig(env);
  const queues = createQueues({ connectionUrl: config.REDIS_URL, prefix: config.QUEUE_PREFIX });
  const db = createDb(config.DATABASE_URL);
  const planeClient = new PlaneClient({ baseUrl: config.PLANE_BASE_URL, token: new SecretString(config.PLANE_SERVICE_PAT), ...(config.PLANE_API_RATE_PER_MINUTE ? { rateLimitPerMinute: config.PLANE_API_RATE_PER_MINUTE } : {}) });
  const tokenKey = loadTokenKey(env);
  // F6: App credentials saved in the admin UI win over the environment, and are re-read as they change.
  const credentials = createCredentialSource(db, tokenKey, config);
  const ghClient = createGithubClient(credentials, db);
  // The workers apply writes through the inline paths; reducers only enqueue them (F9, src/app/writers.ts).
  const planeInline = new PlaneWritePath({ client: planeClient, db });
  const githubTokens = new GithubUserTokens({ db, tokenKey, app: () => loadGithubOAuthApp(db, tokenKey, config) });
  const githubInline = new GithubWritePath({ app: { installationOctokit: (id) => ghClient.installationOctokit(id) }, db,
    userClient: createUserClientFactory(githubTokens, () => loadGithubHosts(db, config), db), onUserTokenRejected: (id) => githubTokens.markRejected(id) });
  const vault = createVault(db, tokenKey);
  // F6 (round 2): every reducer write goes through one durable, per-target ordered outbox; the workers execute it.
  // The two readers run at execution time, so a read-modify-write of labels/assignees sees the current list.
  const ordered = createOrderedOutbox({
    db,
    authoriseWrite: createOutboundAuthoriser(db),
    plane: planeInline,
    github: githubInline,
    queues: { plane: queues.outboundPlane, github: queues.outboundGithub },
    findPlaneLinkId: async (target, url) => {
      // A rollup whose create is still queued is found by its URL at execution.
      const links = await planeClient.listAll<{ id: string; url: string }>(planeItemsPath(target.slug, target.projectId, target.issueId) + "links/");
      return links.find((link) => link.url === url)?.id ?? null;
    },
    resumeReducer: (request) => (request.kind === "mirror_created" ? handleMirroredIssue(ctx, request) : request.kind === "mirror_pending" ? handlePendingMirroredIssue(ctx, request) : handleCreatedPr(ctx, request)), // creates continue here once their work item exists
    loadActorToken: async (planeUserId) => (await vault.load(planeUserId, "plane_pat")) ?? null,
    readPlaneIssueFields: async (t) => {
      const issue = await planeClient.request<any>("GET", planeItemsPath(encodeURIComponent(t.slug), encodeURIComponent(t.projectId), encodeURIComponent(t.issueId)));
      const ids = (v: unknown): string[] => (Array.isArray(v) ? v : []).map((x) => (typeof x === "string" ? x : (x as { id?: unknown } | null)?.id)).filter((x): x is string => typeof x === "string");
      return { labels: ids(issue?.labels ?? issue?.label_ids), assignees: ids(issue?.assignees ?? issue?.assignee_ids) };
    },
    listGithubAssignees: async (t) => {
      const octokit = await ghClient.installationOctokit(t.installationId);
      const res = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", { owner: t.owner, repo: t.repo, issue_number: t.number });
      return (Array.isArray(res.data?.assignees) ? res.data.assignees : []).map((a: any) => String(a?.login));
    },
  });
  const ctx: AppContext = {
    config, db, planeClient, ghClient, vault,
    plane: ordered.plane,
    github: ordered.github,
  };

  const routes = composeRoutes({ config, db, tokenKey, ctx, planeClient, ghClient, credentials, enqueue: (job) => queues.enqueueInbound(job), retryFailed: (id, slug) => ordered.retryFailed(id, slug) });

  const server = await hooks.startServer({ port: config.PORT, host: config.HOST, routes });
  console.log(`git-sync server started on ${config.HOST}:${server.port}`);

  let stopping = false;
  let workers: { close(): Promise<void> } | undefined;
  let maintenance: { close(): Promise<void> } | undefined;

  const startBackground = async () => {
    for (;;) {
      try {
        await migrate(db);
        break;
      } catch (err) {
        if (stopping) return;
        console.error(`database not ready, retrying in 5s: ${err instanceof Error ? err.message : "unknown error"}`);
        await new Promise((r) => setTimeout(r, 5000));
        if (stopping) return;
      }
    }
    // F17: read per event (cached briefly), so a TTL changed in the admin UI applies without a restart.
    let ttl = { at: 0, minutes: 10 };
    const opTtlMinutes = async (): Promise<number> => {
      if (Date.now() - ttl.at > 15_000) {
        const r = await db.query<{ op_ttl_minutes: number }>("SELECT op_ttl_minutes FROM instance_settings WHERE id = 1");
        ttl = { at: Date.now(), minutes: Math.max(1, Number(r.rows[0]?.op_ttl_minutes ?? 10)) };
      }
      return ttl.minutes;
    };
    const router = createRouter(ctx);
    if (stopping) return;
    workers = startWorkers({
      connectionUrl: config.REDIS_URL,
      prefix: config.QUEUE_PREFIX,
      plane: planeInline,
      github: githubInline,
      ordered,
      inbound: {
        db,
        opTtlMinutes,
        ...(config.PLANE_SERVICE_USER_ID ? { serviceUserId: config.PLANE_SERVICE_USER_ID } : {}),
        onPlaneEvent: inboundHandler(ctx, router, "plane"),
        onGithubEvent: inboundHandler(ctx, router, "github"),
      },
    });
    maintenance = startMaintenance({ connectionUrl: config.REDIS_URL, prefix: config.QUEUE_PREFIX, db, plane: planeClient,
      enqueue: (job) => queues.enqueueInbound(job), onOrphan: (link) => linkbackOnOrphan(ctx, link) });
  };
  const background = startBackground();
  background.catch((err) => console.error("background startup failed:", err instanceof Error ? err.message : err));

  return {
    // Order matters: stop taking requests, drain workers, stop the schedule, then close what they use.
    async close() {
      stopping = true;
      await server.close();
      await background.catch(() => {});
      await workers?.close();
      await maintenance?.close();
      await queues.close();
      await db.close();
    },
  };
}

/** §1.3: an orphaned link is reported on the GitHub side when the mapping's linkback toggle is on. Nothing is closed. */
export async function linkbackOnOrphan(ctx: AppContext, link: OrphanSourceLink): Promise<void> {
  const mapping = await mappingForOrphanLink(ctx.db, link);
  if (!mapping || !mapping.linkbackEnabled) return;
  const installationId = await installationFor(ctx, mapping);
  const write = {
    kind: "comment" as const, installationId, owner: mapping.owner, repo: mapping.repo, repoId: mapping.ghRepoId, number: link.gh_number,
    _authority: freezeMappingAuthority(mapping),
    body: "The linked Plane work item can no longer be found, so this link has been marked orphaned. Nothing was changed or closed here.",
  };
  await ctx.github.apply(write);
  await appendAudit(ctx.db, { kind: "orphan_linkback", source: "github", workspaceSlug: mapping.workspaceSlug, detail: { ghNumber: link.gh_number, planeIssueId: link.plane_issue_id }, outcome: "commented" });
}
