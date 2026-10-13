// Regression coverage only; the parity wave forbids executing tests. Node contracts: Context7 /websites/nodejs_latest-v24_x_api.
import test from "node:test";
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { htmlToText, textToHtml } from "../../src/sync/text.ts";
import type { TextContext } from "../../src/sync/text.ts";
import { executeGithubProblemReport, problemReportsEnabled, reportGithubProblem, reportPlaneProblem } from "../../src/github/problems.ts";
import type { GithubProblemReport, ProblemReportDeps } from "../../src/github/problems.ts";
import type { OctokitRequest } from "../../src/github/pr-automation.ts";
import { processPush, PUSH_PAYLOAD_COMMIT_LIMIT } from "../../src/github/smart-commits.ts";
import type { SmartCommitDeps } from "../../src/github/smart-commits.ts";
import { createOrderedOutbox } from "../../src/app/writers.ts";
import { PlaneApiError, PlaneRateLimitError } from "../../src/sync/plane.ts";
import { fakePlaneWriter, freshDb, QLL } from "../github/fakes.ts";
import { handleChecks } from "../../src/app/checks.ts";
import { ghJob, makeHarness, planeJob, sha } from "../a8/harness.ts";
import { intentJob, queue } from "../writers/outbox-fixture.ts";
import { GithubWritePath } from "../../src/sync/github.ts";
import { createOutboundAuthoriser } from "../../src/app/mappings.ts";
import { GithubRateLimitError } from "../../src/github/errors.ts";

const context: TextContext = { webOrigin: "https://git.example", owner: "acme", repo: "web",
  planeUserForGithubLogin: async (login) => login === "alice" ? { id: "plane-alice" } : null,
  githubUserForPlaneId: async (id) => id === "plane-alice" ? { login: "alice", displayName: "Alice" } : { displayName: "Unlinked Person" },
};
const authority = { workspaceSlug: "ws", mappingId: "1", repoId: 555, installationId: 1 };

test("C6: mapped mentions use Plane v1.4.2 attributes; unknown users link to the configured GitHub host", async () => {
  const html = await textToHtml("Hello @alice and @unknown", context);
  ok(html.includes('<mention-component entity_identifier="plane-alice" entity_name="user_mention"></mention-component>'));
  ok(html.includes('<a href="https://git.example/unknown">@unknown</a>'));
  strictEqual(await htmlToText(html, context), "Hello @alice and @unknown");
  strictEqual(await textToHtml(await htmlToText(html, context), context), html, "canonical round trip gives echo hashing identical converted content");
});

test("C6: Plane mentions map to logins or display names; email addresses stay literal and opaque link labels/team mentions stay inert", async () => {
  strictEqual(await htmlToText('<p><mention-component entity_name="user_mention" entity_identifier="plane-alice"></mention-component> / <mention-component entity_name="user_mention" entity_identifier="unlinked"></mention-component></p>', context), "@alice / Unlinked Person");
  const html = await textToHtml("Email alice@example.org or [@alice](https://example.org/profile). Teams @acme/team.", context);
  ok(!html.includes("mention-component"));
  strictEqual(await htmlToText(html, context), "Email alice@example.org or [`@alice`](https://example.org/profile). Teams `@acme/team`.");
});

test("C7: local, qualified and full issue references use the configured origin and canonical labels", async () => {
  const html = await textToHtml("See #12, other/repo#23 and https://git.example/acme/web/issues/34", context);
  for (const [repo, number] of [["acme/web", 12], ["other/repo", 23], ["acme/web", 34]] as const)
    ok(html.includes(`<a href="https://git.example/${repo}/issues/${number}">${repo}#${number}</a>`));
  const canonical = await htmlToText(html, context);
  strictEqual(canonical, "See acme/web#12, other/repo#23 and acme/web#34");
  strictEqual(await textToHtml(canonical, context), html);
  ok(!html.includes("github.com"));
});

for (const [name, markdown] of [
  ["tables", "| Owner | Status |\n| --- | --- |\n| Alice | **Ready** |"],
  ["table alignment and escaped code pipes", "| Code | State |\n| :--- | ---: |\n| `a\\|b` | ready |"],
  ["image alt text", '![Build @alice #12 screenshot](https://cdn.example/image.png "Caption")'],
  ["bare URLs", "Visit https://example.org/path?a=1&b=2 for details."],
  ["bare URL punctuation", "Visit (https://example.org/path?a=1&b=2)."],
  ["soft wraps", "First line\nSecond line\nThird line"],
  ["prose identifiers", "Use snake_case_name, **bold**, and *italic*."],
  ["inline code", "Use `@alice #12` and ``a`b``."],
  ["code blocks and internal blank lines", "```ts\n@alice #12\n\n\nconst html = '<p>literal</p>';\n```"],
  ["nested backtick fences", "````\n```\n@alice #12\n```\n````"],
] as const) {
  test(`C6/C7 fidelity: ${name} survives a Markdown/HTML round trip`, async () => {
    const html = await textToHtml(markdown, context);
    strictEqual(await htmlToText(html, context), markdown);
    strictEqual(await textToHtml(await htmlToText(html, context), context), html);
  });
}

test("C6/C7: code and image alt text never trigger user resolution or issue-link enrichment", async () => {
  let mentions = 0;
  const ctx = { ...context, planeUserForGithubLogin: async () => { mentions++; return { id: "x" }; } };
  const html = await textToHtml("`@alice #12`\n\n```\n@alice #12\n```\n\n![@alice #12](https://cdn.example/a.png)", ctx);
  strictEqual(mentions, 0); ok(!html.includes("mention-component")); ok(!html.includes("/issues/12"));
  const raw = '<pre><code>&lt;mention-component entity_name="user_mention" entity_identifier="x"&gt;@alice #12&lt;/mention-component&gt;\n</code></pre>';
  let reverseLookups = 0;
  await htmlToText(raw, { ...context, githubUserForPlaneId: async () => { reverseLookups++; return { login: "alice" }; } });
  strictEqual(reverseLookups, 0);
});

test("C6/C7 safety: raw HTML and unsafe URLs cannot become active content; attributes/entities round-trip safely", async () => {
  const html = await textToHtml('<script>alert("x")</script> [unsafe](javascript:alert) ![unsafe](data:text/html,bad)', context);
  ok(!html.includes("<script>")); ok(!html.includes('href="javascript:')); ok(!html.includes('src="data:'));
  strictEqual(await htmlToText('<p>Fish &amp; chips &#x1f642;</p><script>private()</script>', context), "Fish & chips 🙂");
  const escaped = await textToHtml('@alice', { ...context, planeUserForGithubLogin: async () => ({ id: 'id" onmouseover="evil' }) });
  ok(escaped.includes('entity_identifier="id&quot; onmouseover=&quot;evil"'));
});

function planned(enabled = true) {
  const calls: { key: string | undefined; steps: any[]; options: any }[] = [];
  const deps: ProblemReportDeps = { enabled, authority, plan: async (key, steps, options) => { calls.push({ key, steps, options }); return { ok: true }; } };
  return { deps, calls };
}
const reportInput = { owner: "acme", repo: "web", key: "unresolved", target: { kind: "issue" as const, number: 12 }, messages: ["Unknown work item QLL-99."] };

test("N2: disabled reports register nothing; enabled reports carry frozen authority and stable content-version keys", async () => {
  const off = planned(false);
  await reportGithubProblem(off.deps, reportInput);
  await reportPlaneProblem(off.deps, { slug: "ws", projectId: "p", issueId: "i" }, { key: "failure", messages: ["failed"] });
  strictEqual(off.calls.length, 0);
  const on = planned();
  await reportGithubProblem(on.deps, reportInput); await reportGithubProblem(on.deps, reportInput);
  strictEqual(on.calls[0]!.key, on.calls[1]!.key); deepStrictEqual(on.calls[0]!.options.authority, authority);
  await reportGithubProblem(on.deps, { ...reportInput, messages: ["Unknown work item QLL-100."] });
  ok(on.calls[0]!.key !== on.calls[2]!.key);
  strictEqual(on.calls[0]!.steps[0].write.key, on.calls[2]!.steps[0].write.key, "versions update one remote comment marker");
  await reportGithubProblem(on.deps, { ...reportInput, target: { number: 12, kind: "issue" } });
  strictEqual(on.calls[0]!.key, on.calls[3]!.key, "object property order does not change identity");
});

test("N2: known Plane target report is a stable service-comment intent and refuses a foreign workspace", async () => {
  const { deps, calls } = planned();
  const target = { slug: "ws", projectId: "p", issueId: "i" };
  await reportPlaneProblem(deps, target, { key: "action:1", messages: ["<unsafe> could not run"] });
  await reportPlaneProblem(deps, target, { key: "action:1", messages: ["<unsafe> could not run"] });
  strictEqual(calls[0]!.key, calls[1]!.key); strictEqual(calls[0]!.steps[0].write.kind, "add_comment");
  ok(typeof calls[0]!.steps[0].write._problemReport.key === "string", "consumer can separate report intents from a failed target lane and avoid recursive reporting");
  await reportPlaneProblem({ ...deps, authority: { installationId: 1, repoId: 555, mappingId: "1", workspaceSlug: "ws" } },
    { issueId: "i", projectId: "p", slug: "ws" }, { key: "action:1", messages: ["<unsafe> could not run"] });
  strictEqual(calls[0]!.key, calls[2]!.key);
  ok(calls[0]!.steps[0].write.commentHtml.includes("&lt;unsafe&gt;"));
  await rejects(reportPlaneProblem(deps, { ...target, slug: "other" }, { key: "x", messages: ["failure"] }), /outside/);
});

for (const target of [{ kind: "commit" as const, sha: sha("a") }, { kind: "issue" as const, number: 12 }]) {
  test(`N2: ${target.kind} report executor recovers a lost POST receipt and edits the same bot comment`, async () => {
    const { deps, calls } = planned();
    await reportGithubProblem(deps, { ...reportInput, target });
    const write = calls[0]!.steps[0].write as GithubProblemReport;
    const comments: any[] = []; const requests: string[] = [];
    const client: OctokitRequest = { request: async (route, params): Promise<any> => {
      requests.push(route);
      if (route.startsWith("GET ")) return { data: comments };
      if (route.startsWith("POST ")) { const comment = { id: 71, body: params?.body, user: { login: "sync[bot]", type: "Bot" } }; comments.push(comment); return { data: comment }; }
      comments[0].body = params?.body; return { data: comments[0] };
    } };
    await executeGithubProblemReport(client, write, "sync[bot]");
    await executeGithubProblemReport(client, write, "sync[bot]");
    await executeGithubProblemReport(client, { ...write, body: write.body.replace("QLL-99", "QLL-100") }, "sync[bot]");
    strictEqual(requests.filter((route) => route.startsWith("POST ")).length, 1);
    strictEqual(requests.filter((route) => route.startsWith("PATCH ")).length, 1);
    ok(requests.includes(target.kind === "commit" ? "PATCH /repos/{owner}/{repo}/comments/{comment_id}" : "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}"));
    strictEqual(comments.length, 1);
  });
}

test("N2: a forged marker by a user or another bot is never edited, and an incomplete list never permits creation", async () => {
  const { deps, calls } = planned(); await reportGithubProblem(deps, reportInput);
  const write = calls[0]!.steps[0].write as GithubProblemReport; const mutations: string[] = [];
  const client: OctokitRequest = { request: async (route): Promise<any> => {
    if (route.startsWith("GET ")) return { data: [{ id: 1, body: write.body, user: { login: "other[bot]", type: "Bot" } }] };
    mutations.push(route); return { data: { id: 2 } };
  } };
  await executeGithubProblemReport(client, write, "sync[bot]");
  strictEqual(mutations.length, 1); ok(mutations[0]!.startsWith("POST "));
  const partial: OctokitRequest = { request: async (): Promise<any> => ({ data: [], headers: { link: '<https://git.example/x?page=2>; rel="next"' } }) };
  await rejects(executeGithubProblemReport(partial, write, "sync[bot]"), /incomplete/);
});

async function smart(over: Partial<SmartCommitDeps> = {}) {
  const db = await freshDb(); const reports: any[] = []; const writer = fakePlaneWriter();
  const deps: SmartCommitDeps = { db, writer, mapping: { workspaceSlug: "ws", smartCommitsEnabled: true, reportProblems: true },
    users: { planeUserIdForGithubLogin: async () => "plane-user" }, vault: { load: async () => null }, requireVerified: false,
    getCommitVerified: async () => true, listStates: async () => QLL, resolveIssue: async () => ({ projectId: "p", issueId: "i" }),
    reportProblem: async (problem) => { reports.push(problem); }, ...over };
  return { db, deps, reports };
}
const pushed = (message: string) => ({ repository: { id: 555 }, sender: { id: 11, login: "alice", type: "User" }, commits: [{ id: sha("a"), message }] });

for (const [name, message, states] of [
  ["missing state", "QLL-1 #nonexistent", QLL],
  ["ambiguous state", "QLL-1 #in", [{ id: "a", name: "In Review", group: "started" }, { id: "b", name: "In Progress", group: "started" }]],
  ["malformed time", "QLL-1 #time soon", QLL],
] as const) {
  test(`N2 Smart Commit: ${name} registers a diagnostic without disclosing API errors/project identifiers`, async () => {
    const { deps, reports } = await smart({ listStates: async () => [...states] });
    await processPush(pushed(message), deps);
    ok(reports.length > 0); strictEqual(reports[0].sha, sha("a"));
    ok(!reports[0].messages.join(" ").includes("in project p"));
    if (name !== "malformed time") deepStrictEqual(reports[0].target, { projectId: "p", issueId: "i" });
  });
}

test("N2 Smart Commit: unsigned commands and truncated pushes are reported at the commit", async () => {
  const unsigned = await smart({ requireVerified: true, getCommitVerified: async () => false });
  await processPush(pushed("QLL-1 #done"), unsigned.deps);
  ok(unsigned.reports[0].messages[0].includes("signature-verified"));
  const truncated = await smart();
  await processPush({ ...pushed("none"), before: sha("b"), after: sha("c"),
    commits: Array.from({ length: PUSH_PAYLOAD_COMMIT_LIMIT }, (_, n) => ({ id: n.toString(16).padStart(40, "0"), message: "none" })) }, truncated.deps);
  strictEqual(truncated.reports[0].sha, sha("c")); ok(truncated.reports[0].messages[0].includes("incomplete"));
});

test("N2 Smart Commit: toggle off emits no diagnostics and transport/API details stay private", async () => {
  const disabled = await smart({ mapping: { workspaceSlug: "ws", smartCommitsEnabled: true, reportProblems: false } });
  await processPush(pushed("QLL-1 #missing"), disabled.deps); strictEqual(disabled.reports.length, 0);
  const hidden = await smart({ writer: fakePlaneWriter({ failOn: () => new PlaneApiError(403, {}, "SECRET backend data") }) });
  await processPush(pushed("QLL-1 #done"), hidden.deps);
  ok(hidden.reports[0].messages[0].includes("Check the sync audit log")); ok(!hidden.reports[0].messages[0].includes("SECRET"));
});

test("N2 Smart Commit: failed report registration retries from retained failure without another command write", async () => {
  let fail = true; const reports: any[] = [];
  const { deps } = await smart({ reportProblem: async (problem) => { if (fail) throw new Error("report registration failed"); reports.push(problem); } });
  await rejects(processPush(pushed("QLL-1 #missing"), deps), /report registration failed/);
  fail = false; await processPush(pushed("QLL-1 #missing"), deps);
  strictEqual(reports.length, 1); ok(reports[0].messages[0].includes("matches no Plane state"));
});

test("N2: the mapping opt-in is read under exact repository/workspace/installation authority", async () => {
  const h = await makeHarness();
  try {
    const mappingId = await h.mapping(); const verified = { ...authority, mappingId: String(mappingId) };
    strictEqual(await problemReportsEnabled(h.db, verified), false);
    await h.db.query("UPDATE repo_mappings SET report_problems = true WHERE id = $1", [mappingId]);
    strictEqual(await problemReportsEnabled(h.db, verified), true);
    strictEqual(await problemReportsEnabled(h.db, { ...verified, workspaceSlug: "other" }), false);
    strictEqual(await problemReportsEnabled(h.db, { ...verified, repoId: 123 }), false);
  } finally { await h.close(); }
});

test("N2: stable Plane failure plan registers once across repeated calls", async () => {
  const db = await freshDb();
  const outbox = createOrderedOutbox({ db, queues: { plane: queue() as any, github: queue() as any }, loadActorToken: async () => null,
    plane: { preflight: async () => {}, apply: async () => ({ ok: true }) }, github: { apply: async () => ({ ok: true }) } });
  const deps = { enabled: true, authority, plan: outbox.plane.plan };
  const target = { slug: "ws", projectId: "p", issueId: "i" };
  await reportPlaneProblem(deps, target, { key: "same-action", messages: ["failed"] });
  await reportPlaneProblem(deps, target, { key: "same-action", messages: ["failed"] });
  strictEqual((await db.query("SELECT 1 FROM outbound_writes")).rows.length, 1);
});

test("N2: failed check-suite automation registers a Plane report on its linked item and honors opt-out", async () => {
  const h = await makeHarness();
  try {
    const id = await h.mapping({ smartCommits: false, rules: "- when: check_suite.success\n  if: { project: p-qll }\n  then: [{ set_state: Nonexistent }]\n" });
    await h.db.query("UPDATE repo_mappings SET report_problems = true WHERE id = $1", [id]);
    await h.link("iss-1", 12, { kind: "pr", tier: "closing" });
    // Multiple PR references are permitted; a mirrored label-sync partner is unique.
    await h.db.query("UPDATE sync_links SET created_by = 'magic_word' WHERE gh_repo_id = 555 AND gh_number = 12");
    await h.link("iss-9", 12, { kind: "pr", project: "p-web", tier: "closing" });
    await h.db.query("UPDATE sync_links SET created_by = 'magic_word' WHERE gh_repo_id = 555 AND gh_number = 12");
    const plans: { key: string | undefined; steps: any[] }[] = [];
    h.ctx.plane.plan = async (key, steps) => { plans.push({ key, steps }); return { ok: true }; };
    h.gh.respond(/pulls\/\{pull_number\}$/, () => ({ number: 12, state: "open", head: { sha: sha("a") }, base: { repo: { id: 555 } } }));
    h.gh.respond(/commits\/\{commit_sha\}\/pulls$/, () => []);
    h.gh.respond(/check-suites$/, () => ({ check_suites: [], total_count: 0 }));
    h.gh.respond(/check-runs$/, () => ({ check_runs: [{ conclusion: "success" }], total_count: 1 }));
    h.gh.respond(/reviews$/, () => []);
    h.gh.respond(/commits\/\{ref\}\/status$/, () => ({ state: "pending", total_count: 0 }));
    const job = ghJob("check_suite", { action: "completed", check_suite: { head_sha: sha("a"), conclusion: "success", pull_requests: [{ number: 12 }] } });
    await handleChecks(h.ctx, job); await handleChecks(h.ctx, job);
    strictEqual(plans.length, 2); strictEqual(plans[0]!.key, plans[1]!.key);
    strictEqual(plans[0]!.steps[0].side, "plane"); strictEqual(plans[0]!.steps[0].write.issueId, "iss-1");
    ok(plans[0]!.steps[0].write.commentHtml.includes("check_suite.success"));
    await h.db.query("UPDATE repo_mappings SET report_problems = false WHERE id = $1", [id]);
    await handleChecks(h.ctx, job); strictEqual(plans.length, 2);
  } finally { await h.close(); }
});

// Context7 /evanw/esbuild: browser builds resolve all imports before tree shaking;
// write:false keeps this regression in memory for the driver's test pass.
test("N2 browser boundary: lifecycle configuration remains bundleable without server report helpers", async () => {
  const { build } = await import("esbuild");
  const bundle = await build({
    stdin: { contents: 'import { QLL_DEFAULTS, compileLifecycleRules } from "../../src/github/pr-automation.ts"; console.log(compileLifecycleRules(QLL_DEFAULTS));',
      resolveDir: import.meta.dirname, sourcefile: "lifecycle-browser.ts", loader: "ts" },
    platform: "browser", bundle: true, format: "esm", write: false, metafile: true, logLevel: "silent",
  });
  ok(bundle.outputFiles.length > 0);
  ok(!Object.keys(bundle.metafile.inputs).some((file) => file.endsWith("github/problems.ts")), "the server-only reporter cannot enter the browser graph");
});

test("C6/C7: the real Plane write path hashes converted HTML so its echo causes zero writes", async () => {
  const h = await makeHarness();
  try {
    await h.mapping({ policies: { description: "last_write_wins" } }); await h.link("iss-1", 7);
    const html = await textToHtml("@alice see #12 and `@alice #12`", context);
    await h.ctx.plane.apply({ kind: "update_issue", slug: "ws", projectId: "p-qll", issueId: "iss-1", fields: { description_html: html } });
    const before = [h.plane.writes().length, h.gh.writes().length];
    strictEqual(await h.feed(planeJob("issue", { action: "update", data: { id: "iss-1", project: "p-qll", description_html: html },
      activity: { field: "description_html", new_value: html, old_value: "", actor: { id: "human-user" } } })), "echo");
    deepStrictEqual([h.plane.writes().length, h.gh.writes().length], before);
  } finally { await h.close(); }
});

test("C6/C7 lexer: unmatched code runs and long prose identifiers preserve all content", async () => {
  const prose = "x".repeat(10000), ticks = "`".repeat(10000);
  strictEqual(await textToHtml(`${prose} ${ticks}`, context), `<p>${prose} ${ticks}</p>`);
});


test("C6: repeated mentions share lookup promises within a conversion without caching another workspace", async () => {
  let forward = 0, reverse = 0;
  const ctx: TextContext = { ...context,
    planeUserForGithubLogin: async () => { forward++; return { id: "plane-alice" }; },
    githubUserForPlaneId: async () => { reverse++; return { login: "alice" }; },
  };
  const html = await textToHtml("@alice and @alice", ctx);
  strictEqual(forward, 1); strictEqual(await htmlToText(html, ctx), "@alice and @alice"); strictEqual(reverse, 1);
  await textToHtml("@alice", { ...ctx, webOrigin: "https://other.example" }); strictEqual(forward, 2);
});


test("N2: report ownership is discovered after the first full comment page before creating anything", async () => {
  const { deps, calls } = planned(); await reportGithubProblem(deps, reportInput);
  const write = calls[0]!.steps[0].write as GithubProblemReport; const pages: number[] = []; const mutations: any[] = [];
  const client: OctokitRequest = { request: async (route, params): Promise<any> => {
    if (route.startsWith("GET ")) {
      pages.push(Number(params?.page));
      return { data: params?.page === 1 ? Array.from({ length: 100 }, (_, n) => ({ id: n + 1, body: "unrelated", user: { login: "human", type: "User" } }))
        : [{ id: 171, body: write.body.replace("QLL-99", "QLL-88"), user: { login: "sync[bot]", type: "Bot" } }] };
    }
    mutations.push({ route, params }); return { data: { id: 171 } };
  } };
  await executeGithubProblemReport(client, write, "sync[bot]");
  deepStrictEqual(pages, [1, 2]); strictEqual(mutations.length, 1);
  strictEqual(mutations[0].route, "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}"); strictEqual(mutations[0].params.comment_id, 171);
});

test("N2 Smart Commit: commit diagnostics aggregate failures but each Plane target receives only its own diagnostic", async () => {
  const { deps, reports } = await smart({ resolveIssue: async (key) => ({ projectId: "p", issueId: key }) });
  await processPush(pushed("QLL-1 #missing\nQLL-2 #missing"), deps);
  strictEqual(reports.length, 2); strictEqual(reports[1].messages.length, 2);
  deepStrictEqual(reports[0].targetMessages, ["QLL-1: #missing matches no Plane state."]);
  deepStrictEqual(reports[1].targetMessages, ["QLL-2: #missing matches no Plane state."]);
});


for (const target of [{ kind: "commit" as const, sha: sha("a") }, { kind: "issue" as const, number: 12 }]) {
  test(`N2 production wiring: ${target.kind} reports traverse the real ordered outbox and installation write path`, async () => {
    const h = await makeHarness();
    try {
      const mappingId = await h.mapping(); const verified = { ...authority, mappingId: String(mappingId) };
      await h.db.query("UPDATE repo_mappings SET report_problems = true WHERE id = $1", [mappingId]);
      await h.db.query("INSERT INTO github_app_config (id, app_id, private_key_v1, webhook_secret_v1, app_slug) VALUES (1, 1, 'opaque', 'opaque', 'sync')");
      const comments: any[] = [];
      h.gh.respond(/^GET .*comments$/, () => comments);
      h.gh.respond(/^POST .*comments$/, (params) => {
        const comment = { id: 171, body: params.body, user: { login: "sync[bot]", type: "Bot" } }; comments.push(comment); return comment;
      });
      h.gh.respond(/^PATCH .*comments\/\{comment_id\}$/, (params) => { comments[0].body = params.body; return comments[0]; });
      let userClients = 0;
      const github = new GithubWritePath({ db: h.db, app: h.ctx.ghClient, userClient: async () => { userClients++; throw new Error("reports must use the App"); } });
      const outbox = createOrderedOutbox({ db: h.db, plane: { preflight: async () => {}, apply: async () => ({ ok: true }) }, github,
        queues: { plane: queue() as any, github: queue() as any }, loadActorToken: async () => null, authoriseWrite: createOutboundAuthoriser(h.db) });
      const deps = { enabled: true, authority: verified, plan: outbox.github.plan };
      // A delayed normal issue write must not hold its failure report in the same lane.
      await outbox.github.plan("blocked-automation", [{ kind: "write", side: "github", write: { kind: "update_issue", installationId: 1, repoId: 555,
        owner: "acme", repo: "web", number: 12, fields: { title: "blocked" } } }], { authority: verified });
      await h.db.query("UPDATE outbound_writes SET retry_at = now() + interval '1 hour' WHERE write->>'kind' = 'update_issue'");
      await reportGithubProblem(deps, { ...reportInput, target }); await reportGithubProblem(deps, { ...reportInput, target });
      strictEqual((await h.db.query("SELECT 1 FROM outbound_writes WHERE write->>'kind' = 'problem_report'")).rows.length, 1);
      strictEqual(h.gh.writes().length, 0, "reducers only register intents");
      const initial = await intentJob(h.db); await outbox.executeGithub(initial); await outbox.executeGithub(initial);
      strictEqual(comments.length, 1); strictEqual(h.gh.writes().length, 1);
      if (target.kind === "issue") strictEqual(await h.feed(ghJob("issue_comment", { action: "created", issue: { number: 12 },
        comment: { id: 171, body: comments[0].body, user: comments[0].user } })), "echo");
      await reportGithubProblem(deps, { ...reportInput, target, messages: ["Unknown work item QLL-100."] });
      const update = await intentJob(h.db); strictEqual(update.data._gitsync.targetKey, initial.data._gitsync.targetKey);
      await outbox.executeGithub(update);
      strictEqual(comments.length, 1); strictEqual(h.gh.writes().length, 2);
      if (target.kind === "issue") strictEqual(await h.feed(ghJob("issue_comment", { action: "edited", issue: { number: 12 },
        comment: { id: 171, body: comments[0].body, user: comments[0].user } })), "echo");
      // Even unexpected attribution metadata cannot switch a report to a linked user's client.
      await github.apply(Object.assign({}, update.data, { asUser: "linked-user" })); strictEqual(userClients, 0);
      strictEqual((await h.db.query<{ status: string }>("SELECT status FROM outbound_writes WHERE write->>'kind' = 'update_issue'")).rows[0]!.status, "pending");
    } finally { await h.close(); }
  });
}

test("N2 production wiring: a Plane notice uses its report lane while the automation target is delayed", async () => {
  const db = await freshDb(); const applied: any[] = [];
  await db.query("INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (1, 'ws')");
  await db.query("INSERT INTO repo_mappings (id, workspace_slug, gh_repo_id, gh_repo_full_name, plane_project_id, sync_direction, installation_id, report_problems) VALUES (1, 'ws', 555, 'acme/web', 'p', 'bidirectional', 1, true)");
  const outbox = createOrderedOutbox({ db, plane: { preflight: async () => {}, apply: async (write) => { applied.push(write); return { ok: true, id: "notice" }; } },
    github: { apply: async () => ({ ok: true }) }, queues: { plane: queue() as any, github: queue() as any }, loadActorToken: async () => null });
  const target = { slug: "ws", projectId: "p", issueId: "i" };
  await outbox.plane.plan("blocked-plane-action", [{ kind: "write", side: "plane", write: { kind: "update_issue", ...target, fields: { name: "blocked" } } }], { authority, target });
  await db.query("UPDATE outbound_writes SET retry_at = now() + interval '1 hour'");
  await reportPlaneProblem({ enabled: true, authority, plan: outbox.plane.plan }, target, { key: "failed-action", messages: ["failed"] });
  await outbox.executePlane(await intentJob(db));
  strictEqual(applied.length, 1); strictEqual(applied[0].kind, "add_comment");
  ok(!("_problemReport" in applied[0]), "internal report metadata is consumed before the API write");
});

test("N2 production wiring: report mutations preserve rate-limit deadlines and remove unsuccessful echo reservations", async () => {
  const db = await freshDb(); const { deps, calls } = planned(); await reportGithubProblem(deps, reportInput);
  const write = calls[0]!.steps[0].write as GithubProblemReport;
  // Installation cooldowns intentionally survive client recreation; isolate this fixture.
  write.installationId = 429;
  const client = { request: async (route: string): Promise<any> => {
    if (route.startsWith("GET ")) return { data: [], status: 200, headers: {} };
    throw Object.assign(new Error("rate limited"), { status: 429, response: { status: 429, headers: { "retry-after": "60" } } });
  } };
  const github = new GithubWritePath({ db, app: { installationOctokit: async () => client }, problemReportBotLogin: async () => "sync[bot]" });
  await rejects(github.apply(write), (error: unknown) => error instanceof GithubRateLimitError && error.retryAt > Date.now());
  strictEqual((await db.query("SELECT 1 FROM applied_ops")).rows.length, 0);
});

test("N2 production wiring: authenticated App metadata owns reports even when the stored App slug is stale", async () => {
  const db = await freshDb(); const { deps, calls } = planned(); await reportGithubProblem(deps, reportInput);
  const write = calls[0]!.steps[0].write as GithubProblemReport;
  await db.query("INSERT INTO github_app_config (id, app_id, private_key_v1, webhook_secret_v1, app_slug) VALUES (1, 1, 'opaque', 'opaque', 'stale-app')");
  const requests: string[] = [];
  const client = { auth: async () => { throw new Error("Octokit's route hook supplies authentication"); }, request: async (route: string): Promise<any> => {
    requests.push(route);
    if (route === "GET /app") return { data: { slug: "current-app" }, status: 200, headers: {} };
    if (route.startsWith("GET ")) return { data: [{ id: 71, body: write.body, user: { login: "stale-app[bot]", type: "Bot" } }], status: 200, headers: {} };
    return { data: { id: 72 }, status: 201, headers: {} };
  } };
  const github = new GithubWritePath({ db, app: { installationOctokit: async () => client } });
  await github.apply(write);
  strictEqual(requests[0], "GET /app"); strictEqual(requests.at(-1), "POST /repos/{owner}/{repo}/issues/{issue_number}/comments");
  ok(!requests.some((route) => route.startsWith("PATCH ")), "the marker of a different App cannot establish report ownership");
});


test("Guidance injection: literal Plane text, split-node @ tokens and unlinked names cannot manufacture mentions or Markdown", async () => {
  const html = '<p>[open](https://outside.example) &lt;img src="https://outside.example/pixel"&gt; @victim</p>';
  const markdown = await htmlToText(html, context);
  ok(markdown.includes("\\[open\\]")); ok(markdown.includes("`@victim`")); ok(markdown.includes("\\<img"));
  let lookups = 0;
  const roundtrip = await textToHtml(markdown, { ...context, planeUserForGithubLogin: async () => { lookups++; return { id: "victim" }; } });
  strictEqual(lookups, 0); ok(!roundtrip.includes("<img ")); ok(!roundtrip.includes("mention-component"));
  const split = await htmlToText('<p>@<span>victim</span> <span>@</span><span>other</span></p>', context);
  await textToHtml(split, { ...context, planeUserForGithubLogin: async () => { lookups++; return { id: "victim" }; } }); strictEqual(lookups, 0);
  const unlinked = await htmlToText('<mention-component entity_name="user_mention" entity_identifier="unlinked"></mention-component>',
    { ...context, githubUserForPlaneId: async () => ({ displayName: '@victim [open](https://outside.example)' }) });
  ok(unlinked.includes("`@victim`")); ok(unlinked.includes("\\[open\\]"));
  strictEqual(await htmlToText('<p><mention-component entity_name="user_mention" entity_identifier="plane-alice"></mention-component></p>', context), "@alice");
});

test("Guidance injection: link destinations, titles and image labels cannot escape their Markdown context", async () => {
  const html = '<p><a href="https://safe.example/path)[open](https://outside.example" title="&quot; ) @victim">Read [label]</a>'
    + '<img src="https://safe.example/image)[open](https://outside.example" alt="alt \\](@victim)"></p>';
  const markdown = await htmlToText(html, context);
  ok(markdown.includes("%29%5Bopen%5D%28https://outside.example"));
  let lookups = 0;
  const converted = await textToHtml(markdown, { ...context, planeUserForGithubLogin: async () => { lookups++; return null; } });
  strictEqual(lookups, 0); ok(!converted.includes('href="https://outside.example')); ok(!converted.includes('src="https://outside.example'));
  ok(!converted.includes("mention-component"));
});

test("Guidance injection: unsafe link and image labels stay opaque even when their destinations are refused", async () => {
  let lookups = 0;
  const html = await textToHtml('![@victim](data:text/plain,bad) [@victim](javascript:bad)', { ...context,
    planeUserForGithubLogin: async () => { lookups++; return { id: "victim" }; } });
  strictEqual(lookups, 0); ok(!html.includes("mention-component")); ok(!html.includes("<img ")); ok(!html.includes("<a "));
});

test("Guidance availability: source, depth, parse work, output and lookup fan-out are bounded", async () => {
  await rejects(textToHtml("x".repeat(256001), context), /conversion.*limit/);
  await rejects(htmlToText("x".repeat(256001), context), /conversion.*limit/);
  await rejects(htmlToText("<div>".repeat(60) + "x" + "</div>".repeat(60), context), /conversion.*limit/);
  await rejects(textToHtml(">".repeat(60) + " text", context), /conversion.*limit/);
  await rejects(textToHtml("[".repeat(1500) + "missing destination", context), /conversion.*limit/);
  await rejects(textToHtml('"'.repeat(210000), context), /conversion.*limit/);
  let lookups = 0;
  await rejects(textToHtml(Array.from({ length: 129 }, (_, n) => `@user${n}`).join(" "), { ...context,
    planeUserForGithubLogin: async () => { lookups++; return null; } }), /conversion.*limit/);
  strictEqual(lookups, 128);
  // A small previously ambiguous regex input remains literal without invoking enrichment.
  const escaped = "[" + "\\".repeat(100) + "x";
  ok((await textToHtml(escaped, context)).startsWith("<p>"));
});

test("Guidance injection: N2 diagnostics use opaque code and embedded markers do not claim another bot comment", async () => {
  const { deps, calls } = planned();
  const malicious = '@victim **text** [open](https://outside.example) <mention-component entity_name="user_mention" entity_identifier="victim"></mention-component> `code`';
  await reportGithubProblem(deps, { ...reportInput, messages: [malicious] });
  const write = calls[0]!.steps[0].write as GithubProblemReport;
  let lookups = 0;
  const html = await textToHtml(write.body, { ...context, planeUserForGithubLogin: async () => { lookups++; return { id: "victim" }; } });
  strictEqual(lookups, 0); ok(!html.includes("<mention-component")); ok(!html.includes('href="https://outside.example'));
  await reportPlaneProblem(deps, { slug: "ws", projectId: "p", issueId: "i" }, { key: "diagnostic", messages: [malicious] });
  const planeBody = calls[1]!.steps[0].write.commentHtml as string; ok(planeBody.includes("<code>")); ok(!planeBody.includes("<mention-component"));
  const mutations: string[] = [];
  const client: OctokitRequest = { request: async (route): Promise<any> => {
    if (route.startsWith("GET ")) return { data: [{ id: 71, user: { login: "sync[bot]", type: "Bot" }, body: write.body + "\nUnrelated footer." }] };
    mutations.push(route); return { data: { id: 72 } };
  } };
  await executeGithubProblemReport(client, write, "sync[bot]"); strictEqual(mutations[0], "POST /repos/{owner}/{repo}/issues/{issue_number}/comments");
});

test("Guidance availability and schema: report bodies and identities are bounded before registration or API mutation", async () => {
  const { deps, calls } = planned();
  await reportGithubProblem(deps, { ...reportInput, messages: Array.from({ length: 1000 }, (_, n) => `failure ${n}: ` + "x".repeat(600)) });
  const write = calls[0]!.steps[0].write as GithubProblemReport;
  ok(write.body.length <= 32000); ok(write.body.includes("Additional failures"));
  await rejects(reportGithubProblem(deps, { ...reportInput, target: { kind: "unknown", number: 12 } as any }), /invalid/);
  await rejects(reportGithubProblem(deps, { ...reportInput, key: "x".repeat(4097) }), /invalid/);
  await rejects(reportGithubProblem(deps, { ...reportInput, messages: Array.from({ length: 50 }, (_, n) => "`".repeat(495) + String(n)) }), /size limit/);
  let reads = 0;
  const client: OctokitRequest = { request: async (): Promise<any> => { reads++; return { data: [] }; } };
  await rejects(executeGithubProblemReport(client, { ...write, target: { kind: "unknown" } } as any, "sync[bot]"), /invalid/);
  await rejects(executeGithubProblemReport(client, { ...write, body: write.body + "x" }, "sync[bot]"), /invalid/);
  await rejects(executeGithubProblemReport(client, { ...write, installationId: 0 }, "sync[bot]"), /invalid/);
  await rejects(executeGithubProblemReport(client, { ...write, owner: "../outside" }, "sync[bot]"), /invalid/);
  strictEqual(reads, 0);
});

test("Guidance availability: Smart Commit notices coalesce multiple failures against one item", async () => {
  const { deps, reports } = await smart();
  await processPush(pushed(Array.from({ length: 60 }, (_, n) => `QLL-1 #missing${n}`).join("\n")), deps);
  strictEqual(reports.length, 1); deepStrictEqual(reports[0].target, { projectId: "p", issueId: "i" });
  ok(reports[0].messages.length <= 51); ok(reports[0].messages.includes("Additional failures are recorded in the sync audit log."));
});

test("Guidance messaging: a failed notice never erases the latest pending Plane retry deadline", async () => {
  const retryAt = Date.now() + 120000;
  const { deps } = await smart({ writer: fakePlaneWriter({ failOn: () => new PlaneRateLimitError(retryAt, { requestMade: false }) }),
    reportProblem: async () => { throw new Error("notice registration failed"); } });
  await rejects(processPush(pushed("QLL-1 #done\nQLL-1 #missing"), deps), (error: unknown) =>
    error instanceof PlaneRateLimitError && error.retryAt === retryAt && error.requestMade === false);
});

for (const side of ["github", "plane"] as const) {
  test(`Guidance messaging: ${side} report intent honors mapping opt-out after durable registration`, async () => {
    const h = await makeHarness();
    try {
      const id = await h.mapping(); const verified = { ...authority, mappingId: String(id) };
      await h.db.query("UPDATE repo_mappings SET report_problems = true WHERE id = $1", [id]);
      let planeWrites = 0;
      const outbox = createOrderedOutbox({ db: h.db, github: h.ctx.github,
        plane: { preflight: async () => {}, apply: async () => { planeWrites++; return { ok: true }; } },
        authoriseWrite: createOutboundAuthoriser(h.db), queues: { github: queue() as any, plane: queue() as any }, loadActorToken: async () => null });
      if (side === "github") await reportGithubProblem({ enabled: true, authority: verified, plan: outbox.github.plan }, reportInput);
      else await reportPlaneProblem({ enabled: true, authority: verified, plan: outbox.plane.plan }, { slug: "ws", projectId: "p-qll", issueId: "iss-1" }, { key: "failure", messages: ["failed"] });
      const job = await intentJob(h.db);
      await h.db.query("UPDATE repo_mappings SET report_problems = false WHERE id = $1", [id]);
      if (side === "github") await outbox.executeGithub(job); else await outbox.executePlane(job);
      strictEqual(h.gh.calls.length, 0); strictEqual(planeWrites, 0);
      strictEqual((await h.db.query<{ status: string }>("SELECT status FROM outbound_writes WHERE id = $1", [job.id])).rows[0]!.status, "applied");
    } finally { await h.close(); }
  });
}


test("Guidance injection: literal entity text stays literal and table pipes respect escaped-backslash parity", async () => {
  const html = "<p>&amp;lt;script&amp;gt;</p>";
  strictEqual(await textToHtml(await htmlToText(html, context), context), html);
  const table = '<table><thead><tr><th>Text</th></tr></thead><tbody><tr><td>a\\|b</td></tr></tbody></table>';
  const markdown = await htmlToText(table, context);
  const converted = await textToHtml(markdown, context);
  ok(converted.includes('<td>a\\|b</td>')); strictEqual(converted.match(/<td>/g)?.length, 1);
});


test("Guidance disclosure: an unlinked repository sender receives no Plane key-existence or state-match oracle", async () => {
  const missing = await smart({ users: { planeUserIdForGithubLogin: async () => null }, resolveIssue: async () => null });
  const existing = await smart({ users: { planeUserIdForGithubLogin: async () => null } });
  await processPush(pushed("QLL-1 #missing"), missing.deps); await processPush(pushed("QLL-1 #missing"), existing.deps);
  deepStrictEqual(missing.reports[0].messages, existing.reports[0].messages);
  ok(!existing.reports[0].messages.join(" ").includes("matches no Plane state"));
  deepStrictEqual(existing.reports[0].targetMessages, ["QLL-1: #missing matches no Plane state."]);
});


test("Guidance availability: a rejected long fence info string cannot trigger overlapping-quantifier backtracking", async () => {
  const source = "~".repeat(1500) + "`";
  ok((await textToHtml(source, context)).startsWith("<p>"));
});

test("Guidance messaging: a reporting target limit cannot replace an earlier pending Plane rate deadline", async () => {
  const retryAt = Date.now() + 120000;
  const { deps, reports } = await smart({ resolveIssue: async (key) => ({ projectId: "p", issueId: key }),
    writer: fakePlaneWriter({ failOn: () => new PlaneRateLimitError(retryAt, { requestMade: false }) }) });
  const message = "QLL-1 #done\n" + Array.from({ length: 257 }, (_, n) => `QLL-${n + 1} #missing`).join("\n");
  await rejects(processPush(pushed(message), deps), (error: unknown) => error instanceof PlaneRateLimitError && error.retryAt === retryAt);
  strictEqual(reports.length, 256);
});


test("Guidance messaging: a copied SHA in another mapped repository cannot republish the original repository's private failures", async () => {
  const original = await smart({ authority });
  await processPush(pushed("QLL-1 #missing"), original.deps); strictEqual(original.reports.length, 1);
  const copied: any[] = [];
  const foreign: SmartCommitDeps = { ...original.deps, authority: { ...authority, mappingId: "2", repoId: 556 },
    reportProblem: async (problem) => { copied.push(problem); }, resolveIssue: async () => { throw new Error("completed historical command must not be re-resolved"); } };
  await processPush({ ...pushed("QLL-1 #missing"), repository: { id: 556 } }, foreign);
  strictEqual(copied.length, 0);
});


test("Guidance injection: adjacent generated code spans cannot merge delimiters and expose a literal mention", async () => {
  let lookups = 0;
  const ctx = { ...context, planeUserForGithubLogin: async () => { lookups++; return { id: "victim" }; } };
  for (const html of ['<p><code>``</code>@victim</p>', '<p><code></code>@victim</p>', '<p><code>`</code><span>@victim</span></p>']) {
    const markdown = await htmlToText(html, context);
    const converted = await textToHtml(markdown, ctx);
    ok(!converted.includes("mention-component"));
  }
  strictEqual(lookups, 0);
});
