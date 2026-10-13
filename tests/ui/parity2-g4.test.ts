import test from "node:test";
import { strictEqual, ok, deepStrictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { startServer } from "../../src/index.ts";
import { migrate } from "../../src/db/migrate.ts";
import { updateMappingParity } from "../../src/db/parity.ts";
import {
  DEFAULT_BRANCH_TEMPLATE, branchKeys, branchRollupKey, branchTreeUrl, isValidGitBranchName, parseDevLinks, renderBranchName,
  suggestedBranchTitle, titleSlug, upsertSuggestedBranchLink, validateBranchTemplate,
} from "../../src/sync/dev-info.ts";
import { createDevPanelRoutes, parsePrLink, rollupPrStatus } from "../../src/ui/dev-panel.ts";
import type { DevPanelData } from "../../src/ui/dev-panel.ts";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// DevPanel.tsx is JSX, which plain `node --test` cannot load (type stripping does not cover .tsx), so the test bundles it
// with the repository's esbuild the same way parity2-g5 bundles the other client pages, and imports the real module.
const devPanel = await (async () => {
  const dir = await mkdtemp(join(tmpdir(), "parity2-g4-ui-"));
  try {
    await symlink(resolve(import.meta.dirname, "../../node_modules"), join(dir, "node_modules"), "dir");
    const outfile = join(dir, "devpanel.mjs");
    await build({ entryPoints: [resolve(import.meta.dirname, "../../src/ui/client/DevPanel.tsx")], outfile, bundle: true, packages: "external", platform: "node", format: "esm", jsx: "automatic", logLevel: "silent" });
    return await import(pathToFileURL(outfile).href) as typeof import("../../src/ui/client/DevPanel.tsx");
  } finally { await rm(dir, { recursive: true, force: true }); }
})();
const { devPanelApiPath, parseDevPanelPath } = devPanel;

// ---- branch names ----------------------------------------------------------------------------------------------

test("parity2-g4: title slug is lowercase ASCII words, cut at a word boundary", () => {
  strictEqual(titleSlug("Fix the Login page!"), "fix-the-login-page");
  strictEqual(titleSlug("Café déjà vu"), "cafe-deja-vu");
  strictEqual(titleSlug("日本語"), "");
  const long = titleSlug("word ".repeat(40));
  ok(long.length <= 50 && !long.endsWith("-"));
});

test("parity2-g4: git branch name rules (git check-ref-format)", () => {
  for (const good of ["WEB-1-fix", "octocat/WEB-1", "a.b"]) strictEqual(isValidGitBranchName(good), true, good);
  for (const bad of ["", "-x", "/x", "x/", "x.", "a..b", "a b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "a//b", "a@{b", "@", ".x", "x/.y", "x.lock", "x/y.lock"])
    strictEqual(isValidGitBranchName(bad), false, bad);
});

test("parity2-g4: render fills placeholders and drops a missing username or slug cleanly", () => {
  strictEqual(renderBranchName(null, { key: "WEB-12", title: "Fix login" }), "WEB-12-fix-login");
  strictEqual(DEFAULT_BRANCH_TEMPLATE, "{key}-{title-slug}");
  strictEqual(renderBranchName("{username}/{key}-{title-slug}", { key: "WEB-12", title: "Fix login", username: "OctoCat" }), "octocat/WEB-12-fix-login");
  strictEqual(renderBranchName("{username}/{key}-{title-slug}", { key: "WEB-12", title: "Fix login" }), "WEB-12-fix-login");
  strictEqual(renderBranchName("{key}-{title-slug}", { key: "WEB-12", title: "日本語" }), "WEB-12");
  strictEqual(renderBranchName("feature/{key}", { key: "WEB-12", title: "x" }), "feature/WEB-12");
});

test("parity2-g4: template validation", () => {
  deepStrictEqual(validateBranchTemplate("{key}-{title-slug}"), { ok: true });
  deepStrictEqual(validateBranchTemplate("{username}/{key}-{title-slug}"), { ok: true });
  deepStrictEqual(validateBranchTemplate("feature/{key}"), { ok: true });
  const bad: [string, RegExp][] = [
    ["", /empty/], ["{title-slug}", /must contain \{key\}/], ["{key}-{branch}", /Unknown placeholder \{branch\}/],
    ["{key} {title-slug}", /only letters/], ["{key}:x", /only letters/], ["{key}_{title-slug}", /cannot be read back/],
    ["x{key}", /cannot be read back/], ["{key".padEnd(10, "x"), /must contain|only letters/], ["{key}".padEnd(200, "a"), /longer/],
    ["{key}..x", /invalid branch name/],
  ];
  for (const [t, why] of bad) {
    const r = validateBranchTemplate(t);
    strictEqual(r.ok, false, t);
    ok(!r.ok && why.test(r.reason), `${t}: ${!r.ok && r.reason}`);
  }
  deepStrictEqual(branchKeys("octocat/WEB-12-fix"), ["WEB-12"]);
});

test("parity2-g4: the suggested link uses push.ts's key and URL, so the first push takes it over", async () => {
  strictEqual(branchRollupKey(9, "WEB-1-x"), "branch:9:WEB-1-x");
  strictEqual(branchTreeUrl("https://github.com/o/r/", "me/WEB-1"), "https://github.com/o/r/tree/me/WEB-1");
  const pushTs = readFileSync("src/app/push.ts", "utf8");
  ok(pushTs.includes("`branch:${mapping.ghRepoId}:${event.head_branch}`"), "push.ts rollup key unchanged");
  ok(pushTs.includes('/tree/${encodeURIComponent(event.head_branch).replace(/%2F/g, "/")}'), "push.ts URL unchanged");
  const calls: any[] = [];
  const branch = await upsertSuggestedBranchLink(
    { db: {} as any, writer: { upsertRollup: async (t, key, link) => { calls.push({ t, key, link }); return {} as any; }, apply: async () => ({}) as any } },
    { slug: "acme", projectId: "p1", issueId: "i1" },
    { repoId: 9, repoWebUrl: "https://github.com/o/r", template: null, key: "WEB-1", title: "Fix it" });
  strictEqual(branch, "WEB-1-fix-it");
  deepStrictEqual(calls, [{ t: { slug: "acme", projectId: "p1", issueId: "i1" }, key: "branch:9:WEB-1-fix-it",
    link: { title: "[Branch] suggested: WEB-1-fix-it", url: "https://github.com/o/r/tree/WEB-1-fix-it" } }]);
  strictEqual(suggestedBranchTitle("x"), "[Branch] suggested: x");
});

test("parity2-g4: rollup links parse back; PR roll-up is open > merged > declined", () => {
  const links = parseDevLinks([
    { title: "[PR] #3 Add · OPEN · REVIEW", url: "https://github.com/o/r/pull/3" },
    { title: "[PR] #2 Old · MERGED", url: "https://github.com/o/r/pull/2" },
    { title: "[CI] Build · pass", url: "https://github.com/o/r/actions" },
    { title: "[Branch] suggested: WEB-1-x", url: "https://github.com/o/r/tree/WEB-1-x" },
    { title: "[Branch] WEB-1-y", url: "https://github.com/o/r/tree/WEB-1-y" },
    { title: "[Evil] x", url: "https://e.test" }, { title: "[PR] js", url: "javascript:alert(1)" }, { title: "plain", url: "https://x.test" },
  ]);
  deepStrictEqual(links.map((l) => [l.category, l.text, !!l.suggested]), [
    ["PR", "#3 Add · OPEN · REVIEW", false], ["PR", "#2 Old · MERGED", false], ["CI", "Build · pass", false],
    ["Branch", "WEB-1-x", true], ["Branch", "WEB-1-y", false]]);
  const prs = links.filter((l) => l.category === "PR").map(parsePrLink);
  deepStrictEqual(prs.map((p) => [p.title, p.status, p.review]), [["#3 Add", "OPEN", "REVIEW"], ["#2 Old", "MERGED", null]]);
  strictEqual(rollupPrStatus(prs), "OPEN");
  strictEqual(rollupPrStatus(prs.slice(1)), "MERGED");
  strictEqual(rollupPrStatus([]), null);
});

test("parity2-g4: panel path parsing", () => {
  deepStrictEqual(parseDevPanelPath("/git-sync/ui/workspaces/acme/projects/p1/work-items/i1/development"), { slug: "acme", projectId: "p1", issueId: "i1" });
  for (const p of ["/git-sync/ui/workspaces/acme", "/git-sync/ui/workspaces/acme/projects/p1/work-items/i1", "/other/workspaces/acme/projects/p1/work-items/i1/development",
    "/git-sync/ui/workspaces/a%2Fb/projects/p1/work-items/i1/development", "/git-sync/ui/workspaces/acme/projects/p1/work-items/%E0/development"])
    strictEqual(parseDevPanelPath(p), null, p);
  strictEqual(devPanelApiPath({ slug: "acme", projectId: "p1", issueId: "i1" }, "branches"), "/workspaces/acme/projects/p1/work-items/i1/branches");
});

test("parity2-g4: the web fork patch adds the panel iframe to the v1.4.2 work-item sidebar (5 files)", () => {
  const patch = readFileSync("apps/web/git-sync.patch", "utf8");
  const files = [...patch.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]);
  strictEqual(files.length, 5);
  ok(files.includes("apps/web/core/components/issues/issue-detail/sidebar.tsx"));
  const mirror = readFileSync("apps/web/core/components/issues/issue-detail/sidebar.tsx", "utf8");
  ok(mirror.includes("/work-items/${encodeURIComponent(issueId)}/development"));
  ok(mirror.includes('allow="clipboard-write"'));
  ok(parseDevPanelPath("/git-sync/ui/workspaces/acme/projects/p1/work-items/i1/development"), "iframe src shape is the panel route");
});

// ---- endpoints -------------------------------------------------------------------------------------------------

const ORIGIN = "https://tasks.example.test";
const ISSUE = "11111111-1111-1111-1111-111111111111";
const PROJECT = "22222222-2222-2222-2222-222222222222";
const SHA = "a".repeat(40);

interface World { roles: Record<string, number>; hidden: Set<string>; links: unknown[]; gh: { refs: Set<string>; empty: boolean; denied: boolean }; ghCalls: string[]; linked: unknown[] }

async function setup() {
  const db = new PGlite(); await db.waitReady; await migrate(db);
  await db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (7, 'acme')");
  const mapping = (await db.query<{ id: number }>(`INSERT INTO repo_mappings (workspace_slug, gh_repo_id, gh_repo_full_name, plane_project_id, sync_direction, installation_id)
    VALUES ('acme', 555, 'acme/web', $1, 'bidirectional', 7) RETURNING id`, [PROJECT])).rows[0]!.id;
  await db.query("INSERT INTO user_map (workspace_slug, plane_user_id, gh_login, gh_id) VALUES ('acme', 'u-mem', 'octocat', 1)");
  const w: World = { roles: { mem: 15, guest: 5 }, hidden: new Set(), links: [], gh: { refs: new Set(["main"]), empty: false, denied: false }, ghCalls: [], linked: [] };
  const users: Record<string, string> = { mem: "u-mem", guest: "u-guest" };
  const fakePlane = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const cookie = String((init?.headers as Record<string, string>)?.cookie ?? "");
    const sid = /^session-id=(.+)$/.exec(cookie)?.[1] ?? "";
    const json = (s: number, o: unknown) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
    const uid = users[sid];
    if (!uid) return json(401, {});
    const base = `/api/workspaces/acme/projects/${PROJECT}`;
    if (path === "/api/users/me/") return json(200, { id: uid });
    if (path === `${base}/issues/${ISSUE}/`) return w.hidden.has(sid) ? json(403, {}) : json(200, { id: ISSUE, project_id: PROJECT, sequence_id: 12, name: "Fix login" });
    if (path === `${base}/`) return json(200, { id: PROJECT, identifier: "WEB" });
    if (path === `${base}/project-members/me/`) return w.roles[sid] ? json(200, { role: w.roles[sid] }) : json(404, {});
    if (path === `${base}/issues/${ISSUE}/issue-links/`) return json(200, w.links);
    return json(404, {});
  }) as typeof fetch;
  const err = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
  const github = {
    request: async (route: string, p: Record<string, any> = {}) => {
      w.ghCalls.push(route + (p.ref ? ` ${p.ref}` : ""));
      if (w.gh.denied) throw err(403);
      if (route === "GET /repos/{owner}/{repo}") return { data: { id: 555, html_url: "https://github.com/acme/web", default_branch: "main" } };
      if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
        const name = String(p.ref).replace(/^heads\//, "");
        if (w.gh.empty || !w.gh.refs.has(name)) throw err(404);
        return { data: { ref: `refs/heads/${name}`, object: { sha: SHA, type: "commit" } } };
      }
      if (route === "POST /repos/{owner}/{repo}/git/refs") {
        const name = String(p.ref).replace(/^refs\/heads\//, "");
        if (w.gh.refs.has(name)) throw err(422);
        w.gh.refs.add(name);
        return { data: {} };
      }
      throw err(404);
    },
  };
  const routes = createDevPanelRoutes({
    db, planeInternalUrl: "http://plane.internal", publicOrigin: ORIGIN, githubWebOrigin: "https://github.com", fetch: fakePlane,
    githubFor: async (m) => { strictEqual(m.installationId, 7); return github; },
    linkBranch: async (t, m, l) => { w.linked.push({ t, mappingId: m.id, l }); },
  });
  const srv = await startServer({ port: 0, host: "127.0.0.1", routes });
  const api = (method: string, leaf: string, o: { sid?: string; body?: unknown; origin?: string | null; project?: string } = {}) =>
    fetch(`http://127.0.0.1:${srv.port}/git-sync/api/workspaces/acme/projects/${o.project ?? PROJECT}/work-items/${ISSUE}/${leaf}`, {
      method,
      headers: {
        ...(o.sid ? { cookie: `session-id=${o.sid}` } : {}),
        ...(o.origin === null ? {} : { origin: o.origin ?? ORIGIN }),
        ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    });
  return { db, w, mapping, api, async close() { await srv.close(); await db.close(); } };
}

test("parity2-g4: panel data needs a session and a visible item; guests get no Create branch", async () => {
  const h = await setup();
  try {
    strictEqual((await h.api("GET", "development")).status, 401);
    h.w.links = [{ title: "[PR] #3 Add · OPEN · APPROVAL", url: "https://github.com/acme/web/pull/3" }, { title: "[Preview] Vercel", url: "https://x.vercel.app" }];
    const r = await h.api("GET", "development", { sid: "mem" });
    strictEqual(r.status, 200);
    const d = await r.json() as DevPanelData;
    strictEqual(d.key, "WEB-12");
    strictEqual(d.prStatus, "OPEN");
    strictEqual(d.previews.length, 1);
    deepStrictEqual(d.repos, [{ mappingId: h.mapping, repo: "acme/web", branchName: "WEB-12-fix-login", branchUrl: "https://github.com/acme/web/tree/WEB-12-fix-login" }]);
    strictEqual(d.canCreateBranch, true);
    await updateMappingParity(h.db, h.mapping, { branchTemplate: "{username}/{key}-{title-slug}" });
    strictEqual(((await (await h.api("GET", "development", { sid: "mem" })).json()) as DevPanelData).repos[0]!.branchName, "octocat/WEB-12-fix-login");
    const g = (await (await h.api("GET", "development", { sid: "guest" })).json()) as DevPanelData;
    strictEqual(g.canCreateBranch, false);
    strictEqual(g.repos[0]!.branchName, "WEB-12-fix-login", "no linked login: the username part is dropped");
    h.w.hidden.add("guest");
    strictEqual((await h.api("GET", "development", { sid: "guest" })).status, 404, "Plane hides the item: so do we");
    strictEqual((await h.api("GET", "development", { sid: "mem", project: "bad id" })).status, 404);
  } finally { await h.close(); }
});

test("parity2-g4: Create branch: creates from the default branch, is idempotent, and records the link", async () => {
  const h = await setup();
  try {
    let r = await h.api("POST", "branches", { sid: "mem", body: { mappingId: h.mapping } });
    strictEqual(r.status, 201);
    deepStrictEqual(await r.json(), { created: true, branch: "WEB-12-fix-login", url: "https://github.com/acme/web/tree/WEB-12-fix-login" });
    ok(h.w.ghCalls.includes("GET /repos/{owner}/{repo}/git/ref/{ref} heads/main"));
    ok(h.w.ghCalls.includes("POST /repos/{owner}/{repo}/git/refs refs/heads/WEB-12-fix-login"));
    deepStrictEqual(h.w.linked[0], { t: { slug: "acme", projectId: PROJECT, issueId: ISSUE }, mappingId: h.mapping,
      l: { key: "branch:555:WEB-12-fix-login", title: "[Branch] WEB-12-fix-login", url: "https://github.com/acme/web/tree/WEB-12-fix-login" } });
    r = await h.api("POST", "branches", { sid: "mem", body: { mappingId: h.mapping } });
    strictEqual(r.status, 200, "second click: already exists");
    strictEqual(((await r.json()) as { created: boolean }).created, false);
    const audit = (await h.db.query<{ outcome: string }>("SELECT outcome FROM audit_log WHERE kind = 'branch_created' ORDER BY id")).rows;
    deepStrictEqual(audit.map((a) => a.outcome), ["applied", "skipped"]);
  } finally { await h.close(); }
});

test("parity2-g4: Create branch authority and failures", async () => {
  const h = await setup();
  try {
    strictEqual((await h.api("POST", "branches", { sid: "mem", body: { mappingId: h.mapping }, origin: "https://evil.test" })).status, 403, "cross-site refused");
    strictEqual((await h.api("POST", "branches", { sid: "mem", body: { mappingId: h.mapping }, origin: null })).status, 403);
    strictEqual((await h.api("POST", "branches", { sid: "guest", body: { mappingId: h.mapping } })).status, 403, "guest cannot create");
    strictEqual((await h.api("POST", "branches", { body: { mappingId: h.mapping } })).status, 401);
    strictEqual((await h.api("POST", "branches", { sid: "mem", body: { mappingId: "1" } })).status, 400);
    strictEqual((await h.api("POST", "branches", { sid: "mem", body: { mappingId: h.mapping, sha: SHA } })).status, 400, "no caller-chosen base");
    strictEqual((await h.api("POST", "branches", { sid: "mem", body: { mappingId: 9999 } })).status, 404);
    await h.db.query("DELETE FROM workspace_installations");
    strictEqual((await h.api("POST", "branches", { sid: "mem", body: { mappingId: h.mapping } })).status, 404, "installation no longer allow-listed");
    await h.db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (7, 'acme')");
    h.w.gh.empty = true;
    strictEqual((await h.api("POST", "branches", { sid: "mem", body: { mappingId: h.mapping } })).status, 409, "empty repository");
    h.w.gh.empty = false; h.w.gh.denied = true;
    strictEqual((await h.api("POST", "branches", { sid: "mem", body: { mappingId: h.mapping } })).status, 403, "App lacks access");
    strictEqual(h.w.linked.length, 0, "nothing linked on failure");
  } finally { await h.close(); }
});
