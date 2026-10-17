// Local demo instance of git-sync for the user manual's screenshots.
//
// It runs the REAL service code — composeRoutes() (config API, Development panel API, static UI) and the real
// reducers/write paths (createRouter + processInbound) — on a throwaway in-memory PGlite database. Only the two
// network edges are fakes: a small in-memory Plane (session endpoints for the UI, /api/v1 for the service) and an
// in-memory GitHub behind a fake Octokit. Nothing here talks to a real Plane, a real GitHub, or any container.
//
//   node manual/demo/server.ts [--port 3199]
//
// Browser: map plane.example.com to this port (Chromium --host-resolver-rules) and set the cookies below.
//   session-id=alex | sam | admin      (Plane web session of a workspace member / member / workspace admin)
//   admin-session-id=god               (Plane God mode session of the instance admin)
// Control (loopback only): POST /__demo/sql {sql, params}, POST /__demo/feed {source, event, payload},
//   GET /__demo/world, POST /__demo/plane-item {key, patch}.
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { createOrderedOutbox } from "../../src/app/writers.ts";
import { createOutboundAuthoriser } from "../../src/app/mappings.ts";
import { planeItemsPath } from "../../src/sync/plane.ts";
import { handleMirroredIssue, handlePendingMirroredIssue } from "../../src/app/issues.ts";
import { handleCreatedPr } from "../../src/app/pr.ts";
import { randomBytes, randomUUID, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { SecretString, encryptSecret } from "../../src/auth/identity.ts";
import type { AppContext } from "../../src/app/context.ts";
import { createVault } from "../../src/app/context.ts";
import { composeRoutes } from "../../src/app/main.ts";
import { createCredentialSource } from "../../src/app/credentials.ts";
import { createRouter, inboundHandler } from "../../src/app/reducers.ts";
import { processInbound } from "../../src/queue/workers.ts";
import type { InboundJob } from "../../src/queue/index.ts";
import { migrate } from "../../src/db/migrate.ts";
import { GithubWritePath } from "../../src/sync/github.ts";
import { PlaneClient, PlaneWritePath } from "../../src/sync/plane.ts";
import { startServer } from "../../src/index.ts";

const PORT = Number(process.argv[process.argv.indexOf("--port") + 1] || 3199);
export const ORIGIN = "http://plane.example.com";
export const SLUG = "acme";
export const WS_ID = "5d1f6a0e-7f3b-4b8e-9a51-1c2d3e4f5a60";
export const PROJECT = { id: "bb57e81d-c161-441f-b50e-907af28f08c2", identifier: "WEB", name: "Website" };
export const PROJECT3 = { id: "4d5e6f70-8192-4a3b-8c4d-5e6f708192a3", identifier: "DES", name: "Design system" };
export const PROJECT2 = { id: "0c4b7a52-31d8-4f0e-8d6c-9e2a1b3c4d5e", identifier: "API", name: "Public API" };
export const REPO = { id: 812345678, owner: "acme", name: "website", full_name: "acme/website", default_branch: "main" };
export const INSTALLATION = 51234567;

// ---- people --------------------------------------------------------------------------------------------------
export const USERS = {
  admin: { id: "a1d2e3f4-0000-4000-8000-000000000001", email: "jordan.admin@example.com", display_name: "jordan", first_name: "Jordan", last_name: "Admin", role: 20, gh: { login: "jordan-acme", id: 7100001 } },
  alex: { id: "6a57833d-4e43-49be-924c-f093cddfae76", email: "alex.developer@example.com", display_name: "alex", first_name: "Alex", last_name: "Developer", role: 15, gh: { login: "alex-dev", id: 7100002 } },
  sam: { id: "2f526b2d-ac50-4798-a13f-962b9e5dba94", email: "sam.reviewer@example.com", display_name: "sam", first_name: "Sam", last_name: "Reviewer", role: 15, gh: { login: "sam-reviews", id: 7100003 } },
  riley: { id: "c3d4e5f6-0000-4000-8000-000000000004", email: "riley.new@example.com", display_name: "riley", first_name: "Riley", last_name: "New", role: 15, gh: { login: "riley-codes", id: 7100004 } },
  bot: { id: "b0b0b0b0-0000-4000-8000-0000000000b0", email: "git-sync-bot@example.com", display_name: "git-sync", first_name: "git-sync", last_name: "bot", role: 20, gh: null },
} as const;
const SESSIONS: Record<string, keyof typeof USERS> = { admin: "admin", alex: "alex", sam: "sam", riley: "riley" };
export const BETA = { slug: "beta", id: "6e2f7b1f-8a4c-4c9f-9b62-2d3e4f5a6b70", name: "Beta Labs" };

// ---- the fake Plane ------------------------------------------------------------------------------------------
const STATES = [
  { id: "7a0e0001-0000-4000-8000-000000000001", name: "Backlog", group: "backlog", default: true, color: "#a3a3a3", sequence: 1 },
  { id: "7a0e0002-0000-4000-8000-000000000002", name: "Todo", group: "unstarted", color: "#3f76ff", sequence: 2 },
  { id: "7a0e0003-0000-4000-8000-000000000003", name: "In Progress", group: "started", color: "#f59e0b", sequence: 3 },
  { id: "7a0e0004-0000-4000-8000-000000000004", name: "In Review", group: "started", color: "#8b5cf6", sequence: 4 },
  { id: "7a0e0007-0000-4000-8000-000000000007", name: "In QA", group: "started", color: "#0ea5e9", sequence: 5 },
  { id: "7a0e0005-0000-4000-8000-000000000005", name: "Done", group: "completed", color: "#16a34a", sequence: 6 },
  { id: "7a0e0006-0000-4000-8000-000000000006", name: "Cancelled", group: "cancelled", color: "#ef4444", sequence: 7 },
  { id: "7a0e0008-0000-4000-8000-000000000008", name: "Triage", group: "triage", color: "#64748b", sequence: 8 },
];
export const stateByName = (n: string) => STATES.find((s) => s.name === n)!;
const LABELS = ["frontend", "bug", "accessibility", "documentation", "github", "plane", "backend"].map((name, i) => ({ id: `1abe1000-0000-4000-8000-00000000000${i}`, name, color: "#6b7280" }));

const TITLES: Record<number, string> = {
  1: "Set up the website repository", 2: "Add the company logo to the header", 3: "Write the privacy policy page",
  5: "Fix broken link in the footer", 8: "Compress hero images", 12: "Add a cookie consent banner",
  20: "Translate the pricing page", 30: "Show delivery estimate on product page", 31: "Remember the cart between visits",
  32: "Add order summary to checkout", 33: "Validate postcode before payment", 34: "Show card errors next to the field",
  35: "Support Apple Pay on checkout", 36: "Add a guest checkout option", 37: "Fix total rounding on discounted items",
  38: "Improve the empty-cart message", 39: "Speed up the checkout page", 40: "Increase tap target size of quantity buttons",
  41: "Keep focus visible on checkout controls", 42: "Make the checkout button visible on small screens", 43: "Checkout label wraps on a narrow screen",
  44: "Add rate limiting to the login form", 45: "Document the release checklist",
};
interface PItem { id: string; project: string; sequence_id: number; name: string; description_html: string; state: string; labels: string[]; assignees: string[]; priority: string;
  external_source?: string; external_id?: string; updated_at: string; created_at: string; archived_at?: string | null }
const items = new Map<string, PItem>();
const comments = new Map<string, any[]>();
const links = new Map<string, any[]>();
let clock = Date.parse("2026-10-13T08:00:00Z");
const tick = (mins = 3) => new Date((clock += mins * 60000)).toISOString();
function addItem(project: { id: string }, seq: number, name: string, state = "Todo", extra: Partial<PItem> = {}): PItem {
  const it: PItem = { id: randomUUID(), project: project.id, sequence_id: seq, name, description_html: `<p>${name}.</p>`, state: stateByName(state).id, labels: [], assignees: [], priority: "medium", updated_at: tick(1), created_at: tick(0), ...extra };
  items.set(it.id, it);
  return it;
}
for (let n = 1; n <= 45; n++) {
  if (n === 43) continue; // WEB-43 is a pending intake request in the handbook data
  addItem(PROJECT, n, TITLES[n] ?? `Website task ${n}`, n < 20 ? "Done" : n < 30 ? "Backlog" : "Todo",
    n === 42 ? { assignees: [USERS.alex.id], labels: [LABELS[0]!.id, LABELS[2]!.id], priority: "high", description_html: "<p>On phones narrower than 375 px the <strong>Place order</strong> button is pushed below the fold.</p><h3>Acceptance criteria</h3><ul><li>Button visible at 320, 375 and 390 px</li><li>Focus indicator visible</li></ul>" } : {});
}
addItem(PROJECT2, 1, "Publish the OpenAPI document", "Todo");
addItem(PROJECT3, 7, "Define the colour tokens", "In Progress", { assignees: ["6a57833d-4e43-49be-924c-f093cddfae76"] });
let nextSeq = 46;
export const itemByKey = (key: string) => {
  const [ident, seq] = key.split("-");
  const pid = ident === PROJECT.identifier ? PROJECT.id : ident === PROJECT2.identifier ? PROJECT2.id : ident === PROJECT3.identifier ? PROJECT3.id : "";
  return [...items.values()].find((i) => i.project === pid && i.sequence_id === Number(seq));
};
const keyOf = (it: PItem) => `${projectById(it.project)?.identifier}-${it.sequence_id}`;
const projectById = (id: string) => [PROJECT, PROJECT2, PROJECT3].find((p) => p.id === id) ?? null;
const memberRow = (u: (typeof USERS)[keyof typeof USERS]) => ({ id: u.id, member: { id: u.id, display_name: u.display_name, first_name: u.first_name, last_name: u.last_name, email: u.email, avatar: "" },
  display_name: u.display_name, first_name: u.first_name, last_name: u.last_name, email: u.email, role: u.role });

/** Switches the capture script flips to produce failure states through the real code paths (POST /__demo/flags). */
export const flags = { failPlaneWrites: 0, githubRateLimited: false, appEvents: null as string[] | null };
export const planeLog: { method: string; path: string; body: any }[] = [];
const page = (rows: unknown[]) => ({ results: rows, next_cursor: null, next_page_results: false, total_count: rows.length });
const withLabels = (it: PItem) => ({ ...it, project_id: it.project, state_id: it.state, label_ids: it.labels, assignee_ids: it.assignees, state_detail: STATES.find((s) => s.id === it.state) });

function planeV1(method: string, path: string, q: URLSearchParams, body: any): [number, unknown] {
  let m: RegExpExecArray | null;
  if (path.startsWith(`/workspaces/${BETA.slug}/`)) {
    if (method === "GET" && /\/projects\/$/.test(path)) return [200, page([{ id: "9a8b7c6d-0000-4000-8000-0000000000be", identifier: "MOB", name: "Mobile app" }])];
    if (method === "GET" && /\/(members|members-lite)\/$/.test(path)) return [200, [memberRow(USERS.admin)]];
    if (method === "GET" && /\/states\/$/.test(path)) return [200, page(STATES)];
  }
  const ws = `^/workspaces/${SLUG}/`;
  if (method === "GET" && new RegExp(`${ws}projects/$`).test(path)) return [200, page([PROJECT, PROJECT2, PROJECT3])];
  if (method === "GET" && (m = new RegExp(`${ws}projects/([^/]+)/$`).exec(path))) { const p = projectById(m[1]!); return p ? [200, p] : [404, { error: "Not found" }]; }
  if (method === "GET" && new RegExp(`${ws}projects/[^/]+/states/$`).test(path)) return [200, page(STATES)];
  if (method === "GET" && new RegExp(`${ws}projects/[^/]+/labels/$`).test(path)) return [200, page(LABELS)];
  if (method === "POST" && new RegExp(`${ws}projects/[^/]+/labels/$`).test(path)) {
    const ex = LABELS.find((l) => l.name === body?.name); if (ex) return [409, ex];
    const l = { id: randomUUID(), name: String(body?.name), color: "#6b7280" }; LABELS.push(l); return [201, l];
  }
  if (method === "GET" && new RegExp(`${ws}(members|members-lite)/$`).test(path)) return [200, Object.values(USERS).map(memberRow)];
  if (method === "GET" && (m = new RegExp(`${ws}work-items/([A-Z0-9]+-\\d+)/$`).exec(path))) { const it = itemByKey(m[1]!); return it ? [200, withLabels(it)] : [404, { error: "Not found" }]; }
  if ((m = new RegExp(`${ws}projects/([^/]+)/work-items/$`).exec(path))) {
    if (method === "GET") {
      if (q.has("external_id")) { const it = [...items.values()].find((i) => i.external_id === q.get("external_id") && i.external_source === q.get("external_source")); return it ? [200, withLabels(it)] : [404, { error: "Not found" }]; }
      return [200, page([...items.values()].filter((i) => i.project === m![1]).map(withLabels))];
    }
    if (method === "POST") {
      const it = addItem({ id: m[1]! }, nextSeq++, String(body?.name ?? "Untitled"), "Backlog", { description_html: body?.description_html ?? "", labels: body?.labels ?? [], assignees: body?.assignees ?? [],
        ...(body?.state ? { state: body.state } : {}), ...(body?.external_id ? { external_id: String(body.external_id), external_source: String(body.external_source) } : {}) });
      return [201, withLabels(it)];
    }
  }
  if ((m = new RegExp(`${ws}projects/([^/]+)/work-items/([^/]+)/$`).exec(path))) {
    const it = items.get(m[2]!); if (!it) return [404, { error: "Not found" }];
    if (method === "GET") return [200, withLabels(it)];
    if (method === "PATCH") { for (const k of ["name", "description_html", "state", "labels", "assignees", "priority"] as const) if (body?.[k] !== undefined) (it as any)[k] = body[k]; it.updated_at = tick(1); return [200, withLabels(it)]; }
  }
  if ((m = new RegExp(`${ws}projects/[^/]+/work-items/([^/]+)/comments/$`).exec(path))) {
    const list = comments.get(m[1]!) ?? [];
    if (method === "GET") return [200, page(list)];
    if (method === "POST") { const c = { id: randomUUID(), comment_html: body?.comment_html ?? "", created_at: tick(1), actor: USERS.bot.id, ...(body?.external_id ? { external_id: body.external_id, external_source: body.external_source } : {}) }; comments.set(m[1]!, [...list, c]); return [201, c]; }
  }
  if ((m = new RegExp(`${ws}projects/[^/]+/work-items/([^/]+)/links/$`).exec(path))) {
    const list = links.get(m[1]!) ?? [];
    if (method === "GET") return [200, page(list)];
    if (method === "POST") { const l = { id: randomUUID(), title: body?.title ?? "", url: body?.url ?? "", created_at: tick(0) }; links.set(m[1]!, [...list, l]); return [201, l]; }
  }
  if ((m = new RegExp(`${ws}projects/[^/]+/work-items/([^/]+)/links/([^/]+)/$`).exec(path))) {
    const l = (links.get(m[1]!) ?? []).find((x) => x.id === m![2]); if (!l) return [404, { error: "Not found" }];
    if (method === "PATCH") { Object.assign(l, { ...(body?.title !== undefined ? { title: body.title } : {}), ...(body?.url !== undefined ? { url: body.url } : {}) }); return [200, l]; }
    if (method === "DELETE") { links.set(m[1]!, (links.get(m[1]!) ?? []).filter((x) => x.id !== l.id)); return [204, null]; }
  }
  if (method === "GET" && /\/activities\/$/.test(path)) return [200, page([])];
  return [404, { error: `demo Plane: no route for ${method} ${path}` }];
}

const planeServer = createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", "http://plane.internal");
  let raw = ""; for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : null;
  const send = (s: number, o: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(s === 204 ? "" : JSON.stringify(o)); };
  const cookie = req.headers.cookie ?? "";
  if (u.pathname.startsWith("/api/v1/")) {
    const path = u.pathname.slice("/api/v1".length);
    planeLog.push({ method: req.method!, path, body });
    if (req.method !== "GET" && flags.failPlaneWrites > 0) { flags.failPlaneWrites--; return send(400, { error: "Invalid comment_html" }); }
    const [s, o] = planeV1(req.method!, path, u.searchParams, body);
    if (s === 404 && String((o as any)?.error).startsWith("demo Plane")) console.warn((o as any).error);
    return send(s, o);
  }
  // Plane web API, as the signed-in browser user (cookie session).
  const aid = /(?:^|;\s*)admin-session-id=([^;]+)/.exec(cookie)?.[1];
  if (u.pathname === "/api/instances/admins/me/") return aid === "god" ? send(200, { id: USERS.admin.id, email: USERS.admin.email }) : send(401, { error: "no" });
  if (u.pathname.startsWith("/api/instances/workspaces/")) return aid === "god" ? send(200, page([{ id: WS_ID, slug: SLUG, name: "Acme" }, { id: BETA.id, slug: BETA.slug, name: BETA.name }])) : send(401, { error: "no" });
  const sid = /(?:^|;\s*)session-id=([^;]+)/.exec(cookie)?.[1];
  const who = sid ? SESSIONS[sid] : undefined;
  if (!who) return send(401, { error: "no" });
  const user = USERS[who];
  if (u.pathname === "/api/users/me/") return send(200, { id: user.id, email: user.email, display_name: user.display_name, first_name: user.first_name, last_name: user.last_name });
  let m: RegExpExecArray | null;
  if ((m = /^\/api\/workspaces\/([^/]+)\/workspace-members\/me\/$/.exec(u.pathname))) return m[1] === SLUG ? send(200, { id: "wm-" + who, role: user.role, workspace: WS_ID }) : m[1] === BETA.slug && who === "admin" ? send(200, { id: "wm-beta", role: 20, workspace: BETA.id }) : send(403, { error: "no" });
  if ((m = /^\/api\/workspaces\/([^/]+)\/projects\/([^/]+)\/$/.exec(u.pathname))) { const p = projectById(m[2]!); return p ? send(200, p) : send(404, {}); }
  if ((m = /^\/api\/workspaces\/([^/]+)\/projects\/([^/]+)\/project-members\/me\/$/.exec(u.pathname))) return send(200, { role: user.role });
  if ((m = /^\/api\/workspaces\/([^/]+)\/projects\/([^/]+)\/issues\/([^/]+)\/$/.exec(u.pathname))) { const it = items.get(m[3]!); return it ? send(200, { ...withLabels(it) }) : send(404, {}); }
  if ((m = /^\/api\/workspaces\/([^/]+)\/projects\/([^/]+)\/issues\/([^/]+)\/issue-links\/$/.exec(u.pathname))) return send(200, links.get(m[3]!) ?? []);
  console.warn(`demo Plane web: no route for ${req.method} ${u.pathname}`);
  send(404, { error: "Not found" });
});
await new Promise<void>((r) => planeServer.listen(0, "127.0.0.1", r));
const PLANE_URL = `http://127.0.0.1:${(planeServer.address() as any).port}`;

// ---- the fake GitHub -----------------------------------------------------------------------------------------
interface GPr { number: number; title: string; body: string; state: "open" | "closed"; merged: boolean; draft: boolean; head: { ref: string; sha: string }; base: { ref: string }; user: { login: string; id: number };
  html_url: string; labels: { name: string }[]; requested_reviewers: any[]; mergeable_state?: string }
export const gh = {
  branches: new Map<string, string>([["main", "a".repeat(40)], ["staging", "b".repeat(40)]]),
  prs: new Map<number, GPr>(),
  reviews: new Map<number, any[]>(),
  checkSuites: new Map<string, { conclusion: string | null; status: string; app: { slug: string; name: string } }[]>(),
  statuses: new Map<string, { state: string; context: string }[]>(),
  commits: new Map<string, { sha: string; message: string; verified: boolean; author: string }>(),
  issues: new Map<number, any>(),
  comments: [] as { route: string; params: any }[],
  writes: [] as { route: string; params: any }[],
  unknown: [] as string[],
  nextNumber: 120,
};
const ghUsers = Object.values(USERS).filter((u) => u.gh).map((u) => u.gh!);
const repoData = (name = REPO.name) => (name === "public-api" ? { id: 812345679, name, full_name: "acme/public-api", owner: { login: REPO.owner, id: 9900001, type: "Organization" }, default_branch: "main",
  html_url: "https://github.com/acme/public-api", private: true, permissions: { admin: true, maintain: true, push: true, triage: true, pull: true } } : { id: REPO.id, name: REPO.name, full_name: REPO.full_name, owner: { login: REPO.owner, id: 9900001, type: "Organization" }, default_branch: REPO.default_branch,
  html_url: `https://github.com/${REPO.full_name}`, private: true, permissions: { admin: true, maintain: true, push: true, triage: true, pull: true } });
class GhError extends Error { status: number; response: any; constructor(status: number, msg: string) { super(msg); this.status = status; this.response = { status, data: { message: msg }, headers: {} }; } }
async function ghRequest(route: string, params: any = {}): Promise<{ data: any; status: number; headers: Record<string, string> }> {
  const ok = (data: any, status = 200) => ({ data, status, headers: {} });
  const [verb, path] = route.split(" ") as [string, string];
  if (verb !== "GET") gh.writes.push({ route, params });
  if (verb !== "GET" && flags.githubRateLimited) {
    const e = new GhError(403, "API rate limit exceeded for installation ID 51234567.");
    e.response.headers = { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 45 * 60) };
    throw e;
  }
  switch (path) {
    case "/repos/{owner}/{repo}": return ok(repoData(params.repo));
    case "/repos/{owner}/{repo}/installation": return ok({ id: INSTALLATION, account: { login: REPO.owner, id: 9900001, type: "Organization" } });
    case "/users/{username}": case "/orgs/{org}": {
      const org = [{ login: "acme", id: 9900001 }, { login: "acme-labs", id: 9900002 }].find((o) => o.login === String(params.username ?? params.org).toLowerCase());
      if (org) return ok({ ...org, type: "Organization", html_url: `https://github.com/${org.login}` });
      const u = ghUsers.find((x) => x.login.toLowerCase() === String(params.username).toLowerCase()); if (!u) throw new GhError(404, "Not Found"); return ok({ ...u, type: "User", html_url: `https://github.com/${u.login}` }); }
    case "/user/{account_id}": { const u = ghUsers.find((x) => x.id === Number(params.account_id)); if (!u) throw new GhError(404, "Not Found"); return ok({ ...u, type: "User" }); }
    case "/repos/{owner}/{repo}/git/ref/{ref}": { const b = gh.branches.get(String(params.ref).replace(/^heads\//, "")); if (!b) throw new GhError(404, "Not Found"); return ok({ ref: `refs/${params.ref}`, object: { sha: b } }); }
    case "/repos/{owner}/{repo}/git/refs": { const name = String(params.ref).replace(/^refs\/heads\//, ""); if (gh.branches.has(name)) throw new GhError(422, "Reference already exists"); gh.branches.set(name, params.sha); return ok({ ref: params.ref, object: { sha: params.sha } }, 201); }
    case "/repos/{owner}/{repo}/commits/{ref}": case "/repos/{owner}/{repo}/commits/{commit_sha}": {
      const c = gh.commits.get(params.ref ?? params.commit_sha); if (!c) throw new GhError(404, "No commit found");
      return ok({ sha: c.sha, commit: { message: c.message, verification: { verified: c.verified, reason: c.verified ? "valid" : "unsigned" } }, author: { login: c.author } });
    }
    case "/repos/{owner}/{repo}/compare/{basehead}": { const [, head] = String(params.basehead).split("..."); const list = [...gh.commits.values()].filter((c) => c.sha === head); return ok({ commits: list.map((c) => ({ sha: c.sha, commit: { message: c.message } })), total_commits: list.length }); }
    case "/repos/{owner}/{repo}/pulls/{pull_number}": { const p = gh.prs.get(Number(params.pull_number)); if (!p) throw new GhError(404, "Not Found"); return ok(p); }
    case "/repos/{owner}/{repo}/pulls/{pull_number}/reviews": return ok(gh.reviews.get(Number(params.pull_number)) ?? []);
    case "/repos/{owner}/{repo}/commits/{commit_sha}/pulls": return ok([...gh.prs.values()].filter((p) => p.head.sha === params.commit_sha));
    case "/repos/{owner}/{repo}/commits/{ref}/check-suites": { const s = gh.checkSuites.get(params.ref) ?? []; return ok({ total_count: s.length, check_suites: s.map((x, i) => ({ id: 3000 + i, ...x, head_sha: params.ref })) }); }
    case "/repos/{owner}/{repo}/commits/{ref}/check-runs": { const s = gh.checkSuites.get(params.ref) ?? []; return ok({ total_count: s.length, check_runs: s.map((x, i) => ({ id: 4000 + i, name: x.app.name, status: x.status, conclusion: x.conclusion })) }); }
    case "/repos/{owner}/{repo}/commits/{ref}/status": { const s = gh.statuses.get(params.ref) ?? []; const state = s.some((x) => x.state === "failure" || x.state === "error") ? "failure" : s.some((x) => x.state === "pending") ? "pending" : "success"; return ok({ state, total_count: s.length, statuses: s, sha: params.ref }); }
    case "/repos/{owner}/{repo}/issues/{issue_number}/comments": case "/repos/{owner}/{repo}/commits/{commit_sha}/comments":
      if (verb === "POST") { gh.comments.push({ route, params }); return ok({ id: 5000 + gh.comments.length, html_url: `https://github.com/${REPO.full_name}#comment-${gh.comments.length}`, body: params.body }, 201); }
      return ok([]);
    case "/repos/{owner}/{repo}/issues": if (verb === "POST") { const n = gh.nextNumber++; const iss = { number: n, title: params.title, body: params.body, state: "open", labels: (params.labels ?? []).map((name: string) => ({ name })), assignees: (params.assignees ?? []).map((login: string) => ({ login })), html_url: `https://github.com/${REPO.full_name}/issues/${n}` }; gh.issues.set(n, iss); return ok(iss, 201); } return ok([...gh.issues.values()]);
    case "/repos/{owner}/{repo}/issues/{issue_number}": { const iss = gh.issues.get(Number(params.issue_number)); if (!iss) throw new GhError(404, "Not Found"); if (verb === "PATCH") Object.assign(iss, params.state ? { state: params.state, state_reason: params.state_reason } : {}, params.title ? { title: params.title } : {}, params.body !== undefined ? { body: params.body } : {}); return ok(iss); }
    case "/repos/{owner}/{repo}/issues/{issue_number}/labels": case "/repos/{owner}/{repo}/issues/{issue_number}/labels/{name}": case "/repos/{owner}/{repo}/issues/{issue_number}/assignees": case "/repos/{owner}/{repo}/labels":
      return ok(verb === "GET" ? [] : {});
    case "/app": return ok({ id: 1234567, slug: "acme-git-sync", name: "Acme git-sync", owner: { login: REPO.owner },
      permissions: { pull_requests: "write", issues: "write", contents: "write", checks: "read", statuses: "read", deployments: "read", metadata: "read", members: "read" },
      events: flags.appEvents ?? ["check_run", "check_suite", "deployment_status", "issue_comment", "issues", "pull_request", "pull_request_review", "push", "status"] });
    case "/app/installations": return ok([{ id: INSTALLATION, account: { login: REPO.owner, id: 9900001, type: "Organization" }, repository_selection: "selected", permissions: {}, events: [] }]);
    case "/app/installations/{installation_id}": return ok({ id: INSTALLATION, account: { login: REPO.owner, id: 9900001, type: "Organization" }, repository_selection: "selected", target_type: "Organization" });
    case "/app/hook/deliveries": return ok([{ id: 1, guid: "g-1", delivered_at: tick(0), redelivery: false, status: "OK", status_code: 202, event: "push" }]);
    case "/repos/{owner}/{repo}/autolinks": throw new GhError(404, "Not Found");
  }
  gh.unknown.push(route);
  console.warn(`demo GitHub: no route for ${route}`);
  return ok({});
}
const octokit = { auth: async () => ({ type: "app" }), request: ghRequest, paginate: async (route: string, params: any) => { const r = await ghRequest(route, params); const d = r.data; return Array.isArray(d) ? d : d?.check_suites ?? d?.check_runs ?? d?.repositories ?? d?.commits ?? []; } };
const ghClient = {
  installationOctokit: async () => octokit,
  installationIdFor: async () => INSTALLATION,
  appRequest: (route: string, params: Record<string, unknown>) => ghRequest(route, params),
  publicRequest: (route: string, params: Record<string, unknown>) => ghRequest(route, params),
  invalidateInstallation: () => {},
};

// GitHub REST reached with a member's own OAuth token (account page, repository pickers).
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== "https://api.github.com" && url.origin !== "https://github.com") return realFetch(input, init);
  const json = (o: unknown, s = 200) => Response.json(o, { status: s });
  const auth = String(init?.headers?.authorization ?? init?.headers?.Authorization ?? "");
  const owner = Object.values(USERS).find((u) => u.gh && auth.includes(`demo-token-${u.gh.login}`));
  if (url.pathname === "/user") return owner ? json({ ...owner.gh, type: "User" }) : json({ message: "Bad credentials" }, 401);
  if (url.pathname === "/user/installations") return json({ total_count: 1, installations: [{ id: INSTALLATION, account: { login: REPO.owner, id: 9900001, type: "Organization" }, app_slug: "acme-git-sync", repository_selection: "selected" }] });
  if (/^\/user\/installations\/\d+\/repositories$/.test(url.pathname)) return json({ total_count: 2, repositories: [{ ...repoData() }, { id: 812345679, name: "public-api", full_name: "acme/public-api", private: true, owner: { login: REPO.owner }, permissions: { admin: true, maintain: true, push: true, triage: true, pull: true } }] });
  if (/^\/applications\/[^/]+\/(token|grant)$/.test(url.pathname)) return new Response(null, { status: 204 });
  if (url.pathname === "/login/oauth/access_token") {
    const params = new URLSearchParams(typeof init?.body === "string" ? (init.body.trim().startsWith("{") ? Object.entries(JSON.parse(init.body)).map(([k, v]) => `${k}=${v}`).join("&") : init.body) : "");
    const login = String(params.get("code") ?? "").replace(/^demo-code-/, "");
    return json({ access_token: `demo-token-${login}`, token_type: "bearer", scope: "", expires_in: 28800, refresh_token: `demo-refresh-${login}`, refresh_token_expires_in: 15811200 });
  }
  console.warn(`demo GitHub (fetch): no route for ${init?.method ?? "GET"} ${url.pathname}`);
  return json({ message: "Not Found" }, 404);
}) as typeof fetch;

// ---- the service ---------------------------------------------------------------------------------------------
const db = new PGlite();
await db.waitReady;
await migrate(db);
const tokenKey = randomBytes(32);
const dir = mkdtempSync(join(tmpdir(), "gitsync-demo-"));
const keyPath = join(dir, "app.pem");
writeFileSync(keyPath, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }));
const config: any = {
  PORT, HOST: "127.0.0.1", DATABASE_URL: "", REDIS_URL: "", QUEUE_PREFIX: "demo", PLANE_BASE_URL: PLANE_URL, PLANE_SERVICE_PAT: "demo-service-pat",
  PLANE_SERVICE_USER_ID: USERS.bot.id, PLANE_WEBHOOK_SECRET: "demo-plane-secret", PLANE_SESSION_COOKIE_NAME: "session-id",
  GITHUB_APP_ID: "1234567", GITHUB_PRIVATE_KEY_PATH: keyPath, GITHUB_WEBHOOK_SECRET: "demo-webhook-secret", GITHUB_CREDENTIAL_MARKER_PATH: join(dir, "retired"),
  GITSYNC_TOKEN_KEY: tokenKey.toString("base64"), GITHUB_CLIENT_ID: "Iv1.demo0000000000", GITHUB_CLIENT_SECRET: "demo-client-secret", GITHUB_APP_SLUG: "acme-git-sync",
  PUBLIC_ORIGIN: ORIGIN, REQUIRE_VERIFIED_COMMITS: false, PLANE_API_RATE_PER_MINUTE: 1200,
};
const credentials = createCredentialSource(db, tokenKey, config, 0, join(dir, "retired"));
const planeClient = new PlaneClient({ baseUrl: PLANE_URL, token: new SecretString(config.PLANE_SERVICE_PAT), maxRetries: 0, sleep: async () => {}, rateLimitPerMinute: 1200 } as any);
const planeInline = new PlaneWritePath({ client: planeClient, db });
const githubInline = new GithubWritePath({ app: ghClient as any, db, sleep: async () => {} } as any);
// In-process stand-ins for the two BullMQ outbound queues: jobs are drained right after each delivery.
const pendingJobs: { side: "plane" | "github"; job: any; tries: number; lastError?: string }[] = [];
const inlineQueue = (side: "plane" | "github") => {
  const jobs = new Map<string, any>();
  return { async add(_n: string, data: any, opts: any) { if (!jobs.has(opts.jobId)) { const job = { id: opts.jobId, data, attemptsMade: 0, opts: {}, state: "waiting", getState: async () => job.state }; jobs.set(opts.jobId, job); pendingJobs.push({ side, job, tries: 0 }); } return jobs.get(opts.jobId); },
    async getJob(id: string) { return jobs.get(id); } };
};
let ctx: AppContext;
const ordered = createOrderedOutbox({
  db, authoriseWrite: createOutboundAuthoriser(db), plane: planeInline, github: githubInline,
  queues: { plane: inlineQueue("plane"), github: inlineQueue("github") } as any,
  findPlaneLinkId: async (target: any, url: string) => (await planeClient.listAll<{ id: string; url: string }>(planeItemsPath(target.slug, target.projectId, target.issueId) + "links/")).find((l) => l.url === url)?.id ?? null,
  resumeReducer: (request: any) => (request.kind === "mirror_created" ? handleMirroredIssue(ctx, request) : request.kind === "mirror_pending" ? handlePendingMirroredIssue(ctx, request) : handleCreatedPr(ctx, request)),
  loadActorToken: async () => null,
  readPlaneIssueFields: async (t: any) => { const i = items.get(t.issueId); return { labels: i?.labels ?? [], assignees: i?.assignees ?? [] }; },
  listGithubAssignees: async (t: any) => (gh.issues.get(t.number)?.assignees ?? []).map((a: any) => a.login),
} as any);
async function drain(round = 0): Promise<void> {
  // Passes over the pending writes until no pass makes progress (a write may wait for an earlier one on its target).
  for (let pass = 0; pendingJobs.length && pass < 50; pass++) {
    const batch = pendingJobs.splice(0);
    let progressed = false;
    for (const next of batch) {
      try { await (next.side === "plane" ? ordered.executePlane(next.job) : ordered.executeGithub(next.job)); next.job.state = "completed"; progressed = true; }
      catch (e: any) {
        next.job.attemptsMade++;
        next.lastError = e.message; if (/must finish first|deferred/i.test(e.message) || ++next.tries < 3) pendingJobs.push(next);
        else { next.job.state = "failed"; console.warn(`demo outbox: ${next.side} write failed: ${e.message}`); }
      }
    }
    if (!progressed && pass > 3) break;
  }
  // Like the worker's periodic recovery: queue registered rows that are pending but not queued, then drain again.
  if (round < 6) { const before = pendingJobs.length; await ordered.recover(); if (pendingJobs.length > before || pendingJobs.length) return drain(round + 1); }
  for (const left of pendingJobs.splice(0)) console.warn(`demo outbox: ${left.side} write still pending: ${left.job.id} — ${left.lastError}`);
}
ctx = { config, db, planeClient, plane: ordered.plane, github: ordered.github, ghClient: ghClient as any, vault: createVault(db, tokenKey) } as any;
const router = createRouter(ctx);
const inboundDeps = { db, opTtlMinutes: 30, serviceUserId: USERS.bot.id, onPlaneEvent: inboundHandler(ctx, router, "plane"), onGithubEvent: inboundHandler(ctx, router, "github") };
let deliverySeq = 0;
async function processAndDrain(job: InboundJob) {
  const outcome = await processInbound(job, inboundDeps as any);
  await drain();
  return outcome;
}
let lastOutcome: unknown;
/** Delivers an event through the real signed webhook ingress, like GitHub/Plane would. */
async function feed(job: InboundJob) {
  const body = JSON.stringify(job.payload);
  const github = job.source === "github";
  const sig = createHmac("sha256", github ? config.GITHUB_WEBHOOK_SECRET : config.PLANE_WEBHOOK_SECRET).update(body).digest("hex");
  lastOutcome = undefined;
  const res = await fetch(`http://127.0.0.1:${PORT}/git-sync/webhooks/${job.source}`, { method: "POST", body,
    headers: { "content-type": "application/json", ...(github ? { "x-github-event": job.event, "x-github-delivery": job.deliveryId, "x-hub-signature-256": `sha256=${sig}` }
      : { "x-plane-event": job.event, "x-plane-delivery": job.deliveryId, "x-plane-signature": sig }) } });
  if (res.status >= 300) throw new Error(`webhook ${job.source}/${job.event} → ${res.status} ${await res.text()}`);
  return lastOutcome ?? `accepted ${res.status}`;
}
export function ghJob(event: string, payload: Record<string, unknown>, sender: { login: string; id: number } = USERS.alex.gh!): InboundJob {
  return { source: "github", deliveryId: `demo-gh-${++deliverySeq}-${randomUUID().slice(0, 8)}`, event, receivedAt: tick(1),
    payload: { repository: { ...repoData() }, installation: { id: INSTALLATION }, sender: { ...sender, type: "User" }, ...payload } } as InboundJob;
}

const routes = composeRoutes({ config, db, tokenKey, ctx, planeClient, ghClient: ghClient as any, credentials, enqueue: async (job: InboundJob) => { try { lastOutcome = await processAndDrain(job); } catch (e: any) { console.warn(`demo enqueue failed: ${e.stack ?? e.message}`); throw e; } }, retryFailed: async (id: string, slug: string) => { const r = await ordered.retryFailed(id, slug); await drain(); return r; } } as any);
const demoRoutes = [
  { method: "POST", path: "/__demo/sql", handler: async (req: any, res: any) => {
    let raw = ""; for await (const c of req) raw += c; const { sql, params } = JSON.parse(raw);
    try { const r = await db.query(sql, params ?? []); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(r.rows)); }
    catch (e: any) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
  } },
  { method: "POST", path: "/__demo/feed", handler: async (req: any, res: any) => {
    let raw = ""; for await (const c of req) raw += c; const { event, payload, sender, step } = JSON.parse(raw);
    const { steps } = await import("./events.ts");
    const outcome = await (step ? steps[step]!((globalThis as any).demo) : feed(ghJob(event, payload, sender))).catch((e: any) => `error: ${e.message}`);
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ outcome }));
  } },
  { method: "POST", path: "/__demo/flags", handler: async (req: any, res: any) => {
    let raw = ""; for await (const c of req) raw += c; Object.assign(flags, JSON.parse(raw));
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(flags));
  } },
  { method: "POST", path: "/__demo/installation-event", handler: async (req: any, res: any) => {
    let raw = ""; for await (const c of req) raw += c; const payload = JSON.parse(raw);
    const outcome = await feed({ source: "github", deliveryId: `demo-gh-inst-${Date.now()}`, event: payload.event ?? "installation_repositories", receivedAt: tick(1),
      payload: { installation: { id: INSTALLATION, account: { login: REPO.owner } }, sender: { ...USERS.admin.gh, type: "User" }, ...payload.payload } } as InboundJob).catch((e: any) => `error: ${e.message}`);
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ outcome }));
  } },
  { method: "GET", path: "/__demo/world", handler: async (_req: any, res: any) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ items: [...items.values()].map((i) => ({ key: keyOf(i), id: i.id, name: i.name, state: STATES.find((s) => s.id === i.state)?.name, labels: i.labels.map((l) => LABELS.find((x) => x.id === l)?.name), assignees: i.assignees })),
      comments: Object.fromEntries([...comments].map(([k, v]) => [keyOf(items.get(k)!), v.map((c) => c.comment_html)])), links: Object.fromEntries([...links].map(([k, v]) => [keyOf(items.get(k)!), v.map((l) => `${l.title} -> ${l.url}`)])),
      github: { branches: [...gh.branches.keys()], prs: [...gh.prs.values()].map((p) => `#${p.number} ${p.state}${p.merged ? " merged" : ""} ${p.title}`), comments: gh.comments.map((c) => `${c.route} ${JSON.stringify(c.params.body).slice(0, 300)}`), writes: gh.writes.map((w) => w.route), issues: [...gh.issues.values()], unknown: gh.unknown } }, null, 1));
  } },
];
const srv = await startServer({ port: PORT, host: "127.0.0.1", routes: [...demoRoutes, ...routes] as any });
console.log(`git-sync demo listening on 127.0.0.1:${srv.port} (fake Plane at ${PLANE_URL})`);

// ---- shared state used by the seed script --------------------------------------------------------------------
(globalThis as any).demo = { PROJECT3, BETA, keyPem: (await import("node:fs")).readFileSync(keyPath, "utf8"), db, gh, items, comments, links, feed, ghJob, itemByKey, stateByName, USERS, REPO, PROJECT, PROJECT2, SLUG, INSTALLATION, tokenKey, encryptSecret, tick };
const { seed } = await import("./seed.ts");
await seed((globalThis as any).demo);
console.log("demo data seeded");
