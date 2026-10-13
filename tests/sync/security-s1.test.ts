// Security audit S1: a rule's `create_issue.project` was pasted unencoded into a Plane URL and sent with the
// service key, so `../../victim-ws/projects/<id>` (the WHATWG URL parser folds `..` and `%2e%2e` alike)
// retargeted the write at another workspace. Three layers now refuse it: the Plane path builder, the rule
// parser, and the outbound authoriser.
import test from "node:test";
import { deepStrictEqual, rejects, strictEqual, throws } from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { SecretString } from "../../src/auth/identity.ts";
import { migrate } from "../../src/db/migrate.ts";
import type { Db } from "../../src/db/migrate.ts";
import { createOutboundAuthoriser, freezeMappingAuthority } from "../../src/app/mappings.ts";
import { PlaneClient, PlaneWritePath, planeItemsPath, planeWorkspacePath } from "../../src/sync/plane.ts";
import { parseRules } from "../../src/rules/engine.ts";

const VICTIM_PROJECT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const OWN_PROJECT = "0b1e8d5e-9a3f-4c1b-8f6e-2d4a6c8e0f12";
const TRAVERSAL = `../../victim-ws/projects/${VICTIM_PROJECT}`;
const ENCODED = [`%2e%2e/%2e%2e/victim-ws/projects/${VICTIM_PROJECT}`, `%2E%2E%2F%2E%2E%2Fvictim-ws`, "..", ".", "a/b", "a%2Fb", "a\\b", " ", ""];

test("S1 layer 1: Plane path builders refuse dot segments, separators and percent escapes", () => {
  // Positive control: the same builder accepts real ids and encodes nothing it does not need to.
  strictEqual(planeItemsPath("ws-a", OWN_PROJECT), `/workspaces/ws-a/projects/${OWN_PROJECT}/work-items/`);
  strictEqual(planeItemsPath("ws-a", OWN_PROJECT, "ENG-12"), `/workspaces/ws-a/projects/${OWN_PROJECT}/work-items/ENG-12/`);
  strictEqual(planeWorkspacePath("ws_a", "members"), "/workspaces/ws_a/members/");
  for (const bad of [TRAVERSAL, ...ENCODED]) {
    throws(() => planeItemsPath("ws-a", bad), /not a valid Plane id/, `project ${JSON.stringify(bad)}`);
    throws(() => planeItemsPath("ws-a", OWN_PROJECT, bad), /not a valid Plane id/, `item ${JSON.stringify(bad)}`);
    throws(() => planeItemsPath(bad, OWN_PROJECT), /not a valid Plane id/, `slug ${JSON.stringify(bad)}`);
  }
  // Why refusal and not only encoding: `..` encodes to itself and `%2e%2e` is still a dot segment.
  strictEqual(encodeURIComponent(".."), "..");
  strictEqual(new URL(`http://h/workspaces/ws-a/projects/%2e%2e/%2e%2e/victim-ws/x`).pathname, "/workspaces/victim-ws/x");
});

test("S1 layer 1: a traversal create_issue sends nothing with the service key", async () => {
  const urls: string[] = [];
  const client = new PlaneClient({ baseUrl: "http://plane.test", token: new SecretString("svc"), maxRetries: 0,
    fetch: (async (url: string | URL) => { urls.push(String(url)); return new Response(JSON.stringify({ id: "x" }), { status: 201 }); }) as typeof fetch });
  // No state field, so the write path reaches the URL builder before it touches the database.
  const writer = new PlaneWritePath({ client, db: {} as Db });
  for (const projectId of [TRAVERSAL, ENCODED[0]!, ENCODED[1]!]) {
    await rejects(() => writer.apply({ kind: "create_issue", slug: "ws-a", projectId, fields: { name: "x" } }), /not a valid Plane id/);
  }
  await rejects(() => writer.apply({ kind: "update_link", slug: "ws-a", projectId: OWN_PROJECT, issueId: "i1", linkId: "../../x", url: "https://e.test", title: "t" }), /not a valid Plane id/);
  deepStrictEqual(urls, []);
  await rejects(() => client.getProject("ws-a", TRAVERSAL), /not a valid Plane id/);
  await rejects(() => client.listStates("..", OWN_PROJECT), /not a valid Plane id/);
  deepStrictEqual(urls, []);
});

const rule = (project: string) => `
- name: follow-up
  when: [pull_request.merged]
  then:
    - create_issue: { project: ${JSON.stringify(project)}, title: "Follow-up" }
`;

test("S1 layer 2: parseRules accepts only a project UUID or identifier", () => {
  strictEqual(parseRules(rule(OWN_PROJECT))[0]!.then[0]!.type, "create_issue");
  strictEqual(parseRules(rule("ENG"))[0]!.then[0]!.type, "create_issue");
  for (const bad of [TRAVERSAL, ...ENCODED, "{{repo}}", "ws-b/ENG", "ENG.1", `${OWN_PROJECT}/..`, "ABCDEFGHIJKLM"]) {
    throws(() => parseRules(rule(bad)), /create_issue project must be a Plane project UUID or identifier/, JSON.stringify(bad));
  }
});

test("S1 layer 3: the authoriser refuses a project of another workspace", async () => {
  const pg = new PGlite(); await pg.waitReady; await migrate(pg);
  const db = pg as unknown as Db;
  try {
    await db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (11, 'ws-a'), (22, 'victim-ws')");
    const own = (await db.query<{ id: number }>(`INSERT INTO repo_mappings
      (workspace_slug, gh_repo_id, gh_repo_full_name, plane_project_id, sync_direction, installation_id)
      VALUES ('ws-a', 555, 'acme/web', $1, 'bidirectional', 11) RETURNING id`, [OWN_PROJECT])).rows[0]!;
    await db.query(`INSERT INTO repo_mappings
      (workspace_slug, gh_repo_id, gh_repo_full_name, plane_project_id, sync_direction, installation_id)
      VALUES ('victim-ws', 777, 'victim/app', $1, 'bidirectional', 22)`, [VICTIM_PROJECT]);
    const authorise = createOutboundAuthoriser(db);
    const authority = freezeMappingAuthority({ id: Number(own.id), workspaceSlug: "ws-a", ghRepoId: 555, installationId: 11 });
    const create = (projectId: string) => ({ kind: "create_issue", slug: "ws-a", projectId, fields: { name: "Follow-up" }, _authority: authority });

    // Positive control: the rule's own mapped project passes, both frozen and standalone.
    await authorise("plane", create(OWN_PROJECT), "ws-a");
    const { _authority: _frozen, ...ownStandalone } = create(OWN_PROJECT);
    await authorise("plane", ownStandalone, "ws-a");
    // A foreign workspace's (mapped, real) project, the traversal string and an encoded variant are all refused.
    for (const projectId of [VICTIM_PROJECT, TRAVERSAL, ENCODED[0]!, "ENG"]) {
      await rejects(() => authorise("plane", create(projectId), "ws-a"), /revoked/, projectId);
      const { _authority, ...standalone } = create(projectId);
      await rejects(() => authorise("plane", standalone, "ws-a"), /revoked/, `standalone ${projectId}`);
    }
    // The other project-addressed writes are held to the same rule.
    await rejects(() => authorise("plane", { kind: "upsert_label", slug: "ws-a", projectId: VICTIM_PROJECT, name: "x", _authority: authority }, "ws-a"), /revoked/);
    await rejects(() => authorise("plane", { kind: "add_link", slug: "ws-a", projectId: VICTIM_PROJECT, issueId: "i", url: "https://e.test", title: "t", _authority: authority }, "ws-a"), /revoked/);
    // Naming the victim workspace in the write itself still fails: the delivery's workspace is the authority.
    await rejects(() => authorise("plane", { ...create(VICTIM_PROJECT), slug: "victim-ws" }, "ws-a"), /revoked/);

    // A link in this workspace makes its project addressable; one in another workspace does not.
    const linked = "1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9";
    await db.query(`INSERT INTO sync_links (plane_workspace_slug, plane_project_id, plane_issue_id, gh_repo_id, gh_number, gh_kind, tier, created_by)
      VALUES ('victim-ws', $1, 'vi', 777, 1, 'issue', 'closing', 'label_sync')`, [linked]);
    await rejects(() => authorise("plane", create(linked), "ws-a"), /revoked/);
    await db.query(`INSERT INTO sync_links (plane_workspace_slug, plane_project_id, plane_issue_id, gh_repo_id, gh_number, gh_kind, tier, created_by)
      VALUES ('ws-a', $1, 'oi', 555, 2, 'issue', 'closing', 'label_sync')`, [linked]);
    await authorise("plane", create(linked), "ws-a");
  } finally { await pg.close(); }
});
