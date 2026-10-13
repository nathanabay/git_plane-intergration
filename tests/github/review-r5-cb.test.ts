import test from "node:test";
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { createOrderedOutbox, deliveryScope } from "../../src/app/writers.ts";
import { createRouter, inboundHandler } from "../../src/app/reducers.ts";
import { replayDelivery } from "../../src/operations/tooling.ts";
import { PlaneApiError } from "../../src/sync/plane.ts";
import { failedWriteId } from "../../src/ui/client/http.ts";
import { checkPrReadiness } from "../../src/github/pr-automation.ts";
import { createOutboundAuthoriser } from "../../src/app/mappings.ts";
import { ghJob, makeHarness, sha } from "../a8/harness.ts";
import { intentJob, queue } from "../writers/outbox-fixture.ts";
import { ADM, MEM, setup } from "../ui/harness.ts";

test("F9: real push reducer replay revives a claimed SHA's failed comment and preserves its successful transition", async (t) => {
  const h = await makeHarness(); t.after(() => h.close());
  await h.mapping();
  let fail = true;
  const applied: string[] = [];
  const outbox = createOrderedOutbox({ db: h.db, queues: { plane: queue() as any, github: queue() as any },
    loadActorToken: async () => null, github: { apply: async () => ({ ok: true }) },
    plane: { preflight: async () => {}, apply: async (w) => {
      if (w.kind === "add_comment" && fail) throw new PlaneApiError(422, {}, "comment refused");
      applied.push(w.kind); return { ok: true };
    } } });
  h.ctx.plane = outbox.plane;
  const run = inboundHandler(h.ctx, createRouter(h.ctx), "github");
  const original = ghJob("push", { ref: "refs/heads/main", commits: [{ id: sha("a"), message: "QLL-1 #done #comment shipped" }] }, "original");
  await run(original);
  const rows = (await h.db.query<{ id: string }>("SELECT id FROM outbound_writes ORDER BY sequence")).rows;
  strictEqual(rows.length, 2);
  deepStrictEqual((await h.audit("smart_commit_step")).map((r) => r.outcome), ["registered", "registered"]);
  strictEqual((await h.audit("smart_commit"))[0].outcome, "registered");
  await outbox.executePlane(await intentJob(h.db, rows[0]!.id));
  await rejects(outbox.executePlane(await intentJob(h.db, rows[1]!.id)), /comment refused/);
  deepStrictEqual(applied, ["update_issue"]);
  strictEqual((await h.db.query("SELECT 1 FROM processed_commits")).rows.length, 1);
  await outbox.plane.reviveSmartCommit(sha("f"), "ws", "github-original");
  await outbox.plane.reviveSmartCommit(sha("a"), "other", "github-original");
  strictEqual((await h.db.query<{ status: string }>("SELECT status FROM outbound_writes WHERE id = $1", [rows[1]!.id])).rows[0]!.status, "failed");
  // A fresh push/fork is still once-only and must not revive the failed write implicitly.
  await run({ ...original, deliveryId: "fresh-fork", payload: { ...original.payload as object, repository: { id: 555, full_name: "fork/web" } } });
  strictEqual((await h.db.query<{ status: string }>("SELECT status FROM outbound_writes WHERE id = $1", [rows[1]!.id])).rows[0]!.status, "failed");
  const delivery = (await h.db.query<{ id: number }>("SELECT id FROM audit_log WHERE kind = 'inbound_delivery' AND delivery_id = 'original' LIMIT 1")).rows[0];
  // handlePush's production wrapper doesn't add inbound_delivery; exercise the real replay tooling with its stored job.
  const { appendAudit } = await import("../../src/db/ledgers.ts");
  const auditId = delivery?.id ?? Number(await appendAudit(h.db, { kind: "inbound_delivery", source: "github", workspaceSlug: "ws", deliveryId: original.deliveryId,
    detail: { event: original.event, payload: original.payload }, outcome: "handled" }));
  const replayed: any[] = [];
  await replayDelivery({ db: h.db, enqueue: async (job) => { replayed.push(job); } }, auditId);
  await run(replayed[0]);
  strictEqual((await h.db.query<{ status: string }>("SELECT status FROM outbound_writes WHERE id = $1", [rows[1]!.id])).rows[0]!.status, "pending");
  fail = false;
  await outbox.executePlane(await intentJob(h.db, rows[1]!.id));
  await run({ ...replayed[0], deliveryId: "replay-again" });
  deepStrictEqual(applied, ["update_issue", "add_comment"]);
  strictEqual((await h.db.query("SELECT 1 FROM outbound_writes")).rows.length, 2);
  deepStrictEqual((await h.audit("smart_commit_step_executed")).map((r) => r.outcome), ["applied", "applied"]);
  strictEqual((await h.audit("outbound_write_retry")).length, 1);
});

test("F9: pre-round-5 untagged Smart Commit intents recover through original delivery ownership", async (t) => {
  const h = await makeHarness(); t.after(() => h.close()); await h.mapping();
  const outbox = createOrderedOutbox({ db: h.db, queues: { plane: queue() as any, github: queue() as any }, loadActorToken: async () => null,
    github: { apply: async () => ({ ok: true }) }, plane: { preflight: async () => {}, apply: async () => { throw new PlaneApiError(422, {}, "failed"); } } });
  h.ctx.plane = outbox.plane;
  const original = ghJob("push", { commits: [{ id: sha("b"), message: "QLL-1 #comment old" }] }, "old-push");
  const run = inboundHandler(h.ctx, createRouter(h.ctx), "github");
  await run(original);
  const row = (await h.db.query<{ id: string }>("SELECT id FROM outbound_writes")).rows[0]!;
  await rejects(outbox.executePlane(await intentJob(h.db, row.id)), /failed/);
  await h.db.query("UPDATE outbound_writes SET write = write - '_smartCommit' WHERE id = $1", [row.id]);
  await run({ ...original, deliveryId: "explicit-replay", writeDeliveryId: original.deliveryId });
  strictEqual((await h.db.query<{ status: string }>("SELECT status FROM outbound_writes WHERE id = $1", [row.id])).rows[0]!.status, "pending");
  strictEqual((await h.db.query("SELECT 1 FROM outbound_writes")).rows.length, 1);
});

test("F9: rendered workspace Retry action reaches the authorized workspace endpoint and restores the failed write", async (t) => {
  let outbox: ReturnType<typeof createOrderedOutbox>;
  const h = await setup([], { enqueue: async () => {}, githubFor: async () => ({ request: async () => ({ data: [] }) }),
    resolveIssue: async () => null, retryFailed: (id, slug) => outbox.retryFailed(id, slug) });
  t.after(() => h.close());
  let fail = true, effects = 0;
  outbox = createOrderedOutbox({ db: h.db, queues: { plane: queue() as any, github: queue() as any }, loadActorToken: async () => null,
    github: { apply: async () => ({ ok: true }) }, plane: { preflight: async () => {}, apply: async () => {
      if (fail) throw new PlaneApiError(422, {}, "failed"); effects++; return { ok: true };
    } } });
  await deliveryScope.run({ deliveryId: "ui-write" }, () => outbox.plane.apply({ kind: "add_comment", slug: "acme", projectId: "p", issueId: "i", commentHtml: "hi" }));
  const job = await intentJob(h.db);
  await rejects(outbox.executePlane(job), /failed/);
  const page = await (await h.call("GET", "/workspaces/acme/audit", { cookie: ADM })).json() as any;
  const entry = page.entries.find((e: any) => failedWriteId(e));
  strictEqual(failedWriteId(entry), job.id);
  strictEqual(failedWriteId({ kind: "inbound_delivery", outcome: "failed", detail: { outboxId: job.id } }), null);
  strictEqual((await h.call("POST", `/workspaces/acme/outbound-writes/${job.id}/retry`, { cookie: MEM })).status, 403);
  strictEqual((await h.call("POST", `/workspaces/other/outbound-writes/${job.id}/retry`, { cookie: ADM })).status, 403);
  h.plane.roles["u-adm"]!.other = 20;
  strictEqual((await h.call("POST", `/workspaces/other/outbound-writes/${job.id}/retry`, { cookie: ADM })).status, 404);
  strictEqual((await h.call("POST", `/workspaces/acme/outbound-writes/${job.id}/retry`, { cookie: ADM, origin: "https://foreign.test" })).status, 403);
  const compiled = await build({ entryPoints: ["src/ui/client/Workspace.tsx"], bundle: true, platform: "node", format: "cjs", write: false });
  const compiledModule = { exports: {} as any };
  new Function("module", "exports", "require", compiled.outputFiles[0]!.text)(compiledModule, compiledModule.exports, createRequire(import.meta.url));
  const ui = compiledModule.exports;
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (!url.startsWith("/git-sync/")) return originalFetch(url, init);
    paths.push(url);
    return originalFetch(h.base + url, { ...init, headers: { ...init.headers, cookie: ADM, origin: "https://tasks.example.test" } });
  }) as typeof fetch;
  try {
    let scheduled: string | undefined;
    const props = { slug: "acme", id: job.id, busy: false, retried: false,
      run: async (work: () => Promise<unknown>) => { await work(); return true; }, onScheduled: (id: string) => { scheduled = id; } };
    const button = ui.FailedWriteRetry(props);
    strictEqual(button.props.children, "Retry");
    strictEqual(button.props.disabled, false);
    await button.props.onClick();
    strictEqual(scheduled, job.id);
    deepStrictEqual(paths, [`/git-sync/api/workspaces/acme/outbound-writes/${job.id}/retry`]);
    strictEqual(ui.FailedWriteRetry({ ...props, retried: true }).props.disabled, true);
    strictEqual(ui.FailedWriteRetry({ ...props, busy: true }).props.disabled, true);
  } finally { globalThis.fetch = originalFetch; }
  fail = false; await outbox.executePlane(await intentJob(h.db, job.id)); strictEqual(effects, 1);
});

const error = (headers: Record<string, string>) => Object.assign(new Error("throttled 403"), { status: 403, response: { headers } });

test("F11: final successful status retries for retry-after/quota 403 and fires readiness after recovery", async (t) => {
  const h = await makeHarness(); t.after(() => h.close());
  await h.mapping({ smartCommits: false, rules: '- when: pull_request.ready_for_merge\n  then: [{ comment: "ready" }]\n' });
  await h.link("iss-1", 12, { kind: "pr", tier: "closing" });
  const head = sha("c");
  h.gh.respond(/pulls\/\{pull_number\}$/, () => ({ number: 12, draft: false, state: "open", merged: false, head: { sha: head }, base: { ref: "main" }, labels: [] }));
  h.gh.respond(/commits\/\{commit_sha\}\/pulls$/, () => [{ number: 12, draft: false, state: "open", merged: false, head: { sha: head }, base: { ref: "main" }, labels: [] }]);
  h.gh.respond(/reviews$/, () => [{ state: "APPROVED", user: { id: 9 } }]);
  h.gh.respond(/check-suites$/, () => ({ total_count: 1, check_suites: [{ status: "completed", conclusion: "success" }] }));
  let failure: Error | null = null;
  h.gh.respond(/commits\/\{ref\}\/status$/, () => { if (failure) throw failure; return { state: "success", total_count: 1 }; });
  const run = inboundHandler(h.ctx, createRouter(h.ctx), "github");
  const job = ghJob("status", { sha: head, state: "success" });
  for (const headers of [{ "retry-after": "30" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1791779000" }] as Record<string, string>[]) {
    failure = error(headers);
    await rejects(run(job), (e) => e === failure);
    strictEqual(h.plane.writes().length, 0);
    strictEqual((await h.audit("readiness_unavailable")).length, 0);
  }
  failure = null; await run(job);
  ok(h.plane.writes().some((w) => w.method === "POST" && /comments/.test(w.path) && w.body?.comment_html?.includes("ready")));
  strictEqual((await h.audit("rule_match")).filter((r) => r.outcome === "applied").length, 1);
});

test("F11: permission 403/404 fail closed while throttling keeps its original headers", async () => {
  const unavailable: unknown[] = [];
  let failure: unknown;
  const octokit: any = { request: async (route: string) => {
    if (/reviews$/.test(route)) return { data: [{ state: "APPROVED", user: { id: 9 } }] };
    if (/check-suites$/.test(route)) return { data: { check_suites: [] } };
    throw failure;
  } };
  for (const status of [403, 404]) {
    failure = Object.assign(new Error(`permission ${status}`), { status, response: { headers: {} } });
    strictEqual(await checkPrReadiness(octokit, { owner: "a", repo: "b" }, 12, sha("c"), { onUnavailable: (e) => { unavailable.push(e); } }), false);
  }
  deepStrictEqual(unavailable, [{ what: "commit_status", status: 403 }, { what: "commit_status", status: 404 }]);
  failure = error({ "retry-after": "15" });
  await rejects(checkPrReadiness(octokit, { owner: "a", repo: "b" }, 12, sha("c")), (e) => e === failure);
});

test("F3 seam: stored plan authority is checked before resolution, refusals stay terminal on retry and replay", async (t) => {
  const h = await makeHarness(); t.after(() => h.close());
  const seen: { side: string; write: any; slug?: string }[] = [];
  let permitted = false, effects = 0;
  const outbox = createOrderedOutbox({ db: h.db, queues: { plane: queue() as any, github: queue() as any }, loadActorToken: async () => null,
    authoriseWrite: async (side, write, slug) => { seen.push({ side, write, slug }); if (!permitted) throw new Error("installation revoked"); },
    github: { apply: async () => { effects++; return { ok: true }; } },
    resumeReducer: async () => { effects++; },
    plane: { preflight: async () => {}, apply: async () => { effects++; return { ok: true, id: "created" }; } } });
  const steps: any[] = [{ kind: "write", side: "plane", write: { kind: "create_issue", slug: "ws", projectId: "p", fields: { name: "private" } }, bind: "created" },
    { kind: "write", side: "plane", write: { kind: "resume_reducer", continuation: { kind: "pr_created", mappingId: 17,
      job: ghJob("pull_request", {}), projectId: "p", issueId: { $result: "created.id" }, identifier: "QLL" } } }];
  const pendingLink = { planeWorkspaceSlug: "ws", planeProjectId: "p", ghRepoId: 555, ghNumber: 12 };
  const register = (replay = false) => deliveryScope.run({ deliveryId: "github-authority", workspaceSlug: "ws",
    ...(replay ? { writeDeliveryId: "authority", transportDeliveryId: "replay-authority" } : {}) }, () => outbox.plane.plan("authority-plan", steps, { pendingLink }));
  await register();
  const rows = (await h.db.query<{ id: string }>("SELECT id FROM outbound_writes ORDER BY sequence")).rows;
  await rejects(outbox.executePlane(await intentJob(h.db, rows[0]!.id)), /installation revoked/);
  strictEqual(effects, 0);
  strictEqual(seen[0]!.write._plan.marker.link.ghRepoId, 555);
  deepStrictEqual((await h.db.query<{ status: string }>("SELECT status FROM outbound_writes ORDER BY sequence")).rows.map((r) => r.status), ["failed", "failed"]);
  await rejects(outbox.retryFailed(rows[0]!.id, "ws"), /installation revoked/);
  await rejects(register(true), /installation revoked/);
  strictEqual((await h.audit("outbound_write_failed")).length, 3);
  permitted = true;
  await outbox.retryFailed(rows[0]!.id, "ws");
  await outbox.executePlane(await intentJob(h.db, rows[0]!.id));
  permitted = false;
  await rejects(outbox.executePlane(await intentJob(h.db, rows[1]!.id)), /installation revoked/);
  strictEqual(effects, 1);
  const last = seen.at(-1)!;
  strictEqual(last.slug, "ws");
  strictEqual(last.write.continuation.mappingId, 17);
  deepStrictEqual(last.write.continuation.issueId, { $result: "created.id" });
  ok(last.write._plan.root);
});

test("F3 seam: Github writes lacking a workspace are refused before dispatch and never transiently retried", async (t) => {
  const h = await makeHarness(); t.after(() => h.close());
  let effects = 0;
  const outbox = createOrderedOutbox({ db: h.db, queues: { plane: queue() as any, github: queue() as any }, loadActorToken: async () => null,
    authoriseWrite: async (_side, _write, slug) => { if (!slug) throw new PlaneApiError(503, {}, "workspace required"); },
    github: { apply: async () => { effects++; return { ok: true }; } }, plane: { preflight: async () => {}, apply: async () => ({ ok: true }) } });
  await outbox.github.apply({ kind: "comment", installationId: 1, owner: "a", repo: "b", repoId: 555, number: 1, body: "private" });
  const job = await intentJob(h.db);
  await rejects(outbox.executeGithub(job), /workspace required/);
  strictEqual(effects, 0);
  const row = (await h.db.query<{ status: string; attempts: number }>("SELECT status, attempts FROM outbound_writes WHERE id = $1", [job.id])).rows[0]!;
  deepStrictEqual(row, { status: "failed", attempts: 1 });
  strictEqual((await h.audit("outbound_write_failed"))[0].detail.reason, "authority_refused");
});

test("F3 seam: GitHub registration freezes only a unique authorized repo/installation workspace", async (t) => {
  const h = await makeHarness(); t.after(() => h.close()); await h.mapping();
  let effects = 0;
  const outbox = createOrderedOutbox({ db: h.db, queues: { plane: queue() as any, github: queue() as any }, loadActorToken: async () => null,
    authoriseWrite: createOutboundAuthoriser(h.db),
    github: { apply: async () => { effects++; return { ok: true }; } }, plane: { preflight: async () => {}, apply: async () => ({ ok: true }) } });
  const comment = { kind: "comment" as const, installationId: 1, owner: "a", repo: "b", repoId: 555, number: 12, body: "private" };
  await outbox.github.apply(comment);
  const unique = await intentJob(h.db);
  strictEqual(unique.data._gitsync.workspaceSlug, "ws");
  await outbox.executeGithub(unique); strictEqual(effects, 1);
  await h.mapping({ projectId: "other-project" });
  await outbox.github.apply({ ...comment, body: "same-workspace projects" });
  const sameWorkspace = await intentJob(h.db);
  strictEqual(sameWorkspace.data._gitsync.workspaceSlug, "ws");
  await outbox.executeGithub(sameWorkspace); strictEqual(effects, 2);
  await outbox.github.apply({ ...comment, repoId: 556, body: "unknown" });
  const unknown = await intentJob(h.db);
  strictEqual(unknown.data._gitsync.workspaceSlug, undefined);
  await h.mapping({ repoId: 556 });
  await rejects(outbox.executeGithub(unknown), /authority is missing or revoked/);
  // A mapped repository with an unlisted installation never establishes ownership.
  await outbox.github.apply({ ...comment, installationId: 999, body: "unlisted" });
  const unlisted = await intentJob(h.db);
  strictEqual(unlisted.data._gitsync.workspaceSlug, undefined);
  await rejects(outbox.executeGithub(unlisted), /authority is missing or revoked/);
  strictEqual(effects, 2);
});

test("F3 seam: conflicting cross-workspace legacy grants refuse inference and cannot repair stored NULL ownership", async (t) => {
  const h = await makeHarness(); t.after(() => h.close());
  await h.mapping();
  await h.mapping({ slug: "other", installationId: 2 });
  // The production PK forbids these conflicting grants. Model legacy/corrupt inventory only in this
  // disposable database so the actual inference SQL sees two distinct authorized workspaces.
  await h.db.exec("ALTER TABLE workspace_installations DROP CONSTRAINT workspace_installations_pkey");
  await h.db.query("UPDATE workspace_installations SET installation_id = 1 WHERE workspace_slug = 'other'");
  await h.db.query("UPDATE repo_mappings SET installation_id = 1 WHERE workspace_slug = 'other'");
  let effects = 0;
  const outbox = createOrderedOutbox({ db: h.db, queues: { plane: queue() as any, github: queue() as any }, loadActorToken: async () => null,
    authoriseWrite: createOutboundAuthoriser(h.db),
    github: { apply: async () => { effects++; return { ok: true }; } }, plane: { preflight: async () => {}, apply: async () => ({ ok: true }) } });
  const comment = { kind: "comment" as const, installationId: 1, owner: "a", repo: "b", repoId: 555, number: 12, body: "conflicting workspaces" };
  await outbox.github.apply(comment);
  const ambiguous = await intentJob(h.db);
  strictEqual(ambiguous.data._gitsync.workspaceSlug, undefined);
  strictEqual((await h.db.query<{ workspace_slug: string | null }>("SELECT workspace_slug FROM outbound_writes WHERE id = $1", [ambiguous.id])).rows[0]!.workspace_slug, null);
  await rejects(outbox.executeGithub(ambiguous), /authority is missing or revoked/);
  strictEqual(effects, 0);
  await h.db.query("DELETE FROM repo_mappings WHERE workspace_slug = 'other'");
  await h.db.query("DELETE FROM workspace_installations WHERE workspace_slug = 'other'");
  await h.db.exec("ALTER TABLE workspace_installations ADD PRIMARY KEY (installation_id)");
  await rejects(outbox.executeGithub(ambiguous), /authority is missing or revoked/);
  await rejects(outbox.retryFailed(ambiguous.id, "ws"), /not found in this workspace/);
  await outbox.github.apply({ ...comment, body: "new uniquely owned intent" });
  const resolved = await intentJob(h.db);
  strictEqual(resolved.data._gitsync.workspaceSlug, "ws");
  await outbox.executeGithub(resolved);
  strictEqual(effects, 1);
});
