import test from "node:test";
import type { TestContext } from "node:test";
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { createOutboundAuthoriser } from "../../src/app/mappings.ts";
import { createOrderedOutbox, deliveryScope } from "../../src/app/writers.ts";
import { upsertSyncLink } from "../../src/db/ledgers.ts";
import { onGithubIssue, onPlaneIssue } from "../../src/sync/mirror.ts";
import type { MirrorDeps, MirrorMapping } from "../../src/sync/mirror.ts";
import type { InboundJob } from "../../src/queue/index.ts";
import type { FrozenWriteAuthority } from "../../src/app/mappings.ts";
import { database, intentJob, queue } from "../writers/outbox-fixture.ts";
import { fakeGithubWriter, fakePlaneWriter } from "../github/fakes.ts";

const authority: FrozenWriteAuthority = { mappingId: "1", workspaceSlug: "ws", repoId: 555, installationId: 9 };
const foreignAuthority: FrozenWriteAuthority = { mappingId: "99", workspaceSlug: "other", repoId: 777, installationId: 10 };

function githubPayload(action: string, extra: object = {}) {
  return { action, repository: { id: 555 }, issue: { number: 41, title: "Mirror title", body: "Description",
    labels: [{ name: "plane" }, { name: "bug" }], assignees: [], state: "open" }, ...extra };
}

function planePayload(action: string, extra: object = {}) {
  return { action, data: { id: "pi-1", project: "p-1", name: "Mirror title", description_html: "<p>Description</p>",
    labels: [{ name: "github" }, { name: "bug" }], assignees: [] }, ...extra };
}

const job = (source: "github" | "plane", deliveryId: string, payload: unknown): InboundJob =>
  ({ source, deliveryId, event: source === "github" ? "issues" : "issue", receivedAt: "2026-10-12T00:00:00Z", payload });

async function setup(t: TestContext) {
  const db = await database(t);
  await db.query("INSERT INTO workspace_installations (workspace_slug, installation_id) VALUES ('ws', 9)");
  await db.query(`INSERT INTO repo_mappings (id, workspace_slug, gh_repo_id, gh_repo_full_name, plane_project_id, installation_id, sync_direction)
    VALUES (1, 'ws', 555, 'acme/web', 'p-1', 9, 'bidirectional')`);
  const mapping: MirrorMapping = { id: 1, workspaceSlug: "ws", ghRepoId: 555, planeProjectId: "p-1",
    installationId: 9, owner: "acme", repo: "web", syncDirection: "bidirectional" };
  const plane = fakePlaneWriter(), github = fakeGithubWriter();
  const planeQ = queue(), githubQ = queue();
  const resumed: InboundJob[] = [];
  const ordered = createOrderedOutbox({ db, plane: { ...plane, preflight: async () => {} }, github,
    queues: { plane: planeQ as any, github: githubQ as any }, loadActorToken: async () => null,
    authoriseWrite: createOutboundAuthoriser(db), resumeReducer: async (request) => {
      // Production pending-mirror dispatch re-enters these same public mirror functions.
      if (request.kind !== "mirror_pending") return;
      deepStrictEqual(request.authority, authority);
      strictEqual(deliveryScope.getStore()?.authority, undefined, "worker dispatch begins in a fresh delivery scope");
      resumed.push(request.job);
      await feed(request.job, false);
    } });
  const deps: MirrorDeps = { db, mapping, plane: ordered.plane, github: ordered.github,
    users: { planeUserIdForGithubLogin: async () => null } };
  async function feed(request: InboundJob, continuation = true) {
    const scopedDeps = { ...deps, ...(continuation ? { createContinuation: { job: request } } : {}) };
    return request.source === "github" ? onGithubIssue(request.payload, scopedDeps)
      : onPlaneIssue({ event: request.event, payload: request.payload }, scopedDeps);
  }
  const deliver = (request: InboundJob) => deliveryScope.run({ deliveryId: `${request.source}-${request.deliveryId}`,
    transportDeliveryId: request.deliveryId, operationId: "mirror-operation", authority: foreignAuthority }, async () => {
    const parent = deliveryScope.getStore();
    const result = await feed(request);
    strictEqual(deliveryScope.getStore(), parent, "mirror restores its caller's scope");
    deepStrictEqual(parent?.authority, foreignAuthority, "mirror does not mutate the caller's authority");
    return result;
  });
  const rows = async () => (await db.query<{ id: string; side: string; delivery_id: string; workspace_slug: string;
    status: string; write: Record<string, any> }>("SELECT id, side, delivery_id, workspace_slug, status, write FROM outbound_writes ORDER BY sequence")).rows;
  async function assertAuthority() {
    const writes = await rows();
    ok(writes.length > 0, "the mirror registered durable intents");
    for (const row of writes) {
      deepStrictEqual(row.write._authority, authority, `${row.side} ${row.write.kind} carries the source mapping`);
      strictEqual(row.workspace_slug, "ws");
    }
    return writes;
  }
  async function drain() {
    for (let round = 0; round < 30; round++) {
      const pending = (await rows()).filter((row) => row.status === "pending");
      if (!pending.length) {
        ok((await rows()).every((row) => row.status === "applied"), "production authorization admitted every intent");
        return;
      }
      const next = pending.find((row) => (row.side === "plane" ? planeQ : githubQ).jobs.has(row.id));
      ok(next, "an executable intent was woken");
      const wake = await intentJob(db, next.id);
      await (next.side === "plane" ? ordered.executePlane(wake) : ordered.executeGithub(wake));
    }
    throw new Error("mirror outbox did not drain within 30 intents");
  }
  return { db, mapping, plane, github, deliver, rows, assertAuthority, drain, resumed, deps };
}

test("R6: linked mirror writes in both directions freeze their mapping and preserve caller identity", async (t) => {
  const h = await setup(t);
  await upsertSyncLink(h.db, { planeWorkspaceSlug: "ws", planeProjectId: "p-1", planeIssueId: "pi-1",
    ghRepoId: 555, ghNumber: 41, ghKind: "issue", tier: "relation", createdBy: "label_sync" });
  const gh = job("github", "comment", githubPayload("created", { comment: { body: "New comment", user: { login: "octo" } } }));
  strictEqual((await h.deliver(gh)).action, "updated");
  const p = job("plane", "state", planePayload("update", { activity: { field: "state" },
    data: { id: "pi-1", project: "p-1", state: { group: "completed" } } }));
  strictEqual((await h.deliver(p)).action, "updated");
  const writes = await h.assertAuthority();
  deepStrictEqual(writes.map((row) => [row.side, row.write.kind, row.delivery_id]),
    [["plane", "add_comment", "github-comment"], ["github", "update_issue", "plane-state"]]);
  await h.drain();
  // Re-registering an unchanged Plane write from a changed mapping must keep its first authority.
  h.mapping.id = 99;
  h.mapping.installationId = 10;
  await h.deliver(gh);
  deepStrictEqual((await h.assertAuthority()).map((row) => row.id), writes.map((row) => row.id));
});

for (const source of ["github", "plane"] as const) {
  test(`R6: ${source}-origin create plans and resumed mirror events register authority on every step`, async (t) => {
    const h = await setup(t);
    const opened = job(source, "opened", source === "github" ? githubPayload("opened") : planePayload("create"));
    strictEqual((await h.deliver(opened)).action, "created");
    const initial = await h.assertAuthority();
    ok(initial.some((row) => row.side === "plane"));
    ok(initial.some((row) => row.side === "github"));
    ok(initial.some((row) => row.write.kind === "create_issue"));
    ok(initial.every((row) => row.delivery_id === `${source}-opened`));
    const later = job(source, "later", source === "github"
      ? githubPayload("created", { comment: { body: "Arrived during creation" } })
      : planePayload("update", { activity: { field: "state" }, data: { id: "pi-1", project: "p-1", state: { group: "completed" } } }));
    strictEqual((await h.deliver(later)).action, "deferred");
    const beforeResume = await h.assertAuthority();
    const deferred = beforeResume.find((row) => row.write.continuation?.kind === "mirror_pending");
    ok(deferred, "pending event is a durable reducer continuation");
    strictEqual(deferred.side, source === "github" ? "plane" : "github");
    await h.drain();
    deepStrictEqual(h.resumed, [later]);
    const afterResume = await h.assertAuthority();
    const resumedWrites = afterResume.filter((row) => !beforeResume.some((before) => before.id === row.id));
    strictEqual(resumedWrites.length, 1, "resumed field/comment sync registered exactly one write");
    strictEqual(resumedWrites[0]!.delivery_id, `${source}-later`);
    strictEqual(resumedWrites[0]!.write.kind, source === "github" ? "add_comment" : "update_issue");
  });
}

test("R6: direct mirror callers also register mapping authority without an outer delivery scope", async (t) => {
  const h = await setup(t);
  strictEqual(deliveryScope.getStore(), undefined);
  strictEqual((await onPlaneIssue({ event: "issue", payload: planePayload("create") }, h.deps)).action, "created");
  await h.assertAuthority();
  strictEqual(deliveryScope.getStore(), undefined);
  await h.drain();
});
