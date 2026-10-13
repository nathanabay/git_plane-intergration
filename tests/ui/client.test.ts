import test from "node:test";
import { strictEqual, deepStrictEqual, throws, doesNotThrow, ok } from "node:assert/strict";
import { mappingHref, parseLocation, workspaceHref } from "../../src/ui/client/router.ts";
import {
  ValidationError, parseConflictPolicies, parseGithubApp, parseMagicWords, parseMappingInput, parseUserLink,
} from "../../src/ui/validate.ts";
import { cookieValue } from "../../src/ui/plane-auth.ts";

test("router: the two entry routes and their sub-routes", () => {
  deepStrictEqual(parseLocation("/git-sync/ui/admin"), { name: "admin" });
  deepStrictEqual(parseLocation("/git-sync/ui/admin/"), { name: "admin" });
  deepStrictEqual(parseLocation("/git-sync/ui/workspaces/acme"), { name: "mappings", slug: "acme" });
  deepStrictEqual(parseLocation("/git-sync/ui/workspaces/acme/users"), { name: "users", slug: "acme" });
  deepStrictEqual(parseLocation("/git-sync/ui/workspaces/acme/audit"), { name: "audit", slug: "acme" });
  deepStrictEqual(parseLocation("/git-sync/ui/workspaces/acme/mappings/4"), { name: "mapping", slug: "acme", id: 4, tab: "settings" });
  deepStrictEqual(parseLocation("/git-sync/ui/workspaces/acme/mappings/4/rules"), { name: "mapping", slug: "acme", id: 4, tab: "rules" });
  deepStrictEqual(parseLocation("/git-sync/ui/workspaces/acme/mappings/4/policies"), { name: "mapping", slug: "acme", id: 4, tab: "policies" });
});

test("router: unknown, foreign and malformed paths are not found", () => {
  for (const p of ["/", "/git-sync/ui/nope", "/git-sync/ui/workspaces", "/git-sync/ui/workspaces/acme/mappings/x",
    "/git-sync/ui/workspaces/acme/mappings/4/other", "/git-sync/uix/admin", "/git-sync/ui/workspaces/%E0%A4%A"]) {
    strictEqual(parseLocation(p).name, "notfound", p);
  }
});

test("router: hrefs round-trip through parseLocation, encoding odd slugs", () => {
  deepStrictEqual(parseLocation(workspaceHref("a b", "audit")), { name: "audit", slug: "a b" });
  deepStrictEqual(parseLocation(mappingHref("acme", 9, "rules")), { name: "mapping", slug: "acme", id: 9, tab: "rules" });
  deepStrictEqual(parseLocation(mappingHref("acme", 9, "settings")), { name: "mapping", slug: "acme", id: 9, tab: "settings" });
});

test("validate: mapping bodies — required on create, partial on patch", () => {
  throws(() => parseMappingInput({}, false), ValidationError);
  throws(() => parseMappingInput({}, true), ValidationError);
  deepStrictEqual(parseMappingInput({ autolinks: true }, true), { autolinks: true });
  doesNotThrow(() => parseMappingInput({ ghRepoId: 1, ghRepoFullName: "a/b", planeProjectId: "p" }, false));
  throws(() => parseMappingInput({ ghRepoId: 1.5, ghRepoFullName: "a/b", planeProjectId: "p" }, false), ValidationError);
  throws(() => parseMappingInput(null, false), ValidationError);
});

test("E2E-1: reportProblems accepts only booleans and keeps omitted fields absent", () => {
  const create = { ghRepoId: 1, ghRepoFullName: "a/b", planeProjectId: "p" };
  for (const reportProblems of [true, false]) {
    deepStrictEqual(parseMappingInput({ ...create, reportProblems }, false), { ...create, reportProblems });
    deepStrictEqual(parseMappingInput({ reportProblems }, true), { reportProblems });
  }
  for (const reportProblems of [null, "true", "false", 0, 1, [], {}]) {
    throws(() => parseMappingInput({ ...create, reportProblems }, false), ValidationError);
    throws(() => parseMappingInput({ reportProblems }, true), ValidationError);
  }
  deepStrictEqual(parseMappingInput(create, false), create);
  deepStrictEqual(parseMappingInput({ linkbackComments: false }, true), { linkbackComments: false });
});

test("validate: conflict policies, user links and GitHub App input", () => {
  deepStrictEqual(parseConflictPolicies({ state: "source_of_truth:plane" }), { state: "source_of_truth:plane" });
  throws(() => parseConflictPolicies({ state: "x" }), ValidationError);
  deepStrictEqual(parseUserLink({ githubLogin: "octo-cat", githubId: 5 }), { githubLogin: "octo-cat", githubId: 5 });
  throws(() => parseUserLink({ githubLogin: "a b", githubId: 5 }), ValidationError);
  throws(() => parseUserLink({ githubLogin: "ok", githubId: 0 }), ValidationError);
  throws(() => parseGithubApp({ appId: 1, privateKey: "x", webhookSecret: "y" }), ValidationError);
  strictEqual(parseGithubApp({ appId: 1, gheBaseUrl: "" }).gheBaseUrl, null);
});

test("validate: magic words are lowercased, trimmed, deduplicated within a tier", () => {
  deepStrictEqual(parseMagicWords({ closing: ["Fix", "fix "], non_closing: ["Part  Of"], relation: ["relates to"] }),
    { closing: ["fix"], non_closing: ["part of"], relation: ["relates to"] });
});

test("cookies: exact name match, RFC 6265 octets only", () => {
  strictEqual(cookieValue("a=1; session-id=abc123; b=2", "session-id"), "abc123");
  strictEqual(cookieValue("admin-session-id=zzz", "session-id"), null);
  strictEqual(cookieValue("session-id=a b", "session-id"), null);
  strictEqual(cookieValue("session-id=\"quoted\"", "session-id"), null);
  strictEqual(cookieValue(undefined, "session-id"), null);
  strictEqual(cookieValue("session-id=", "session-id"), null);
});

test("F11: mapping rules route and default lifecycle mapping round-trip", async () => {
  const { compileLifecycleRules, parseLifecycleMappingFromYaml, QLL_DEFAULTS } = await import("../../src/github/pr-automation.ts");
  const defaultYaml = compileLifecycleRules(QLL_DEFAULTS);
  const parsed = parseLifecycleMappingFromYaml(defaultYaml);
  deepStrictEqual(parsed, QLL_DEFAULTS);
  strictEqual(parseLifecycleMappingFromYaml(""), null);
});

test("F4: buildUi compiles app.tsx including Admin with WorkspaceInstallationsPanel", async () => {
  const { buildUi } = await import("../../src/ui/build.mjs");
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const outdir = mkdtempSync(join(tmpdir(), "ui-build-"));
  try {
    const result = await buildUi(outdir);
    ok(result.js);
    const html = readFileSync(join(outdir, "index.html"), "utf8");
    ok(html.includes("Git sync"));
    ok(html.includes(result.js));
    const jsContent = readFileSync(join(outdir, "assets", result.js), "utf8");
    ok(jsContent.includes("/instance/installations"));
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
});

