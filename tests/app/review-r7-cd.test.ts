import test from "node:test";
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { linkbackOnOrphan } from "../../src/app/main.ts";
import { createOutboundAuthoriser } from "../../src/app/mappings.ts";
import { createOrderedOutbox, deliveryScope } from "../../src/app/writers.ts";
import type { GithubWrite } from "../../src/sync/github.ts";
import { makeHarness } from "../a8/harness.ts";
import { intentJob, queue } from "../writers/outbox-fixture.ts";

test("F3: maintenance orphan comments freeze their source mapping and refuse execution/retry after its deletion", async () => {
  const h = await makeHarness();
  try {
    const sourceId = await h.mapping({ linkback: true, smartCommits: false });
    const otherId = await h.mapping({ projectId: "p-web", linkback: true, smartCommits: false });
    const sent: GithubWrite[] = [];
    const ordered = createOrderedOutbox({ db: h.db, authoriseWrite: createOutboundAuthoriser(h.db),
      queues: { plane: queue(), github: queue() }, loadActorToken: async () => null,
      plane: { preflight: async () => {}, apply: async () => ({ ok: true }) },
      github: { apply: async (write) => { sent.push(write); return { ok: true }; } },
    });
    const ctx = { ...h.ctx, github: ordered.github, plane: ordered.plane };
    const link = { gh_repo_id: 555, gh_number: 9, plane_issue_id: "gone", plane_workspace_slug: "ws",
      plane_project_id: "p-qll", gh_kind: "issue" as const, created_by: "label_sync" as const };
    strictEqual(deliveryScope.getStore(), undefined, "maintenance has no inbound mapping scope");
    await linkbackOnOrphan(ctx, link);
    const original = await intentJob(h.db);
    deepStrictEqual(original.data._authority, { workspaceSlug: "ws", mappingId: String(sourceId), repoId: 555, installationId: 1 });
    strictEqual(original.data._gitsync.workspaceSlug, "ws");
    strictEqual(sent.length, 0, "registration sends no remote comment");
    await h.db.query("DELETE FROM repo_mappings WHERE id = $1", [sourceId]);
    strictEqual((await h.db.query("SELECT 1 FROM repo_mappings WHERE id = $1", [otherId])).rows.length, 1, "alternative mapping is retained");
    await rejects(() => ordered.executeGithub(original), /authority is missing or revoked/);
    await rejects(() => ordered.retryFailed(original.id, "ws"), /authority is missing or revoked/);
    strictEqual(sent.length, 0, "the surviving mapping cannot authorize the removed source's comment");
    strictEqual((await h.db.query<{ status: string }>("SELECT status FROM outbound_writes WHERE id = $1", [original.id])).rows[0]!.status, "failed");
    deepStrictEqual((await intentJob(h.db, original.id)).data._authority, original.data._authority, "retry never substitutes authority");

    // A genuinely new maintenance registration can use the remaining authorized mapping.
    await linkbackOnOrphan(ctx, { ...link, gh_number: 10, plane_project_id: "p-web", plane_issue_id: "new-orphan" });
    const fresh = await intentJob(h.db);
    deepStrictEqual(fresh.data._authority, { workspaceSlug: "ws", mappingId: String(otherId), repoId: 555, installationId: 1 });
    await ordered.executeGithub(fresh);
    strictEqual(sent.length, 1);
    const comment = sent[0]!;
    strictEqual(comment.kind, "comment");
    ok(!("_authority" in comment), "frozen authority is not sent to the remote API");
    ok(comment.kind === "comment" && comment.body.includes("marked orphaned"));
    ok(!("fields" in comment), "maintenance never closes an orphan's GitHub issue");
  } finally { await h.close(); }
});

test("F3: an explicitly seeded older unstamped intent retains legacy authorization", async () => {
  const h = await makeHarness();
  try {
    await h.mapping({ projectId: "p-web", installationId: 1 });
    let comments = 0;
    const ordered = createOrderedOutbox({ db: h.db, authoriseWrite: createOutboundAuthoriser(h.db),
      queues: { plane: queue(), github: queue() }, loadActorToken: async () => null,
      plane: { preflight: async () => {}, apply: async () => ({ ok: true }) },
      github: { apply: async () => { comments++; return { ok: true }; } },
    });
    const legacy = { kind: "comment", installationId: 1, owner: "acme", repo: "web", repoId: 555, number: 19, body: "older orphan comment" };
    await h.db.query(`INSERT INTO outbound_writes (id, side, target_key, workspace_slug, write)
      VALUES ('r7-legacy-comment', 'github', $1, 'ws', $2::jsonb)`, [JSON.stringify(["github", 555, ["issue", 19]]), JSON.stringify(legacy)]);
    const job = await intentJob(h.db, "r7-legacy-comment");
    strictEqual(job.data._authority, undefined);
    await ordered.executeGithub(job);
    strictEqual(comments, 1);
  } finally { await h.close(); }
});
