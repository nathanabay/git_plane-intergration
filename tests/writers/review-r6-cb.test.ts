import test from "node:test";
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { createOrderedOutbox, deliveryScope } from "../../src/app/writers.ts";
import { createOutboundAuthoriser, freezeMappingAuthority, mappingsForRepo } from "../../src/app/mappings.ts";
import { processPush, SmartCommitRetry } from "../../src/github/smart-commits.ts";
import type { SmartCommitDeps } from "../../src/github/smart-commits.ts";
import type { OutboxPlanStep, WriteAuthority } from "../../src/operations/plans.ts";
import { resultRef } from "../../src/operations/plans.ts";
import { PlaneApiError } from "../../src/sync/plane.ts";
import { ghJob, makeHarness, prPayload, sha } from "../a8/harness.ts";
import { intentJob, queue } from "./outbox-fixture.ts";
import type { Db } from "../../src/db/migrate.ts";

test("F2: actual push executes its first Smart Commit before the SHA claim and retains a later transient lookup", async (t) => {
  const h = await makeHarness(); t.after(() => h.close()); await h.mapping({ rules: "[]" });
  const source = freezeMappingAuthority((await mappingsForRepo(h.db, 555))[0]!);
  const applied: any[] = [];
  const outbox = createOrderedOutbox({ db: h.db, authoriseWrite: createOutboundAuthoriser(h.db),
    queues: { plane: queue() as any, github: queue() as any }, loadActorToken: async () => null,
    plane: { preflight: async () => {}, apply: async (write) => { applied.push(write); return { ok: true }; } },
    github: { apply: async () => ({ ok: true }) } });
  h.ctx.plane = outbox.plane;
  let lookupFailed = false;
  h.ctx.planeClient.getIssueByIdentifier = async (_slug, key) => {
    if (key === "QLL-2" && !lookupFailed) {
      lookupFailed = true;
      strictEqual((await h.db.query("SELECT 1 FROM processed_commits")).rows.length, 0);
      const job = await intentJob(h.db);
      deepStrictEqual((job.data as any)._authority, source);
      await outbox.executePlane(job);
      strictEqual((await h.db.query("SELECT 1 FROM processed_commits")).rows.length, 0);
      throw new PlaneApiError(503, {}, "later lookup unavailable");
    }
    // Both targets can be outside the source mapping's default project.
    return { project: "different-project", id: key };
  };
  const originalJob = ghJob("push", { ref: "refs/heads/main",
    commits: [{ id: sha("a"), message: "QLL-1 #comment one\nQLL-2 #comment two" }] }, "interleaved");
  const run = () => h.feed(originalJob);
  await rejects(run(), SmartCommitRetry);
  strictEqual(applied.length, 1);
  strictEqual((await h.db.query("SELECT 1 FROM processed_commits")).rows.length, 0);
  strictEqual((await h.db.query("SELECT 1 FROM outbound_writes WHERE status = 'failed'")).rows.length, 0);
  const original = (await h.db.query<{ id: string }>("SELECT id FROM outbound_writes")).rows[0]!.id;
  await run();
  const rows = (await h.db.query<{ id: string; status: string; write: any }>("SELECT id,status,write FROM outbound_writes ORDER BY sequence")).rows;
  strictEqual(rows.length, 2); strictEqual(rows[0]!.id, original); strictEqual(rows[0]!.status, "applied");
  for (const row of rows) deepStrictEqual(row.write._authority, source);
  await outbox.executePlane(await intentJob(h.db, rows[1]!.id));
  await run();
  deepStrictEqual(applied.map((w) => w.issueId), ["QLL-1", "QLL-2"]);
  ok(applied.every((w) => !("_authority" in w)), "admission metadata never reaches the remote API");
  strictEqual((await h.db.query("SELECT 1 FROM processed_commits")).rows.length, 1);
});

test("F2: re-registration preserves the original authority and a different current mapping cannot rescue it", async (t) => {
  const h = await makeHarness(); t.after(() => h.close()); await h.mapping(); await h.mapping({ repoId: 556, installationId: 2 });
  const source = freezeMappingAuthority((await mappingsForRepo(h.db, 555))[0]!);
  const other = freezeMappingAuthority((await mappingsForRepo(h.db, 556))[0]!);
  let effects = 0;
  const outbox = createOrderedOutbox({ db: h.db, authoriseWrite: createOutboundAuthoriser(h.db),
    queues: { plane: queue() as any, github: queue() as any }, loadActorToken: async () => null,
    plane: { preflight: async () => {}, apply: async () => { effects++; return { ok: true }; } }, github: { apply: async () => ({ ok: true }) } });
  const write = { kind: "update_issue" as const, slug: "ws", projectId: "p-qll", issueId: "i", fields: { name: "private" } };
  const mutable = { ...source };
  await deliveryScope.run({ deliveryId: "github-frozen", authority: mutable }, () => outbox.plane.apply(write));
  const first = await intentJob(h.db);
  mutable.mappingId = other.mappingId; mutable.repoId = other.repoId; mutable.installationId = other.installationId;
  await deliveryScope.run({ deliveryId: "github-frozen", authority: other }, () => outbox.plane.apply(write));
  strictEqual((await h.db.query("SELECT 1 FROM outbound_writes")).rows.length, 1);
  deepStrictEqual((await intentJob(h.db, first.id)).data._authority, source);
  await h.db.query("DELETE FROM repo_mappings WHERE id = $1", [source.mappingId]);
  await rejects(outbox.executePlane(first), /authority is missing or revoked/);
  strictEqual(effects, 0);
  await rejects(outbox.retryFailed(first.id!, "ws"), /authority is missing or revoked/);
  await rejects(deliveryScope.run({ deliveryId: "github-frozen", authority: other,
    writeDeliveryId: "frozen", transportDeliveryId: "replay" }, () => outbox.plane.apply(write)), /authority is missing or revoked/);
  deepStrictEqual((await intentJob(h.db, first.id)).data._authority, source);
  strictEqual((await h.db.query("SELECT 1 FROM outbound_writes")).rows.length, 1);
});

test("F2: frozen plan authority covers both queues, inherited groups and nested resumed writes", async (t) => {
  const h = await makeHarness(); t.after(() => h.close()); await h.mapping();
  const source = freezeMappingAuthority((await mappingsForRepo(h.db, 555))[0]!);
  const effects: any[] = [];
  let resumed = 0;
  const outbox = createOrderedOutbox({ db: h.db, authoriseWrite: createOutboundAuthoriser(h.db),
    queues: { plane: queue() as any, github: queue() as any }, loadActorToken: async () => null,
    plane: { preflight: async () => {}, apply: async (write) => { effects.push(write); return { ok: true, id: "new-issue" }; } },
    github: { apply: async (write) => { effects.push(write); return { ok: true }; } },
    resumeReducer: async (request) => {
      resumed++; deepStrictEqual(request.authority, source);
      await outbox.plane.apply({ kind: "add_comment", slug: "ws", projectId: "p-qll", issueId: request.issueId,
        commentHtml: "nested", _authority: request.authority } as any);
    } });
  const steps: OutboxPlanStep[] = [
    { kind: "write", side: "plane", bind: "created", write: { kind: "create_issue", slug: "ws", projectId: "p-qll", fields: { name: "new" } } },
    { kind: "write", side: "github", write: { kind: "comment", installationId: 1, repoId: 555, owner: "acme", repo: "web", number: 12, body: "linked" } },
    { kind: "write", side: "github", write: { kind: "resume_reducer", continuation: { kind: "pr_created", workspaceSlug: "ws",
      mappingId: Number(source.mappingId), job: ghJob("pull_request", {}), projectId: "p-qll", issueId: resultRef("created.id"), identifier: "QLL" } } },
  ];
  const register = (authority: WriteAuthority) => deliveryScope.run({ deliveryId: "github-plan" }, () => outbox.plane.plan(undefined, steps, { authority }));
  await register(source);
  const rows = (await h.db.query<{ id: string; side: string; write: any }>("SELECT id,side,write FROM outbound_writes ORDER BY sequence")).rows;
  const changed = { ...source, mappingId: "999" };
  await register(changed);
  strictEqual((await h.db.query("SELECT 1 FROM outbound_writes")).rows.length, 3);
  for (const row of rows) deepStrictEqual(row.write._authority, source);
  await outbox.plane.plan("group-event", [{ kind: "write", side: "plane", write: {
    kind: "update_issue", slug: "ws", projectId: "p-qll", issueId: "new-issue", fields: { name: "later" },
  } }], { groupRoot: rows[0]!.id, predecessor: rows[2]!.id });
  const group = await intentJob(h.db);
  deepStrictEqual(group.data._authority, source);
  for (const row of rows) {
    const job = await intentJob(h.db, row.id);
    if (row.side === "plane") await outbox.executePlane(job); else await outbox.executeGithub(job);
  }
  await outbox.executePlane(group);
  const nested = await intentJob(h.db);
  deepStrictEqual(nested.data._authority, source);
  await outbox.executePlane(nested);
  strictEqual(resumed, 1);
  ok(effects.every((w) => !("_authority" in w)));
});

test("F2: Smart Commit source mismatches fail before admission and do not claim the SHA", async (t) => {
  const h = await makeHarness(); t.after(() => h.close()); await h.mapping();
  const source = freezeMappingAuthority((await mappingsForRepo(h.db, 555))[0]!);
  let registrations = 0;
  const deps: SmartCommitDeps = { db: h.db, authority: source, mapping: { workspaceSlug: "ws", smartCommitsEnabled: true },
    writer: { apply: async () => { registrations++; return { ok: true }; } }, requireVerified: false,
    users: { planeUserIdForGithubLogin: async () => null }, vault: { load: async () => null },
    listStates: async () => [], resolveIssue: async () => ({ projectId: "p", issueId: "i" }), getCommitVerified: async () => true };
  const payload = { repository: { id: 556 }, commits: [{ id: sha("b"), message: "QLL-1 #comment private" }] };
  await rejects(processPush(payload, deps), /source does not match/);
  await rejects(processPush({ ...payload, repository: { id: 555 } }, { ...deps, authority: { ...source, workspaceSlug: "other" } }), /source does not match/);
  strictEqual(registrations, 0);
  strictEqual((await h.db.query("SELECT 1 FROM processed_commits")).rows.length, 0);
});

test("F2: named label plans ignore admission metadata in target identity and keep the original authority", async (t) => {
  const h = await makeHarness(); t.after(() => h.close()); await h.mapping();
  const source = freezeMappingAuthority((await mappingsForRepo(h.db, 555))[0]!);
  const applied: any[] = [];
  const outbox = createOrderedOutbox({ db: h.db, authoriseWrite: createOutboundAuthoriser(h.db),
    queues: { plane: queue() as any, github: queue() as any }, loadActorToken: async () => null,
    readPlaneIssueFields: async () => ({ labels: [], assignees: [] }),
    plane: { preflight: async () => {}, apply: async (write) => { applied.push(write); return { ok: true, id: "label" }; } },
    github: { apply: async () => ({ ok: true }) } });
  const run = (authority: WriteAuthority) => deliveryScope.run({ deliveryId: "named-label", authority }, () => {
    const target = { slug: "ws", projectId: "p-qll", issueId: "i", _authority: authority };
    return outbox.plane.mutateIssue(target, { kind: "add_label", name: "help" });
  });
  await run(source);
  const original = (await h.db.query<{ id: string; write: any }>("SELECT id,write FROM outbound_writes ORDER BY sequence")).rows;
  await run({ ...source, mappingId: "999" });
  const after = (await h.db.query<{ id: string; write: any }>("SELECT id,write FROM outbound_writes ORDER BY sequence")).rows;
  deepStrictEqual(after, original); strictEqual(after.length, 2);
  for (const row of after) {
    deepStrictEqual(row.write._authority, source);
    await outbox.executePlane(await intentJob(h.db, row.id));
  }
  strictEqual(applied[0].kind, "upsert_label");
  deepStrictEqual(applied[1].fields.labels, ["label"]);
});

test("F3: two project mappings in one workspace infer one owner and dispatch an actual PR linkback", async (t) => {
  const h = await makeHarness(); t.after(() => h.close());
  await h.mapping({ projectId: "p-qll", linkback: true, rules: "[]", smartCommits: false });
  await h.mapping({ projectId: "p-web", linkback: true, rules: "[]", smartCommits: false });
  const plane = h.ctx.plane;
  const comments: any[] = [];
  const outbox = createOrderedOutbox({ db: h.db, authoriseWrite: createOutboundAuthoriser(h.db),
    queues: { plane: queue() as any, github: queue() as any }, loadActorToken: async () => null,
    plane: { preflight: async () => {}, apply: (write, opts) => plane.apply(write, opts) },
    github: { apply: async (write) => { comments.push(write); return { ok: true }; } } });
  // No caller workspace: the fallback must count distinct authorized workspaces rather than project rows.
  await outbox.github.apply({ kind: "comment", repoId: 555, installationId: 1, owner: "acme", repo: "web", number: 13, body: "inferred" });
  const inferred = await intentJob(h.db);
  strictEqual(inferred.data._gitsync.workspaceSlug, "ws");
  await outbox.executeGithub(inferred);
  h.ctx.plane = outbox.plane; h.ctx.github = outbox.github;
  await h.feed(ghJob("pull_request", prPayload("opened", {}, { body: "Relates to QLL-1", html_url: "https://github.com/acme/web/pull/12" })));
  for (let i = 0; i < 10; i++) {
    const row = (await h.db.query<{ id: string; side: string }>("SELECT id,side FROM outbound_writes WHERE status = 'pending' ORDER BY sequence LIMIT 1")).rows[0];
    if (!row) break;
    const job = await intentJob(h.db, row.id);
    if (row.side === "plane") await outbox.executePlane(job); else await outbox.executeGithub(job);
  }
  strictEqual(comments.filter((w) => w.kind === "comment" && w.number === 12 && /Linked Plane/.test(w.body)).length, 1);
  strictEqual((await h.db.query("SELECT 1 FROM outbound_writes WHERE workspace_slug IS NULL OR status <> 'applied'")).rows.length, 0);
  strictEqual((await h.db.query("SELECT 1 FROM sync_links WHERE gh_number = 12 AND status = 'active'")).rows.length, 1);
});

test("F3: unknown or multiple distinct workspace results stay unresolved even if mappings later change", async (t) => {
  const h = await makeHarness(); t.after(() => h.close());
  const db: Db = { exec: h.db.exec.bind(h.db), query: async <T>(sql: string, params?: any[]) => {
    if (sql.includes("SELECT DISTINCT rm.workspace_slug")) return { rows: [{ workspace_slug: "one" }, { workspace_slug: "two" }] as T[] };
    return h.db.query<T>(sql, params);
  } };
  let effects = 0;
  const outbox = createOrderedOutbox({ db, authoriseWrite: createOutboundAuthoriser(h.db),
    queues: { plane: queue() as any, github: queue() as any }, loadActorToken: async () => null,
    plane: { preflight: async () => {}, apply: async () => ({ ok: true }) }, github: { apply: async () => { effects++; return { ok: true }; } } });
  await outbox.github.apply({ kind: "comment", repoId: 555, installationId: 1, owner: "acme", repo: "web", number: 12, body: "ambiguous" });
  const ambiguous = await intentJob(h.db);
  strictEqual(ambiguous.data._gitsync.workspaceSlug, undefined);
  await h.mapping();
  await rejects(outbox.executeGithub(ambiguous), /authority is missing or revoked/);
  const unknown = createOrderedOutbox({ db: h.db, authoriseWrite: createOutboundAuthoriser(h.db),
    queues: { plane: queue() as any, github: queue() as any }, loadActorToken: async () => null,
    plane: { preflight: async () => {}, apply: async () => ({ ok: true }) }, github: { apply: async () => { effects++; return { ok: true }; } } });
  await unknown.github.apply({ kind: "comment", repoId: 999, installationId: 1, owner: "acme", repo: "web", number: 12, body: "unknown" });
  const missing = await intentJob(h.db);
  strictEqual(missing.data._gitsync.workspaceSlug, undefined);
  await h.mapping({ repoId: 999 });
  await rejects(unknown.executeGithub(missing), /authority is missing or revoked/);
  strictEqual(effects, 0);
});

test("F5 seam: later continuations are retained as failed and run once in order only after explicit repair", async (t) => {
  const h = await makeHarness(); t.after(() => h.close()); await h.mapping();
  const source = freezeMappingAuthority((await mappingsForRepo(h.db, 555))[0]!);
  const planeQueue = queue();
  let healthy = false, creates = 0;
  const resumed: string[] = [];
  const outbox = createOrderedOutbox({ db: h.db, authoriseWrite: createOutboundAuthoriser(h.db),
    queues: { plane: planeQueue as any, github: queue() as any }, loadActorToken: async () => null,
    plane: { preflight: async () => {}, apply: async () => {
      if (!healthy) throw new PlaneApiError(403, {}, "create refused");
      creates++; return { ok: true, id: "created" };
    } }, github: { apply: async () => ({ ok: true }) },
    resumeReducer: async (request) => { resumed.push((request.job.payload as any).action); } });
  const resume = (action: string): OutboxPlanStep => ({ kind: "write", side: "plane", write: { kind: "resume_reducer", continuation: {
    kind: "pr_created", workspaceSlug: "ws", mappingId: Number(source.mappingId), job: ghJob("pull_request", { action }),
    projectId: "p-qll", issueId: resultRef("created.id"), identifier: action,
  } } });
  const key = "failed-create";
  const pendingLink = { planeWorkspaceSlug: "ws", planeProjectId: "p-qll", ghRepoId: 555, ghNumber: 12, ghKind: "pr" };
  await outbox.plane.plan(key, [
    { kind: "write", side: "plane", bind: "created", write: { kind: "create_issue", slug: "ws", projectId: "p-qll", fields: { name: "new" } } },
    resume("opened"),
  ], { authority: source, pendingLink });
  const original = (await h.db.query<{ id: string }>("SELECT id FROM outbound_writes ORDER BY sequence")).rows;
  const root = original[0]!.id;
  await rejects(outbox.executePlane(await intentJob(h.db, root)), /create refused/);
  let predecessor = original[1]!.id;
  for (const action of ["approved", "merged"]) {
    const opts = { authority: source, groupRoot: root, bindings: { created: root }, predecessor,
      pendingMarker: { key, root, link: pendingLink }, holdOnFailure: true };
    strictEqual((await outbox.plane.plan(`event-${action}`, [resume(action)], opts)).inserted, true);
    strictEqual((await outbox.plane.plan(`event-${action}`, [resume(action)], opts)).inserted, false);
    predecessor = (await intentJob(h.db)).id;
  }
  const retained = (await h.db.query<{ id: string; status: string; write: any }>("SELECT id,status,write FROM outbound_writes ORDER BY sequence")).rows;
  deepStrictEqual(retained.map((r) => r.status), ["failed", "failed", "failed", "failed"]);
  for (const row of retained) deepStrictEqual(row.write._authority, source);
  strictEqual((await h.db.query("SELECT 1 FROM pending_sync_links")).rows.length, 0);
  strictEqual(planeQueue.jobs.size, 1);
  deepStrictEqual(resumed, []); strictEqual(creates, 0);
  healthy = true;
  await outbox.retryFailed(root, "ws");
  for (const row of retained) await outbox.executePlane(await intentJob(h.db, row.id));
  deepStrictEqual(resumed, ["opened", "approved", "merged"]); strictEqual(creates, 1);
  strictEqual((await outbox.retryFailed(root, "ws")).retried, false);
  for (const row of retained) await outbox.executePlane(await intentJob(h.db, row.id));
  deepStrictEqual(resumed, ["opened", "approved", "merged"]); strictEqual(creates, 1);
});
