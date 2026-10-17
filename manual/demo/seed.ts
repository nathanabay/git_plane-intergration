// Seeds the demo instance through the real HTTP API and the real webhook reducers (see server.ts).
// Every step is idempotent within one process; the database is in memory, so restarting the server resets it.
import { createHash } from "node:crypto";

export const COOKIES = { admin: "session-id=admin", alex: "session-id=alex", sam: "session-id=sam", god: "admin-session-id=god" };

export async function seed(d: any) {
  const base = `http://127.0.0.1:${process.argv[process.argv.indexOf("--port") + 1] || 3199}`;
  const api = async (method: string, path: string, cookie: string, body?: unknown) => {
    const res = await fetch(`${base}/git-sync/api${path}`, { method, redirect: "manual",
      headers: { cookie, origin: "http://plane.example.com", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
  const step = async (label: string, fn: () => Promise<unknown>) => {
    try { const r = await fn(); console.log(`seed ✓ ${label}`); return r; }
    catch (e: any) { console.warn(`seed ✗ ${label}: ${e.message}`); return null; }
  };

  // 1. Instance admin allow-lists the organization's App installation for the workspace (God mode).
  await step("allow-list installation", () => api("PUT", `/instance/installations/${d.INSTALLATION}`, COOKIES.god, { workspaceSlug: d.SLUG, accountLogin: d.REPO.owner }));

  // 1b. Instance admin saves the GitHub App in God mode (secrets are encrypted at rest; blank later = keep).
  await step("save GitHub App (God mode)", () => api("PUT", "/instance/github-app", COOKIES.god, { appId: 1234567, appSlug: "acme-git-sync", clientId: "Iv1.demo0000000000",
    clientSecret: "demo-client-secret", privateKey: d.keyPem, webhookSecret: "demo-webhook-secret", edition: "github" }));

  // 2. Personal GitHub accounts through the real OAuth callback (GitHub's consent is answered by the fake).
  for (const who of ["admin", "alex"] as const) {
    await step(`OAuth link ${who}`, async () => {
      const start = await api("POST", `/workspaces/${d.SLUG}/github/account/connect`, COOKIES[who]);
      const url = new URL(start.url ?? start.location ?? start.authorizeUrl);
      const state = url.searchParams.get("state")!;
      const res = await fetch(`${base}/git-sync/oauth/github/callback?code=demo-code-${d.USERS[who].gh.login}&state=${encodeURIComponent(state)}`, { redirect: "manual", headers: { cookie: COOKIES[who] } });
      const loc = res.headers.get("location") ?? "";
      if (!loc.includes("github=linked")) throw new Error(`callback → ${res.status} ${loc}`);
      return loc;
    });
  }
  // 3. Sam is linked by the workspace admin on the User links page (manual link, checked against GitHub).
  await step("manual user link sam", () => api("PUT", `/workspaces/${d.SLUG}/user-links/${d.USERS.sam.id}`, COOKIES.admin, { githubLogin: d.USERS.sam.gh.login, githubId: d.USERS.sam.gh.id }));

  // 4. Map acme/website ↔ Website (WEB): two-way, Smart Commits, link-back comments, report problems.
  const web = await step("map acme/website → WEB", () => api("POST", `/workspaces/${d.SLUG}/mappings`, COOKIES.admin, {
    ghRepoFullName: d.REPO.full_name, ghRepoId: d.REPO.id, planeProjectId: d.PROJECT.id, syncDirection: "bidirectional",
    smartCommitsEnabled: true, linkbackComments: true, reportProblems: true,
  })) as any;
  const api2 = await step("map acme/public-api → API (GitHub to Plane only)", () => api("POST", `/workspaces/${d.SLUG}/mappings`, COOKIES.admin, {
    ghRepoFullName: "acme/public-api", ghRepoId: 812345679, planeProjectId: d.PROJECT2.id, syncDirection: "github_to_plane",
    smartCommitsEnabled: false, linkbackComments: false, reportProblems: false,
  })) as any;
  const webId = web?.id ?? web?.mapping?.id ?? 1;
  d.mappingIds = { web: webId, api: api2?.id ?? api2?.mapping?.id ?? 2 };

  // 5. Rules: lifecycle table + a branch-aware rule (merge to staging → In QA). Saved twice to create versions.
  const rulesV1 = await step("read default rules", () => api("GET", `/workspaces/${d.SLUG}/mappings/${webId}/rules`, COOKIES.admin));
  d.defaultRules = rulesV1;
  const { compileLifecycleRules, QLL_DEFAULTS } = await import("../../src/github/pr-automation.ts");
  // Version 1: the lifecycle table as shipped (what "Save mapping table" stores). Version 2: plus a branch-aware rule.
  await step("save mapping table (v1)", () => api("PUT", `/workspaces/${d.SLUG}/mappings/${webId}/rules`, COOKIES.admin, { yaml: compileLifecycleRules(QLL_DEFAULTS) }));
  const yaml = compileLifecycleRules({ ...QLL_DEFAULTS, branchRules: [{ baseBranch: "^staging$", lifecycle: "merged", state: "started:In QA" }] });
  d.rulesYaml = yaml;
  await step("save branch-aware rule (v2)", () => api("PUT", `/workspaces/${d.SLUG}/mappings/${webId}/rules`, COOKIES.admin, { yaml }));

  // 6. Conflict policies (keep defaults except Labels: Plane wins, to have something to show).
  await step("save conflict policies", () => api("PUT", `/workspaces/${d.SLUG}/mappings/${webId}/conflict-policies`, COOKIES.admin, { labels: "source_of_truth:plane" }));

  console.log("seed: base configuration done");
  const { scenarioEvents } = await import("./events.ts");
  await scenarioEvents(d, { api, step, COOKIES });
}

export const fakeSha = (s: string) => createHash("sha1").update(s).digest("hex");
