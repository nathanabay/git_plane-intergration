import type { Db } from "../db/migrate.ts";
import { clearCreatePending, forgetAppliedOps, markCreatePending, recordAppliedOps } from "../db/ledgers.ts";
import type { Sleep } from "./backoff.ts";
import { classifyGithubError, githubErrorStatus, withGithubRateLimits } from "../github/errors.ts";
import { opHash } from "./ophash.ts";
import { readGithubAppClient } from "../db/parity.ts";
import { executeGithubProblemReport } from "../github/problems.ts";
import type { GithubProblemReport } from "../github/problems.ts";

/**
 * `asUser` (spec §12.3, C2): the Plane user to act as. When that user has linked GitHub and their token works,
 * the write is made with it, so GitHub shows them as the author; otherwise the installation token is used.
 */
type Target = { installationId: number; owner: string; repo: string; repoId: number; number: number; asUser?: string };
/** REST "Update an issue": one of these or null; GitHub ignores it unless `state` changes. */
export type GithubStateReason = "completed" | "not_planned" | "duplicate" | "reopened" | null;
export type GithubWrite =
  | GithubProblemReport
  | (Target & { kind: "update_issue"; fields: { title?: string; body?: string; state?: "open" | "closed"; state_reason?: GithubStateReason } })
  | (Target & { kind: "add_labels"; labels: string[] })
  | (Target & { kind: "remove_label"; label: string })
  | (Target & { kind: "add_assignees"; assignees: string[] })
  | (Target & { kind: "remove_assignees"; assignees: string[] })
  | (Target & { kind: "comment"; body: string })
  | { kind: "create_issue"; installationId: number; owner: string; repo: string; repoId: number; title: string; body: string; labels?: string[]; asUser?: string };

export interface GithubFieldChange { targetId: string; field: string; value: unknown }

/** Marker for a GitHub create in flight (F13, F9); ingress retries opened/labeled/assigned events while it is fresh. */
export const pendingGithubCreateHash = (repoId: number, title = "") =>
  opHash("github", title ? `pending:${repoId}:${title.trim()}` : `pending:${repoId}`, "create_issue", null);

/** The vocabulary shared by the write path (recording) and ingress (consuming); targetId is `${repoId}#${number}`. */
export function githubFieldChanges(event: string, payload: any): GithubFieldChange[] {
  const repoId = payload?.repository?.id;
  const subject = event === "pull_request" ? payload?.pull_request : payload?.issue;
  if (repoId === undefined || !subject || subject.number === undefined) return [];
  const targetId = `${repoId}#${subject.number}`;
  const action: string | undefined = payload.action;
  const one = (field: string, value: unknown): GithubFieldChange[] => [{ targetId, field, value }];

  if (event === "issue_comment") return ["created", "edited"].includes(action ?? "") && typeof payload.comment?.body === "string" ? one("comment", payload.comment.body) : [];
  if (event !== "issues" && event !== "pull_request") return [];
  switch (action) {
    case "edited":
      return Object.keys(payload.changes ?? {}).filter((k) => k === "title" || k === "body").map((k) => ({ targetId, field: k, value: subject[k] ?? null }));
    case "closed": return one("state", "closed");
    case "reopened": return one("state", "open");
    case "labeled": return payload.label?.name ? one(`label:${payload.label.name}`, true) : [];
    case "unlabeled": return payload.label?.name ? one(`label:${payload.label.name}`, false) : [];
    case "assigned": return payload.assignee?.login ? one(`assignee:${payload.assignee.login}`, true) : [];
    case "unassigned": return payload.assignee?.login ? one(`assignee:${payload.assignee.login}`, false) : [];
    case "opened": return event === "issues" ? one("created", null) : [];
    default: return [];
  }
}

export class GithubWritePath {
  #app: { installationOctokit(id: number): Promise<any> };
  #db: Db;
  #problemReportBotLogin: (octokit: any) => Promise<string>;
  #userClient: ((planeUserId: string, installationId: number) => Promise<any | null>) | undefined;
  #onUserTokenRejected: ((planeUserId: string) => Promise<void>) | undefined;

  // sleep is accepted for source compatibility with older consumers; rate limits never sleep here.
  constructor(deps: {
    app: { installationOctokit(id: number): Promise<any> }; db: Db; sleep?: Sleep;
    /** Server-owned App identity; the default reads authenticated App metadata (or a configured slug for custom clients). Never sourced from a webhook. */
    problemReportBotLogin?: () => Promise<string>;
    /** C2 attribution: an Octokit acting as the linked user, or null (see createUserClientFactory). */
    userClient?: (planeUserId: string, installationId: number) => Promise<any | null>;
    /** GitHub refused the user's token (401): mark the link for re-authorization. */
    onUserTokenRejected?: (planeUserId: string) => Promise<void>;
  }) {
    this.#app = deps.app;
    this.#db = deps.db;
    this.#problemReportBotLogin = deps.problemReportBotLogin ?? (async (octokit) => {
      // Context7 /octokit/auth-app.js: the App authentication hook uses JWT for /app,
      // including on installation clients. The metadata belongs to the credentials in use.
      const slug: unknown = typeof octokit.auth === "function"
        ? (await this.#request(octokit, "GET /app", {})).data?.slug
        : (await readGithubAppClient(this.#db))?.appSlug;
      if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9_-]*$/i.test(slug))
        throw new Error("the authenticated GitHub App slug is required for failure-report ownership");
      // Context7 /github/docs: installation-token comments are authored as appname[bot].
      return `${slug}[bot]`;
    });
    this.#userClient = deps.userClient;
    this.#onUserTokenRejected = deps.onUserTokenRejected;
  }

  /** Scheduling belongs to the queue/outbox; no request retry sleeps inside a worker. */
  async #request(octokit: any, route: string, params: Record<string, unknown>): Promise<any> {
    return octokit.request(route, params);
  }

  /**
   * The write as the linked user when possible. A missing or broken user client, or a user token GitHub refuses
   * (401 revoked, 403/404 no access to this repository), falls back to the installation token: the write is
   * never dropped (spec §12.3). Rate limits are not a refusal and propagate as before.
   */
  async #send(write: Exclude<GithubWrite, { kind: "problem_report" }>, octokit: any, route: string, params: Record<string, unknown>): Promise<any> {
    if (write.asUser && this.#userClient) {
      let user: any = null;
      try { user = await this.#userClient(write.asUser, write.installationId); }
      catch (err) { console.error("user GitHub client unavailable:", err instanceof Error ? err.message : "unknown"); }
      if (user) {
        try { return await this.#request(user, route, params); }
        catch (err) {
          const status = githubErrorStatus(err);
          if (classifyGithubError(err).kind === "rate_limited" || (status !== 401 && status !== 403 && status !== 404)) throw err;
          if (status === 401) await this.#onUserTokenRejected?.(write.asUser).catch(() => undefined);
        }
      }
    }
    return this.#request(octokit, route, params);
  }

  async apply(write: GithubWrite): Promise<{ ok: true; id?: number; number?: number }> {
    if (write.installationId === 0) throw new Error("invalid GitHub installationId: 0");
    const octokit = withGithubRateLimits(await this.#app.installationOctokit(write.installationId), {
      key: `installation:${write.installationId}`, db: this.#db,
    });
    const repo = { owner: write.owner, repo: write.repo };

    if (write.kind === "problem_report") {
      const botLogin = await this.#problemReportBotLogin(octokit);
      const hash = write.target.kind === "issue" ? opHash("github", `${write.repoId}#${write.target.number}`, "comment", write.body) : undefined;
      // The executor may discover an already-correct comment after a lost POST receipt. Record
      // echoes only around its actual POST/PATCH, not a read/no-op, and preserve rate-limit errors.
      return executeGithubProblemReport({ request: async (route, params) => {
        const mutation = hash && /^(POST|PATCH) /.test(route);
        if (mutation) await recordAppliedOps(this.#db, [{ opHash: hash, direction: "to_github" }]);
        try { return await this.#request(octokit, route, params ?? {}); }
        catch (error) {
          if (mutation) await forgetAppliedOps(this.#db, [hash]);
          throw error;
        }
      } }, write, botLogin);
    }

    if (write.kind === "create_issue") {
      const markers = [
        pendingGithubCreateHash(write.repoId),
        ...(write.title ? [pendingGithubCreateHash(write.repoId, write.title)] : []),
      ];
      for (const m of markers) await markCreatePending(this.#db, m, "to_github");
      try {
        const res = await this.#send(write, octokit, "POST /repos/{owner}/{repo}/issues", { ...repo, title: write.title, body: write.body, ...(write.labels ? { labels: write.labels } : {}) });
        const number: number | undefined = res?.data?.number;
        if (number !== undefined) {
          // GitHub fires `opened` and one `labeled` per initial label for this one request; each is our echo.
          const targetId = `${write.repoId}#${number}`;
          await recordAppliedOps(this.#db, [
            { opHash: opHash("github", targetId, "created", null), direction: "to_github" as const },
            ...(write.labels ?? []).map((l) => ({ opHash: opHash("github", targetId, `label:${l}`, true), direction: "to_github" as const })),
          ]);
        }
        return { ok: true, id: res?.data?.id, number };
      } finally {
        for (const m of markers) await clearCreatePending(this.#db, m);
      }
    }

    const targetId = `${write.repoId}#${write.number}`;
    const issue = { ...repo, issue_number: write.number };
    let changes: [string, unknown][];
    let route: string;
    let params: Record<string, unknown>;
    switch (write.kind) {
      case "update_issue":
        // `state_reason` is sent but not hashed: no webhook field change carries it, so its echo row would never be consumed.
        params = { ...issue, ...Object.fromEntries(Object.entries(write.fields).filter(([, v]) => v !== undefined)) };
        changes = Object.entries(write.fields).filter(([k, v]) => v !== undefined && k !== "state_reason");
        route = "PATCH /repos/{owner}/{repo}/issues/{issue_number}";
        break;
      case "add_labels":
        changes = write.labels.map((l) => [`label:${l}`, true]);
        route = "POST /repos/{owner}/{repo}/issues/{issue_number}/labels";
        params = { ...issue, labels: write.labels };
        break;
      case "remove_label":
        changes = [[`label:${write.label}`, false]];
        route = "DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}";
        params = { ...issue, name: write.label };
        break;
      case "add_assignees":
        changes = write.assignees.map((a) => [`assignee:${a}`, true]);
        route = "POST /repos/{owner}/{repo}/issues/{issue_number}/assignees";
        params = { ...issue, assignees: write.assignees };
        break;
      case "remove_assignees":
        changes = write.assignees.map((a) => [`assignee:${a}`, false]);
        route = "DELETE /repos/{owner}/{repo}/issues/{issue_number}/assignees";
        params = { ...issue, assignees: write.assignees };
        break;
      case "comment":
        changes = [["comment", write.body]];
        route = "POST /repos/{owner}/{repo}/issues/{issue_number}/comments";
        params = { ...issue, body: write.body };
        break;
    }
    if (changes.length === 0) return { ok: true };

    const hashes = changes.map(([field, value]) => opHash("github", targetId, field, value));
    await recordAppliedOps(this.#db, hashes.map((h) => ({ opHash: h, direction: "to_github" as const })));
    try {
      const res = await this.#send(write, octokit, route, params);
      return { ok: true, id: res?.data?.id };
    } catch (err: any) {
      await forgetAppliedOps(this.#db, hashes);
      // GitHub hides inaccessible private resources behind 404. Only an accessible issue proves absence.
      if (write.kind === "remove_label" && classifyGithubError(err).kind === "not_found") {
        const current = await this.#request(octokit, "GET /repos/{owner}/{repo}/issues/{issue_number}", issue);
        const labels: unknown = current?.data?.labels;
        if (Array.isArray(labels) && labels.every((label) => typeof label === "string" || typeof label?.name === "string")
          && !labels.some((label) => (typeof label === "string" ? label : label.name).toLowerCase() === write.label.toLowerCase()))
          return { ok: true };
      }
      throw err;
    }
  }
}
