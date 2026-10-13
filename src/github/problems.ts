// Server-only durable user-facing failure reports. Keep browser-shared lifecycle helpers separate.
import { createHash } from "node:crypto";
import { escapeHtml } from "./html.ts";
import { readGithubCollection } from "./pr-automation.ts";
import type { OctokitRequest } from "./pr-automation.ts";

// N2: report operations are data registered in the durable outbox; reducers never post directly.
export interface GithubProblemReport {
  kind: "problem_report";
  installationId: number;
  owner: string;
  repo: string;
  repoId: number;
  key: string;
  target: { kind: "commit"; sha: string } | { kind: "issue"; number: number };
  body: string;
}

export interface ProblemReportDeps {
  enabled: boolean;
  authority: import("../operations/plans.ts").WriteAuthority;
  plan: import("../operations/plans.ts").PlanWriter;
}

const MAX_REPORT_BODY = 32_000;
const repositoryPart = (value: unknown): boolean => typeof value === "string" && value.length > 0 && value.length <= 256
  && !/[\u0000-\u0020\u007f/\\]/.test(value) && value !== "." && value !== "..";
function diagnostics(input: string[]): string[] {
  const messages = new Set<string>();
  let omitted = false;
  for (let i = 0; i < input.length; i++) {
    if (i >= 256 || messages.size >= 50) { omitted = true; break; }
    if (typeof input[i] !== "string") throw new Error("invalid failure-report diagnostic");
    const message = input[i]!.slice(0, 500).replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
    if (message) messages.add(message);
  }
  if (omitted) messages.add("Additional failures are recorded in the sync audit log.");
  return [...messages].sort();
}

function codeLiteral(message: string): string {
  let length = 1;
  for (const run of message.matchAll(/`+/g)) length = Math.max(length, run[0].length + 1);
  const delimiter = "`".repeat(length);
  return `${delimiter} ${message} ${delimiter}`;
}

function boundedBody(body: string): string {
  if (body.length > MAX_REPORT_BODY) throw new Error("failure-report body exceeds its size limit");
  return body;
}

/** Stable marker identifies one report; a changed message gets a new immutable update intent. */
export async function reportGithubProblem(deps: ProblemReportDeps, input: {
  owner: string; repo: string; key: string; target: GithubProblemReport["target"]; messages: string[];
}): Promise<void> {
  if (!deps.enabled || !input.messages.length) return;
  if (typeof input.key !== "string" || input.key.length > 4096 || (input.target?.kind !== "commit" && input.target?.kind !== "issue"))
    throw new Error("invalid failure-report identity");
  if (input.target.kind === "commit" && !/^[0-9a-f]{7,64}$/i.test(input.target.sha)) throw new Error("invalid problem report commit SHA");
  if (input.target.kind === "issue" && (!Number.isSafeInteger(input.target.number) || input.target.number < 1)) throw new Error("invalid problem report issue number");
  const key = createHash("sha256").update(JSON.stringify([deps.authority.workspaceSlug, deps.authority.mappingId, deps.authority.repoId, [input.target.kind, input.target.kind === "commit" ? input.target.sha : input.target.number], input.key])).digest("hex");
  const messages = diagnostics(input.messages);
  if (!messages.length) return;
  const body = boundedBody(`Git sync could not complete this action:\n\n${messages.map((message) => `- ${codeLiteral(message)}`).join("\n")}\n\n<!-- git-sync-problem:${key} -->`);
  const version = createHash("sha256").update(body).digest("hex");
  const write: GithubProblemReport = { kind: "problem_report", installationId: deps.authority.installationId,
    owner: input.owner, repo: input.repo, repoId: deps.authority.repoId, key, target: input.target, body };
  await deps.plan(`problem-report:${key}:${version}`, [{ kind: "write", side: "github", write }], { authority: deps.authority });
}

/** Known Plane target: one durable service comment per source failure, with no credential/error-body disclosure. */
export async function reportPlaneProblem(deps: ProblemReportDeps, target: { slug: string; projectId: string; issueId: string }, input: {
  key: string; messages: string[];
}): Promise<void> {
  if (!deps.enabled || !input.messages.length) return;
  if (target.slug !== deps.authority.workspaceSlug) throw new Error("problem report target is outside the verified workspace");
  if (typeof input.key !== "string" || input.key.length > 4096 || !target.projectId || target.projectId.length > 256 || !target.issueId || target.issueId.length > 256)
    throw new Error("invalid Plane failure-report identity");
  const messages = diagnostics(input.messages);
  if (!messages.length) return;
  const key = createHash("sha256").update(JSON.stringify([deps.authority.workspaceSlug, deps.authority.mappingId, deps.authority.repoId, target.slug, target.projectId, target.issueId, input.key])).digest("hex");
  await deps.plan(`plane-problem:${key}`, [{ kind: "write", side: "plane", write: { kind: "add_comment", ...target, _problemReport: { key },
    commentHtml: boundedBody(`<p>Git sync could not complete this action:</p><ul>${messages.map((message) => `<li><code>${escapeHtml(message)}</code></li>`).join("")}</ul>`) } }],
  { authority: deps.authority, target });
}

/** Called only by the GitHub outbox executor with its authenticated installation client and App bot login.
 * Context7 /websites/github_en_rest: commit comments use /comments/{id}; PR discussion uses /issues/comments/{id}.
 */
export async function executeGithubProblemReport(octokit: OctokitRequest, write: GithubProblemReport, botLogin: string): Promise<{ ok: true; id: number }> {
  if (!botLogin.trim()) throw new Error("the authenticated App bot login is required for report ownership");
  if (write.kind !== "problem_report" || !/^[a-f0-9]{64}$/.test(write.key) || typeof write.body !== "string"
    || !Number.isSafeInteger(write.installationId) || write.installationId < 1 || !Number.isSafeInteger(write.repoId) || write.repoId < 1
    || !repositoryPart(write.owner) || !repositoryPart(write.repo)
    || write.body.length > MAX_REPORT_BODY || !write.body.endsWith(`<!-- git-sync-problem:${write.key} -->`)
    || (write.target?.kind !== "commit" && write.target?.kind !== "issue")
    || (write.target.kind === "commit" ? !/^[0-9a-f]{7,64}$/i.test(write.target.sha)
      : !Number.isSafeInteger(write.target.number) || write.target.number < 1)) throw new Error("invalid failure-report intent");
  const repo = { owner: write.owner, repo: write.repo };
  const commit = write.target.kind === "commit";
  const listRoute = commit ? "GET /repos/{owner}/{repo}/commits/{commit_sha}/comments" : "GET /repos/{owner}/{repo}/issues/{issue_number}/comments";
  const target = write.target.kind === "commit" ? { commit_sha: write.target.sha } : { issue_number: write.target.number };
  const marker = `<!-- git-sync-problem:${write.key} -->`;
  // Retain only bounded identity/ownership flags, never every page's full comment bodies.
  const comments = await readGithubCollection<{ id: number; owned: boolean; unchanged: boolean }>(octokit, listRoute, { ...repo, ...target }, (data) => {
    if (!Array.isArray(data) || data.length > 100) throw new Error("invalid failure-report comment page");
    return data.map((comment) => ({ id: comment?.id,
      owned: comment?.user?.login === botLogin && comment?.user?.type === "Bot" && Number.isSafeInteger(comment.id) && comment.id > 0
        && typeof comment.body === "string" && comment.body.trimEnd().endsWith(marker),
      unchanged: comment?.body === write.body }));
  });
  if (!comments.complete) throw new Error("incomplete comment list; report creation refused until a complete read");
  const existing = comments.items.find((comment) => comment.owned);
  if (existing?.unchanged) return { ok: true, id: existing.id };
  const route = existing ? commit ? "PATCH /repos/{owner}/{repo}/comments/{comment_id}" : "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}"
    : commit ? "POST /repos/{owner}/{repo}/commits/{commit_sha}/comments" : "POST /repos/{owner}/{repo}/issues/{issue_number}/comments";
  const res = await octokit.request(route, { ...repo, ...(existing ? { comment_id: existing.id } : target), body: write.body });
  if (!Number.isSafeInteger(res.data?.id) || res.data.id < 1) throw new Error("GitHub report response lacks its comment identity");
  return { ok: true, id: res.data.id };
}

/** Read the opt-in from the verified current mapping; old schemas/mappings default off. */
export async function problemReportsEnabled(db: import("../db/migrate.ts").Db, authority: import("../operations/plans.ts").WriteAuthority): Promise<boolean> {
  const row = (await db.query<{ enabled: boolean }>(`SELECT COALESCE((to_jsonb(rm)->>'report_problems')::boolean, false) AS enabled
    FROM repo_mappings rm JOIN workspace_installations wi ON wi.installation_id = rm.installation_id AND wi.workspace_slug = rm.workspace_slug
    WHERE rm.id = $1 AND rm.workspace_slug = $2 AND rm.gh_repo_id = $3 AND rm.installation_id = $4`,
  [authority.mappingId, authority.workspaceSlug, authority.repoId, authority.installationId])).rows[0];
  return row?.enabled === true;
}
