// The remaining composed reducers: pushes, checks, deployments, mirroring edge cases, orphan linkback.
import test from "node:test";
import { strictEqual, deepStrictEqual, ok } from "node:assert/strict";
import { createDb } from "../../src/db/client.ts";
import { migrate } from "../../src/db/migrate.ts";
import { withObjectLock } from "../../src/app/context.ts";
import { linkbackOnOrphan } from "../../src/app/main.ts";
import { createMappingVerifier, installationWorkspaceFromDb } from "../../src/ui/mapping-check.ts";
import { rememberInstallation } from "../../src/app/mappings.ts";
import { startPostgres } from "../../scripts/lib/postgres.mjs";
import { ghJob, makeHarness, planeJob, sha } from "./harness.ts";

const USERS = { alice: "d2c59a29-f223-4c2d-bf16-0c5e43c16bbb", bob: "fb7b6d84-645e-4da1-8c2c-08b73953b3cd", carol: "55ba1f2b-30a9-4fb8-9513-5152e0a6c894" };

type H = Awaited<ReturnType<typeof makeHarness>>;
const links = (h: H) => h.plane.writes().filter((c) => /\/links\/$/.test(c.path)).map((c) => c.body);

test("a new branch carrying a key runs the branch-pushed rule and adds a branch link", async () => {
  const h = await makeHarness();
  await h.mapping();
  await h.feed(ghJob("push", { ref: "refs/heads/octo/qll-1-login", created: true, commits: [] }));
  deepStrictEqual(h.plane.writes().filter((c) => c.method === "PATCH").map((c) => c.body), [{ state: "s-prog" }]);
  deepStrictEqual(links(h).map((l) => l.title), ["[Branch] octo/qll-1-login"]);
  await h.close();
});

test("a later push to an existing branch does not re-run the branch rule", async () => {
  const h = await makeHarness();
  await h.mapping();
  await h.feed(ghJob("push", { ref: "refs/heads/octo/qll-1-login", created: false, commits: [] }));
  strictEqual(h.plane.writes().length, 0);
  await h.close();
});

test("check runs roll up to every item the PR links: pass, then fail", async () => {
  const h = await makeHarness();
  await h.mapping();
  await h.link("iss-1", 12, { kind: "pr", tier: "closing" });
  const event = (id?: string) => ghJob("check_run", { action: "completed", check_run: { head_sha: sha("a"), conclusion: "success", pull_requests: [{ number: 12 }] } }, id);
  h.gh.respond(/check-runs$/, () => ({ check_runs: [{ conclusion: "success" }, { conclusion: "success" }] }));
  await h.feed(event());
  strictEqual(links(h)[0].title, "[CI] Build · pass");
  h.gh.respond(/check-runs$/, () => ({ check_runs: [{ conclusion: "success" }, { conclusion: "failure" }] }));
  await h.feed(event());
  const patch = h.plane.writes().find((c) => c.method === "PATCH" && /\/links\//.test(c.path));
  strictEqual(patch!.body.title, "[CI] Build · fail");
  await h.close();
});

test("a successful deployment adds a deploy link and a named preview shortcut", async () => {
  const h = await makeHarness();
  await h.mapping();
  await h.link("iss-1", 12, { kind: "pr", tier: "closing" });
  h.gh.respond(/commits\/\{commit_sha\}\/pulls$/, () => [{ number: 12 }]);
  await h.feed(ghJob("deployment_status", { action: "created", deployment: { sha: sha("b"), environment: "preview" }, deployment_status: { state: "success", environment: "preview", environment_url: "https://web-abc.vercel.app" } }));
  deepStrictEqual(links(h).map((l) => l.title), ["[Deploy] preview · success", "[Preview] Vercel"]);
  deepStrictEqual(links(h).map((l) => l.url), ["https://web-abc.vercel.app", "https://web-abc.vercel.app"].map((u) => u));
  await h.close();
});

test("a deployment for a commit with no linked PR writes nothing", async () => {
  const h = await makeHarness();
  await h.mapping();
  h.gh.respond(/commits\/\{commit_sha\}\/pulls$/, () => []);
  await h.feed(ghJob("deployment_status", { deployment: { sha: sha("c") }, deployment_status: { state: "success", environment_url: "https://x.vercel.app" } }));
  strictEqual(h.plane.writes().length, 0);
  await h.close();
});

test("events nothing handles are audited as unhandled", async () => {
  const h = await makeHarness();
  await h.mapping();
  strictEqual(await h.feed(ghJob("star", { action: "created" }, "u1")), "handled");
  strictEqual(await h.feed(planeJob("cycle", { action: "create", data: { id: "c" } }, "u2")), "handled");
  deepStrictEqual((await h.audit("inbound")).map((r) => [r.source, r.outcome]), [["github", "unhandled"], ["plane", "unhandled"]]);
  await h.close();
});

test("every delivery is audited with its payload for replay", async () => {
  const h = await makeHarness();
  await h.feed(ghJob("star", { action: "created" }, "u3"));
  const [row] = await h.audit("inbound_delivery");
  strictEqual(row!.detail.event, "star");
  strictEqual(row!.detail.payload.action, "created");
  await h.close();
});

test("Plane → GitHub assignee sync preserves unmapped assignees and adds the new mapped one", async () => {
  const h = await makeHarness();
  await h.mapping();
  await h.link("i1", 7);
  await h.db.query("INSERT INTO user_map (workspace_slug, plane_user_id, gh_login, gh_id) VALUES ('ws', $1, 'alice', 1), ('ws', $2, 'carol', 3)", [USERS.alice, USERS.carol]);
  h.gh.respond(/GET \/repos\/\{owner\}\/\{repo\}\/issues\/\{issue_number\}$/, () => ({ assignees: [{ login: "alice" }, { login: "bob" }] }));
  await h.feed(planeJob("issue", { action: "update", data: { id: "i1", project: "p-qll", assignees: [{ id: USERS.alice }, { id: USERS.carol }] }, activity: { field: "assignee_ids", old_value: [USERS.alice], new_value: [USERS.alice, USERS.carol], actor: { id: "u-h", email: "human@test.local" } } }));
  const w = h.gh.writes().map((c) => [c.route, c.params.assignees]);
  deepStrictEqual(w, [
    ["POST /repos/{owner}/{repo}/issues/{issue_number}/assignees", ["carol"]],
  ]);
  await h.close();
});

test("the assignee removal GitHub makes is recorded, so its `unassigned` webhook is dropped", async () => {
  const h = await makeHarness();
  await h.mapping();
  await h.link("i1", 7);
  await h.db.query("INSERT INTO user_map (workspace_slug, plane_user_id, gh_login, gh_id) VALUES ('ws', $1, 'alice', 1), ('ws', $2, 'bob', 2)", [USERS.alice, USERS.bob]);
  h.gh.respond(/GET \/repos\/\{owner\}\/\{repo\}\/issues\/\{issue_number\}$/, () => ({ assignees: [{ login: "alice" }, { login: "bob" }] }));
  await h.feed(planeJob("issue", { action: "update", data: { id: "i1", project: "p-qll", assignees: [{ id: USERS.alice }] }, activity: { field: "assignees", old_value: [USERS.alice, USERS.bob], new_value: [USERS.alice], actor: { id: "u-h", email: "human@test.local" } } }));
  const echo = ghJob("issues", { action: "unassigned", issue: { number: 7, title: "t", assignees: [{ login: "alice" }] }, assignee: { login: "bob" }, sender: { login: "gitsync[bot]", id: 1, type: "Bot" } });
  strictEqual(await h.feed(echo), "echo");
  await h.close();
});

test("two simultaneous `labeled` events for one GitHub issue leave one sync link (the index is the backstop)", async () => {
  const h = await makeHarness();
  await h.mapping();
  const labeled = () => ghJob("issues", { action: "labeled", label: { name: "plane" }, issue: { number: 40, title: "Race", body: "", state: "open", labels: [{ name: "plane" }], assignees: [] } });
  await Promise.all([h.feed(labeled()), h.feed(labeled())]);
  strictEqual((await h.db.query("SELECT 1 FROM sync_links WHERE created_by = 'label_sync' AND gh_number = 40")).rows.length, 1);
  await h.close();
});

test("the unique index refuses a second label_sync link for the same GitHub issue", async () => {
  const h = await makeHarness();
  await h.link("a", 41);
  let code = "";
  try { await h.link("b", 41); } catch (e) { code = (e as { code?: string }).code ?? ""; }
  strictEqual(code, "23505");
  await h.close();
});

test("an orphaned link is reported on GitHub when linkback is on, and never closes anything", async () => {
  const h = await makeHarness();
  await h.mapping({ linkback: true });
  await linkbackOnOrphan(h.ctx, { gh_repo_id: 555, gh_number: 9, plane_issue_id: "gone", plane_workspace_slug: "ws" });
  const w = h.gh.writes();
  strictEqual(w.length, 1);
  strictEqual(w[0]!.route, "POST /repos/{owner}/{repo}/issues/{issue_number}/comments");
  ok(!w.some((c) => c.route.startsWith("PATCH")));
  await h.close();
});

test("with linkback off an orphan is silent", async () => {
  const h = await makeHarness();
  await h.mapping({ linkback: false });
  await linkbackOnOrphan(h.ctx, { gh_repo_id: 555, gh_number: 9, plane_issue_id: "gone", plane_workspace_slug: "ws" });
  strictEqual(h.gh.writes().length, 0);
  await h.close();
});

test("the installation id from a webhook is remembered on the mapping", async () => {
  const h = await makeHarness();
  try {
    const mappingId = await h.mapping({ installationId: null });
    await h.db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (1, 'ws'), (4242, 'ws')");
    h.gh.respond(/^GET \/repos\//, () => ({ id: 555, full_name: "acme/web" }));
    let verifiedId: number | undefined;
    const verify = createMappingVerifier({ plane: h.ctx.planeClient, github: h.ctx.ghClient, installationWorkspace: installationWorkspaceFromDb(h.db) });
    strictEqual(await verify({ slug: "ws", repo: { id: 555, fullName: "acme/web" }, onInstallationVerified: (id) => { verifiedId = id; } }), null);
    strictEqual(verifiedId, 1);
    await rememberInstallation(h.db, mappingId, verifiedId!);
    strictEqual(Number((await h.db.query<any>("SELECT installation_id FROM repo_mappings")).rows[0].installation_id), 1);
    strictEqual(await h.feed(ghJob("issues", { action: "opened", issue: { number: 3, title: "x", body: "", labels: [], assignees: [] }, installation: { id: 4242 } })), "handled");
    strictEqual(Number((await h.db.query<any>("SELECT installation_id FROM repo_mappings")).rows[0].installation_id), 4242);
  } finally { await h.close(); }
});

test("the object lock serialises work on one key across real Postgres connections", async () => {
  const pg = await startPostgres();
  const db = createDb(pg.url);
  try {
    await migrate(db);
    const order: string[] = [];
    const task = (name: string) => withObjectLock(db, "gh:1#1", async () => {
      order.push(`${name}:in`);
      await new Promise((r) => setTimeout(r, 150));
      order.push(`${name}:out`);
    });
    await Promise.all([task("a"), task("b")]);
    ok(order[0]!.endsWith(":in") && order[1] === order[0]!.replace(":in", ":out"), `interleaved: ${order.join(",")}`);
    await Promise.all([withObjectLock(db, "gh:1#2", async () => order.push("x")), withObjectLock(db, "gh:1#3", async () => order.push("y"))]);
  } finally { await db.close(); await pg.stop(); }
});
