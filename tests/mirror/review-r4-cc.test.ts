import test from "node:test";
import type { TestContext } from "node:test";
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createOrderedOutbox, deliveryScope } from "../../src/app/writers.ts";
import { createVault } from "../../src/app/context.ts";
import type { AppContext } from "../../src/app/context.ts";
import { SecretString } from "../../src/auth/identity.ts";
import { PlaneClient, PlaneWritePath } from "../../src/sync/plane.ts";
import { GithubWritePath } from "../../src/sync/github.ts";
import { handleGithubIssue, handleMirroredIssue, handlePendingMirroredIssue, handlePlaneIssue } from "../../src/app/issues.ts";
import { upsertSyncLink } from "../../src/db/ledgers.ts";
import { onGithubIssue, onPlaneIssue } from "../../src/sync/mirror.ts";
import type { MirrorDeps } from "../../src/sync/mirror.ts";
import type { InboundJob } from "../../src/queue/index.ts";
import { database, queue, intentJob } from "../writers/outbox-fixture.ts";

const LABELS = [{ id: "gate-github", name: "github" }];
let delivery = 0;
const ghJob = (event: string, payload: Record<string, unknown>): InboundJob => ({ source: "github", event,
  deliveryId: `gh-${++delivery}`, receivedAt: new Date().toISOString(),
  payload: { repository: { id: 555, full_name: "acme/web" }, installation: { id: 1 }, sender: { id: 1, login: "unmapped", type: "User" }, ...payload } });
const planeJob = (event: string, payload: Record<string, unknown>): InboundJob => ({ source: "plane", event,
  deliveryId: `plane-${++delivery}`, receivedAt: new Date().toISOString(), payload: { workspace_slug: "ws", event, ...payload } });

async function fixture(t: TestContext) {
  const db = await database(t);
  const mappingId = (await db.query<{ id: number }>(`INSERT INTO repo_mappings
    (workspace_slug, gh_repo_id, gh_repo_full_name, plane_project_id, sync_direction, installation_id, smart_commits_enabled)
    VALUES ('ws', 555, 'acme/web', 'p-qll', 'bidirectional', 1, false) RETURNING id`)).rows[0]!.id;
  await db.query("INSERT INTO rule_sets (mapping_id, yaml_source, version) VALUES ($1, $2, 1)",
    [mappingId, "- when: issue.labeled\n  then: [{comment: recreated-partner-rule}]\n"]);
  await db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (1, 'ws') ON CONFLICT DO NOTHING");
  const planeCalls: { method: string; path: string; body: any }[] = [];
  const githubCalls: { route: string; params: any }[] = [];
  const createdIssueIds: string[] = [];
  const issues = new Map<string, any>();
  const comments = new Map<string, any[]>();
  let objectId = 0;
  const planeClient = new PlaneClient({ baseUrl: "http://plane.test", token: new SecretString("service-pat"), maxRetries: 0,
    fetch: (async (url: string | URL | Request, init: RequestInit) => {
      const parsed = new URL(String(url)), path = parsed.pathname.replace(/^\/api\/v1/, "");
      const method = String(init.method), body = init.body ? JSON.parse(String(init.body)) : null;
      planeCalls.push({ method, path, body });
      const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
      if (method === "GET" && /\/work-items\/$/.test(path) && parsed.searchParams.has("external_id")) {
        const existing = [...issues.values()].find((i) => i.external_id === parsed.searchParams.get("external_id") && i.external_source === parsed.searchParams.get("external_source"));
        return existing ? json(200, existing) : json(404, { error: "Not found" });
      }
      if (method === "GET" && /\/comments\/$/.test(path)) return json(200, { results: comments.get(path) ?? [], next_page_results: false });
      if (method === "GET") return json(200, { results: [], next_page_results: false });
      if (method === "POST" && /\/work-items\/$/.test(path)) {
        const id = `partner-${++objectId}`;
        const issue = { id, ...body };
        createdIssueIds.push(id); issues.set(id, issue);
        return json(201, issue);
      }
      if (method === "POST" && /\/comments\/$/.test(path)) {
        const comment = { id: `comment-${++objectId}`, ...body };
        comments.set(path, [...comments.get(path) ?? [], comment]);
        return json(201, comment);
      }
      return json(200, { id: `object-${++objectId}` });
    }) as typeof fetch });
  const ghClient = { installationIdFor: async () => 1, installationOctokit: async () => ({
    request: async (route: string, params: any) => {
      githubCalls.push({ route, params });
      return { data: route.startsWith("GET") ? { id: 1, email: null } : { id: ++objectId, number: 100 + objectId } };
    },
  }) };
  const tokenKey = randomBytes(32);
  const rawContext: AppContext = {
    db, planeClient, ghClient, plane: new PlaneWritePath({ client: planeClient, db }),
    github: new GithubWritePath({ app: ghClient, db }), vault: createVault(db, tokenKey),
    config: { PORT: 0, HOST: "127.0.0.1", DATABASE_URL: "", REDIS_URL: "", QUEUE_PREFIX: "test",
      PLANE_BASE_URL: "http://plane.test", PLANE_SERVICE_PAT: "service-pat", PLANE_SERVICE_USER_ID: "service-user",
      PLANE_WEBHOOK_SECRET: "plane-secret", GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY_PATH: "/unused",
      GITHUB_WEBHOOK_SECRET: "github-secret", GITSYNC_TOKEN_KEY: tokenKey.toString("base64"), PUBLIC_ORIGIN: "https://tasks.example", REQUIRE_VERIFIED_COMMITS: false },
  };
  const h = { db, ctx: rawContext, plane: { createdIssueIds, writes: () => planeCalls.filter((c) => c.method !== "GET") },
    gh: { writes: () => githubCalls.filter((c) => !c.route.startsWith("GET")) } };
  const ctx = { ...rawContext };
  const outbox = createOrderedOutbox({ db: h.db, plane: h.ctx.plane as any, github: h.ctx.github as any,
    queues: { plane: queue() as any, github: queue() as any }, loadActorToken: async () => null,
    resumeReducer: (request) => request.kind === "mirror_pending"
      ? handlePendingMirroredIssue(ctx, request) : handleMirroredIssue(ctx, request) });
  ctx.plane = outbox.plane; ctx.github = outbox.github;
  const feed = (job: InboundJob) => deliveryScope.run({ deliveryId: `${job.source}-${job.deliveryId}`, workspaceSlug: "ws" },
    () => job.source === "github" ? handleGithubIssue(ctx, job) : handlePlaneIssue(ctx, job));
  const drain = async () => {
    for (let n = 0; n < 40; n++) {
      const row = (await h.db.query<{ id: string; side: string }>(
        "SELECT id, side FROM outbound_writes WHERE status = 'pending' ORDER BY sequence LIMIT 1")).rows[0];
      if (!row) return;
      const wake = await intentJob(h.db, row.id);
      try {
        if (row.side === "plane") await outbox.executePlane(wake); else await outbox.executeGithub(wake);
      } catch (error) {
        const stored = (await h.db.query("SELECT status, error FROM outbound_writes WHERE id = $1", [row.id])).rows[0];
        throw new Error(`mirror step ${row.id}: ${JSON.stringify(stored)}`, { cause: error });
      }
    }
    throw new Error("mirror plan did not finish within 40 steps");
  };
  const deps: MirrorDeps = { db: h.db, plane: outbox.plane, github: outbox.github,
    mapping: { id: mappingId, workspaceSlug: "ws", planeProjectId: "p-qll", ghRepoId: 555,
      syncDirection: "bidirectional", installationId: 1, owner: "acme", repo: "web" },
    users: { planeUserIdForGithubLogin: async () => { throw new Error("assignee lookup must never use a login"); } } };
  return { h, ctx, outbox, feed, drain, deps };
}

const optIn = () => ghJob("issues", { action: "labeled", label: { name: "plane" },
  issue: { number: 41, title: "Mirror me", state: "open", labels: [{ name: "plane" }], assignees: [] } });
const planeOptIn = () => planeJob("issue", { action: "updated",
  data: { id: "iss-1", project: "p-qll", name: "Mirror me", labels: [LABELS[0]] },
  activity: { field: "labels", old_value: [], new_value: [LABELS[0]!.id] } });

test("F4: orphan then GitHub re-label creates a new partner and runs its rule exactly once for each generation", async (t) => {
  const { h, feed, drain } = await fixture(t);
  const first = optIn();
  await feed(first); await drain();
  strictEqual(h.plane.createdIssueIds.length, 1);
  for (let generation = 0; generation < 2; generation++) {
    await h.db.query("UPDATE sync_links SET status = 'orphaned', orphaned_at = now() WHERE status = 'active'");
    const relabel = optIn();
    await feed(relabel); await drain();
    strictEqual(h.plane.createdIssueIds.length, generation + 2);
    strictEqual(h.plane.writes().filter((w) => w.body?.comment_html?.includes("recreated-partner-rule")).length, generation + 2);
    await feed(relabel); await drain();
    strictEqual(h.plane.createdIssueIds.length, generation + 2, "redelivery must not create a further generation");
    strictEqual(h.plane.writes().filter((w) => w.body?.comment_html?.includes("recreated-partner-rule")).length, generation + 2);
  }
  strictEqual((await h.db.query("SELECT 1 FROM sync_links WHERE status = 'active'")).rows.length, 1);
  strictEqual((await h.db.query("SELECT 1 FROM pending_sync_links")).rows.length, 0);
});

test("F4: orphan then Plane re-opt-in creates a new GitHub partner without duplicating it on redelivery", async (t) => {
  const { h, feed, drain } = await fixture(t);
  await feed(planeOptIn()); await drain();
  strictEqual(h.gh.writes().filter((w) => w.route === "POST /repos/{owner}/{repo}/issues").length, 1);
  await h.db.query("UPDATE sync_links SET status = 'orphaned', orphaned_at = now()");
  const relabel = planeOptIn();
  await feed(relabel); await drain();
  await feed(relabel); await drain();
  strictEqual(h.gh.writes().filter((w) => w.route === "POST /repos/{owner}/{repo}/issues").length, 2);
  strictEqual((await h.db.query("SELECT 1 FROM sync_links WHERE status = 'active'")).rows.length, 1);
});

test("F4: re-opt-in after retention prunes a finished root does not collide with its retained steps", async (t) => {
  const { h, feed, drain } = await fixture(t);
  await feed(optIn()); await drain();
  await h.db.query("UPDATE sync_links SET status = 'orphaned', orphaned_at = now()");
  await h.db.query("DELETE FROM outbound_writes WHERE id = (SELECT id FROM outbound_writes ORDER BY sequence LIMIT 1)");
  ok((await h.db.query("SELECT 1 FROM outbound_writes WHERE write->'_plan'->'after' @> '[{\"kind\":\"clear_pending_link\"}]'::jsonb")).rows.length);
  await feed(optIn()); await drain();
  strictEqual(h.plane.createdIssueIds.length, 2);
  strictEqual(h.plane.writes().filter((w) => w.body?.comment_html?.includes("recreated-partner-rule")).length, 2);
});

test("F4: a failed create generation can be re-opted in and its new continuation runs once", async (t) => {
  const { h, feed, drain } = await fixture(t);
  await feed(optIn());
  // The terminal failure cleanup belongs to CB; reproduce its persisted end state here.
  await h.db.query("UPDATE outbound_writes SET status = 'failed', error = '{\"message\":\"create rejected\"}'::jsonb");
  await h.db.query("DELETE FROM pending_sync_links");
  await feed(optIn()); await drain();
  strictEqual(h.plane.createdIssueIds.length, 1);
  strictEqual(h.plane.writes().filter((w) => w.body?.comment_html?.includes("recreated-partner-rule")).length, 1);
});

test("F4: a duplicate create-plan registration does not report creation or suppress the inbound rule path", async (t) => {
  const { h, ctx, deps, feed, drain } = await fixture(t);
  const plan = async () => ({ ok: true as const, inserted: false });
  deps.plane = { ...deps.plane, plan };
  deps.github = { ...deps.github, plan };
  strictEqual((await onGithubIssue(optIn().payload, deps)).action, "ignored");
  const job = planeOptIn();
  strictEqual((await onPlaneIssue({ event: job.event, payload: job.payload }, deps)).action, "ignored");
  // Another worker linked the item between the reducer's lookup and duplicate registration.
  ctx.plane = { ...ctx.plane, plan: async () => {
    await upsertSyncLink(h.db, { planeWorkspaceSlug: "ws", planeProjectId: "p-qll", planeIssueId: "iss-1",
      ghRepoId: 555, ghNumber: 41, ghKind: "issue", tier: "relation", createdBy: "label_sync" });
    return { ok: true, inserted: false };
  } };
  await feed(optIn()); await drain();
  strictEqual(h.plane.createdIssueIds.length, 0);
  strictEqual(h.plane.writes().filter((w) => w.body?.comment_html?.includes("recreated-partner-rule")).length, 1);
});

test("F4/F2: a stale marker from a failed plan does not defer an edit into that failed group", async (t) => {
  const { h, deps } = await fixture(t);
  const initial = optIn();
  deps.createContinuation = { job: initial };
  strictEqual((await onGithubIssue(initial.payload, deps)).action, "created");
  const root = (await h.db.query<{ outbox_id: string }>("SELECT outbox_id FROM pending_sync_links")).rows[0]!.outbox_id;
  await h.db.query("UPDATE outbound_writes SET status = 'failed' WHERE id = $1", [root]);
  const edit = ghJob("issues", { action: "edited", changes: { title: {} },
    issue: { number: 41, title: "New title", labels: [{ name: "plane" }] } });
  deps.createContinuation = { job: edit };
  strictEqual((await onGithubIssue(edit.payload, deps)).action, "ignored");
  strictEqual((await h.db.query("SELECT 1 FROM outbound_writes WHERE write->'continuation'->>'kind' = 'mirror_pending'")).rows.length, 0);
});

test("F4: duplicate pending continuation registration does not claim the continuation was inserted", async (t) => {
  const { deps } = await fixture(t);
  const initial = optIn();
  deps.createContinuation = { job: initial };
  await onGithubIssue(initial.payload, deps);
  let attempted = false;
  deps.plane = { ...deps.plane, plan: async () => { attempted = true; return { ok: true, inserted: false }; } };
  const edit = ghJob("issues", { action: "edited", changes: { title: {} }, issue: { number: 41, title: "New title" } });
  deps.createContinuation = { job: edit };
  strictEqual((await onGithubIssue(edit.payload, deps)).action, "ignored");
  ok(attempted);
});

test("F4: legacy plan acknowledgments without inserted still own the create and pending-event continuations", async (t) => {
  const { deps } = await fixture(t);
  const realPlane = deps.plane;
  const legacyPlan = async () => ({ ok: true as const });
  deps.plane = { ...deps.plane, plan: legacyPlan };
  deps.github = { ...deps.github, plan: legacyPlan };
  strictEqual((await onGithubIssue(optIn().payload, deps)).action, "created");
  const plane = planeOptIn();
  strictEqual((await onPlaneIssue({ event: plane.event, payload: plane.payload }, deps)).action, "created");
  deps.plane = realPlane;
  const initial = optIn();
  deps.createContinuation = { job: initial };
  await onGithubIssue(initial.payload, deps);
  deps.plane = { ...realPlane, plan: legacyPlan };
  const edit = ghJob("issues", { action: "edited", issue: { number: 41, title: "Updated" }, changes: { title: {} } });
  deps.createContinuation = { job: edit };
  strictEqual((await onGithubIssue(edit.payload, deps)).action, "deferred");
});

test("F4: a live marker prevents a second create, and the next generation retains that object's marker key", async (t) => {
  const { h, deps, drain } = await fixture(t);
  strictEqual((await onGithubIssue(optIn().payload, deps)).action, "created");
  const first = (await h.db.query<{ key: string; outbox_id: string }>("SELECT key, outbox_id FROM pending_sync_links")).rows[0]!;
  const count = (await h.db.query("SELECT 1 FROM outbound_writes")).rows.length;
  strictEqual((await onGithubIssue(optIn().payload, deps)).action, "ignored");
  strictEqual((await h.db.query("SELECT 1 FROM outbound_writes")).rows.length, count);
  await drain();
  await h.db.query("UPDATE sync_links SET status = 'orphaned', orphaned_at = now()");
  strictEqual((await onGithubIssue(optIn().payload, deps)).action, "created");
  const next = (await h.db.query<{ key: string; outbox_id: string }>("SELECT key, outbox_id FROM pending_sync_links")).rows[0]!;
  strictEqual(next.key, first.key);
  ok(next.outbox_id !== first.outbox_id);
});

test("prev F5: create assignees resolve by GitHub ID despite rename, login reuse, duplicates or another workspace", async (t) => {
  const { h, deps, drain } = await fixture(t);
  await h.db.query(`INSERT INTO user_map (workspace_slug, plane_user_id, gh_login, gh_id) VALUES
    ('ws', 'user-original', 'old-login', 101), ('other', 'user-other', 'other-login', 202)`);
  const job = optIn();
  const payload = job.payload as any;
  payload.issue.assignees = [{ id: 101, login: "renamed" }, { id: 303, login: "old-login" },
    { id: 202, login: "other-login" }, { id: 101, login: "renamed" }, { login: "old-login" }];
  strictEqual((await onGithubIssue(payload, deps)).action, "created");
  await drain();
  const create = h.plane.writes().find((w) => w.method === "POST" && /\/work-items\/$/.test(w.path));
  ok(create);
  deepStrictEqual(create.body.assignees, ["user-original"]);
});

test("prev F5: assignment and unassignment use GitHub IDs and clear unmapped or invalid assignees", async (t) => {
  const { h, deps } = await fixture(t);
  deps.plane = h.ctx.plane;
  await upsertSyncLink(h.db, { planeWorkspaceSlug: "ws", planeProjectId: "p-qll", planeIssueId: "iss-1",
    ghRepoId: 555, ghNumber: 41, ghKind: "issue", tier: "relation", createdBy: "label_sync" });
  await h.db.query("INSERT INTO user_map (workspace_slug, plane_user_id, gh_login, gh_id) VALUES ('ws', 'user-original', 'old-login', 101)");
  const issue = { number: 41, assignees: [{ id: 101, login: "renamed" }, { id: 303, login: "old-login" }] };
  strictEqual((await onGithubIssue({ action: "assigned", issue }, deps)).action, "updated");
  await onGithubIssue({ action: "unassigned", issue: { ...issue, assignees: [
    { id: 303, login: "old-login" }, { login: "old-login" }, { id: "101", login: "old-login" }, { id: 0 }, { id: -1 }, { id: Number.MAX_SAFE_INTEGER + 1 },
  ] } }, deps);
  deepStrictEqual(h.plane.writes().filter((w) => w.method === "PATCH").map((w) => w.body.assignees), [["user-original"], []]);
});
