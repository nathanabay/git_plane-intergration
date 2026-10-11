import type { Db } from "../db/migrate.ts";
import { clearCreatePending, forgetAppliedOps, markCreatePending, recordAppliedOps } from "../db/ledgers.ts";
import { realSleep, retryDelayMs } from "./backoff.ts";
import type { Sleep } from "./backoff.ts";
import { opHash } from "./ophash.ts";

type Target = { installationId: number; owner: string; repo: string; repoId: number; number: number };
export type GithubWrite =
  | (Target & { kind: "update_issue"; fields: { title?: string; body?: string; state?: "open" | "closed" } })
  | (Target & { kind: "add_labels"; labels: string[] })
  | (Target & { kind: "remove_label"; label: string })
  | (Target & { kind: "add_assignees"; assignees: string[] })
  | (Target & { kind: "remove_assignees"; assignees: string[] })
  | (Target & { kind: "comment"; body: string })
  | { kind: "create_issue"; installationId: number; owner: string; repo: string; repoId: number; title: string; body: string; labels?: string[] };

export interface GithubFieldChange { targetId: string; field: string; value: unknown }

const MAX_RETRIES = 5;

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

  if (event === "issue_comment") return action === "created" && typeof payload.comment?.body === "string" ? one("comment", payload.comment.body) : [];
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
  #sleep: Sleep;

  constructor(deps: { app: { installationOctokit(id: number): Promise<any> }; db: Db; sleep?: Sleep }) {
    this.#app = deps.app;
    this.#db = deps.db;
    this.#sleep = deps.sleep ?? realSleep;
  }

  /** Retries 403/429 rate-limit responses per §9; a 403 without rate-limit headers is a permission error. */
  async #request(octokit: any, route: string, params: Record<string, unknown>): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await octokit.request(route, params);
      } catch (err: any) {
        const status: number | undefined = err?.status ?? err?.response?.status;
        const headers: Record<string, string> = err?.response?.headers ?? {};
        const get = (n: string) => { const v = headers[n]; return v === undefined || v === null ? undefined : String(v); };
        const limited = status === 429 || (status === 403 && (get("retry-after") !== undefined || get("x-ratelimit-remaining") === "0"));
        if (!limited || attempt >= MAX_RETRIES) throw err;
        await this.#sleep(retryDelayMs(get, attempt, { resetNeedsExhausted: true }));
      }
    }
  }

  async apply(write: GithubWrite): Promise<{ ok: true; id?: number; number?: number }> {
    if (write.installationId === 0) throw new Error("invalid GitHub installationId: 0");
    const octokit = await this.#app.installationOctokit(write.installationId);
    const repo = { owner: write.owner, repo: write.repo };

    if (write.kind === "create_issue") {
      const markers = [
        pendingGithubCreateHash(write.repoId),
        ...(write.title ? [pendingGithubCreateHash(write.repoId, write.title)] : []),
      ];
      for (const m of markers) await markCreatePending(this.#db, m, "to_github");
      try {
        const res = await this.#request(octokit, "POST /repos/{owner}/{repo}/issues", { ...repo, title: write.title, body: write.body, ...(write.labels ? { labels: write.labels } : {}) });
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
        changes = Object.entries(write.fields).filter(([, v]) => v !== undefined);
        route = "PATCH /repos/{owner}/{repo}/issues/{issue_number}";
        params = { ...issue, ...Object.fromEntries(changes) };
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
      const res = await this.#request(octokit, route, params);
      return { ok: true, id: res?.data?.id };
    } catch (err: any) {
      await forgetAppliedOps(this.#db, hashes);
      // Removing a label that is not on the issue changes nothing and sends no webhook: the goal is met.
      if (write.kind === "remove_label" && (err?.status ?? err?.response?.status) === 404) return { ok: true };
      throw err;
    }
  }
}
