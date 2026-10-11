// The delivery → A6 mapping shared by live reducers and dry-run (§7.5, §7.6).
import type { RuleEvent } from "../rules/types.ts";
import { prEventToRuleEvent, pushToRuleEvent } from "../github/pr-automation.ts";

const word = (v: unknown): string | null => {
  return typeof v === "string" && /^[a-z][a-z_]*$/i.test(v) ? v.toLowerCase() : null;
};

const labelsOf = (issue: any): string[] =>
  Array.isArray(issue?.labels) ? issue.labels.map((l: any) => (typeof l === "string" ? l : l?.name)).filter((n: unknown): n is string => typeof n === "string") : [];

function githubExtraEvent(event: string, payload: any): RuleEvent | null {
  const repo = typeof payload?.repository?.full_name === "string" ? { repo: payload.repository.full_name as string } : {};
  const author = typeof payload?.sender?.login === "string" ? { author: payload.sender.login as string } : {};
  switch (event) {
    case "push": {
      // §7.5 `commit.pushed_to_default`: a push whose ref is the repository's default branch.
      const def = payload?.repository?.default_branch;
      const ref: unknown = payload?.ref;
      if (typeof def !== "string" || ref !== `refs/heads/${def}` || payload?.deleted === true) return null;
      return { trigger: "commit.pushed_to_default", head_branch: def, ...repo, ...author };
    }
    case "check_suite": {
      const subject = payload?.check_suite;
      const conclusion = word(subject?.conclusion);
      if (payload?.action !== "completed" || !conclusion) return null;
      const branch = subject?.head_branch ?? subject?.check_suite?.head_branch;
      return { trigger: `check_suite.${conclusion}`, ...(typeof branch === "string" ? { head_branch: branch } : {}), ...repo, ...author };
    }
    case "deployment_status": {
      const state = word(payload?.deployment_status?.state);
      if (!state) return null;
      const ref = payload?.deployment?.ref;
      return { trigger: `deployment_status.${state}`, ...(typeof ref === "string" ? { head_branch: ref } : {}),
        context: { deployment: { environment: payload?.deployment_status?.environment ?? payload?.deployment?.environment ?? null, url: payload?.deployment_status?.environment_url ?? payload?.deployment_status?.target_url ?? null } }, ...repo, ...author };
    }
    case "issues": {
      const action = word(payload?.action);
      if (!action || payload?.issue?.pull_request) return null;
      return { trigger: `issue.${action}`, labels: labelsOf(payload.issue), context: { issue: { number: payload.issue?.number, title: payload.issue?.title, url: payload.issue?.html_url } }, ...repo, ...author };
    }
    case "issue_comment": {
      const action = word(payload?.action);
      if (!action) return null;
      return { trigger: `comment.${action}`, labels: labelsOf(payload?.issue), context: { issue: { number: payload?.issue?.number, title: payload?.issue?.title, url: payload?.issue?.html_url }, comment: { body: payload?.comment?.body, url: payload?.comment?.html_url } }, ...repo, ...author };
    }
    default:
      return null;
  }
}

/** Plane uses both create/update/delete and created/updated/deleted spellings. */
function planeEvent(event: string, payload: any): RuleEvent | null {
  const actions: Record<string, string> = { create: "created", created: "created", update: "updated", updated: "updated", delete: "deleted", deleted: "deleted" };
  const action = actions[word(payload?.action) ?? ""];
  if (!action) return null;
  const data = payload?.data;
  const project = data?.project_id ?? data?.project ?? data?.issue?.project;
  const projectId = typeof project === "string" ? project : project?.id;
  const base = { ...(typeof projectId === "string" ? { project: projectId } : {}) };
  if (event === "issue") return { trigger: `issue.${action}`, ...base, labels: labelsOf(data), context: { issue: { id: data?.id, title: data?.name } } };
  if (event === "issue_comment") return { trigger: `comment.${action}`, ...base, context: { issue: { id: typeof data?.issue === "string" ? data.issue : data?.issue?.id }, comment: { id: data?.id, body: data?.comment_stripped ?? data?.comment_html } } };
  return null;
}

/** Push automation and the first non-default branch push are distinct lifecycle events. */
export function ruleEventsFor(source: "github" | "plane", event: string, payload: unknown): RuleEvent[] {
  if (source === "plane") {
    const translated = planeEvent(event, payload);
    return translated ? [translated] : [];
  }
  const primary = event === "push" ? pushToRuleEvent(payload) : prEventToRuleEvent(event, payload);
  const extra = githubExtraEvent(event, payload);
  const p = payload as any;
  const firstPush = p?.created === true || (typeof p?.before === "string" && /^0{40}$/.test(p.before));
  const defaultBranch = p?.repository?.default_branch;
  const branchCreated = event === "push" && primary?.head_branch && firstPush && typeof defaultBranch === "string" && defaultBranch.length > 0
    && primary.head_branch !== defaultBranch ? { ...primary, trigger: "branch.created" } : null;
  return [...(primary ? [primary] : []), ...(branchCreated ? [branchCreated] : []), ...(extra ? [extra] : [])];
}

export function githubRuleEvents(event: string, payload: unknown): RuleEvent[] {
  return ruleEventsFor("github", event, payload);
}

/** Compatibility for handlers that consume a single non-PR event. */
export function githubRuleEvent(event: string, payload: unknown): RuleEvent | null {
  const translated = ruleEventsFor("github", event, payload);
  return (event === "push" ? translated.find((e) => e.trigger === "commit.pushed_to_default") : translated[0]) ?? null;
}

export function planeRuleEvent(event: string, payload: unknown, project: string, repo?: string): RuleEvent | null {
  const translated = ruleEventsFor("plane", event, payload)[0];
  return translated ? { ...translated, project, ...(repo ? { repo } : {}) } : null;
}
