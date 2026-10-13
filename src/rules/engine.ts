import * as yaml from "yaml";
import type { Rule, Action, RuleConditions, RuleEvent, Evaluation, ActionExecutor, RunResult } from "./types.ts";

const VALID_LIFECYCLES = [
  "pull_request.drafted", "pull_request.opened", "pull_request.review_requested",
  "pull_request.changes_requested", "pull_request.approved", "pull_request.ready_for_merge",
  "pull_request.merged", "pull_request.closed_unmerged", "pull_request.reopened"
];
const OPEN_FAMILIES = ["check_suite", "deployment_status", "issue", "comment"];
const VALID_GLOBS = [...OPEN_FAMILIES.map(f => f + ".*"), "pull_request.*"];

function validateTrigger(trigger: string): boolean {
  if (VALID_LIFECYCLES.includes(trigger)) return true;
  if (trigger === "push" || trigger === "commit.pushed_to_default" || trigger === "branch.created") return true;
  if (VALID_GLOBS.includes(trigger)) return true;
  for (const family of OPEN_FAMILIES) {
    if (trigger.startsWith(`${family}.`)) {
      const word = trigger.slice(family.length + 1);
      if (/^[a-z_]+$/.test(word)) return true;
    }
  }
  return false;
}

/**
 * `create_issue.project` becomes a Plane URL segment, so it may only be a project UUID or a project
 * identifier. No template, `/`, `.` or `%`: `../../other-ws/projects/<id>` left the workspace (audit S1).
 */
const PROJECT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT_IDENTIFIER = /^[A-Za-z0-9]{1,12}$/;
export const isRuleProject = (value: unknown): value is string =>
  typeof value === "string" && (PROJECT_UUID.test(value) || PROJECT_IDENTIFIER.test(value));

const regexCache = new WeakMap<RuleConditions, { base_branch?: RegExp, head_branch?: RegExp }>();

export function parseRules(source: string): Rule[] {
  const data = yaml.parse(source);
  if (!Array.isArray(data)) {
    throw new Error("Rule at index 0: input is not a list");
  }

  const rules: Rule[] = [];
  for (let i = 0; i < data.length; i++) {
    const item = data[i];
    if (!item || typeof item !== "object") {
      throw new Error(`Rule at index ${i}: invalid rule object`);
    }
    
    // Check for unknown keys
    const allowedKeys = ["name", "when", "if", "then"];
    for (const key of Object.keys(item)) {
      if (!allowedKeys.includes(key)) {
        throw new Error(`Rule at index ${i}: unknown key ${key}`);
      }
    }

    if (item.name !== undefined && typeof item.name !== "string") {
      throw new Error(`Rule at index ${i}: name must be a string`);
    }

    if (!item.when) {
      throw new Error(`Rule at index ${i}: missing when`);
    }

    let whens = Array.isArray(item.when) ? item.when : [item.when];
    for (const w of whens) {
      if (typeof w !== "string" || !validateTrigger(w)) {
        throw new Error(`Rule at index ${i}: unknown trigger ${w}`);
      }
    }

    const conditions: RuleConditions = {};
    const cache: { base_branch?: RegExp, head_branch?: RegExp } = {};
    if (item.if) {
      if (typeof item.if !== "object" || Array.isArray(item.if)) {
        throw new Error(`Rule at index ${i}: invalid if condition`);
      }
      for (const [key, value] of Object.entries(item.if)) {
        if (!["base_branch", "head_branch", "labels_any", "labels_all", "author", "repo", "project"].includes(key)) {
          throw new Error(`Rule at index ${i}: unknown condition key ${key}`);
        }
        if (key === "base_branch" || key === "head_branch") {
          if (typeof value !== "string") throw new Error(`Rule at index ${i}: ${key} must be a string`);
          try {
            cache[key] = new RegExp(value);
          } catch (err) {
            throw new Error(`Rule at index ${i}: invalid regex for ${key}`);
          }
          (conditions as any)[key] = value;
        } else if (key === "labels_any" || key === "labels_all") {
          if (!Array.isArray(value) || !value.every(v => typeof v === "string")) {
            throw new Error(`Rule at index ${i}: ${key} must be an array of strings`);
          }
          (conditions as any)[key] = value;
        } else {
          if (typeof value !== "string" && (!Array.isArray(value) || !value.every(v => typeof v === "string"))) {
            throw new Error(`Rule at index ${i}: ${key} must be string or array of strings`);
          }
          (conditions as any)[key] = value;
        }
      }
      regexCache.set(conditions, cache);
    }

    const then = item.then;
    if (!Array.isArray(then) || then.length === 0) {
      throw new Error(`Rule at index ${i}: empty then`);
    }

    const actions: Action[] = [];
    for (let j = 0; j < then.length; j++) {
      const actionObj = then[j];
      if (!actionObj || typeof actionObj !== "object" || Array.isArray(actionObj)) {
        throw new Error(`Rule at index ${i}: invalid action at ${j}`);
      }
      const keys = Object.keys(actionObj);
      if (keys.length !== 1) {
        throw new Error(`Rule at index ${i}: action map with more than one key`);
      }
      const key = keys[0]!;
      const val = (actionObj as any)[key];

      switch (key) {
        case "set_state":
          if (typeof val !== "string") throw new Error(`Rule at index ${i}: set_state value must be string`);
          actions.push({ type: "set_state", state: val });
          break;
        case "add_label":
          if (typeof val !== "string") throw new Error(`Rule at index ${i}: add_label value must be string`);
          actions.push({ type: "add_label", label: val });
          break;
        case "remove_label":
          if (typeof val !== "string") throw new Error(`Rule at index ${i}: remove_label value must be string`);
          actions.push({ type: "remove_label", label: val });
          break;
        case "assign":
          if (typeof val !== "string") throw new Error(`Rule at index ${i}: assign value must be string`);
          actions.push({ type: "assign", assignee: val });
          break;
        case "comment":
          if (typeof val !== "string") throw new Error(`Rule at index ${i}: comment value must be string`);
          actions.push({ type: "comment", body: val });
          break;
        case "log_time":
          if (typeof val !== "string") throw new Error(`Rule at index ${i}: log_time value must be string`);
          actions.push({ type: "log_time", duration: val });
          break;
        case "add_link":
          if (!val || typeof val !== "object" || typeof val.url !== "string" || typeof val.title !== "string") {
            throw new Error(`Rule at index ${i}: add_link value must be {url, title}`);
          }
          actions.push({ type: "add_link", url: val.url, title: val.title });
          break;
        case "create_issue":
          if (!val || typeof val !== "object" || typeof val.project !== "string" || typeof val.title !== "string") {
            throw new Error(`Rule at index ${i}: create_issue value must be {project, title}`);
          }
          if (!isRuleProject(val.project)) {
            throw new Error(`Rule at index ${i}: create_issue project must be a Plane project UUID or identifier`);
          }
          actions.push({ type: "create_issue", project: val.project, title: val.title });
          break;
        default:
          throw new Error(`Rule at index ${i}: unknown action ${key}`);
      }
    }

    rules.push({
      name: item.name,
      when: whens,
      if: conditions,
      then: actions
    });
  }

  return rules;
}

function matchGlob(pattern: string, value: string): boolean {
  if (pattern.endsWith(".*")) {
    const family = pattern.split(".")[0];
    return value.startsWith(`${family}.`);
  }
  return pattern === value;
}

function checkConditionEqualOrInArray(cond: string | string[], value: string | undefined): boolean {
  if (!value) return false;
  if (Array.isArray(cond)) {
    return cond.some(c => c.toLowerCase() === value.toLowerCase());
  }
  return cond.toLowerCase() === value.toLowerCase();
}

function checkConditionExactOrInArray(cond: string | string[], value: string | undefined): boolean {
  if (!value) return false;
  if (Array.isArray(cond)) {
    return cond.includes(value);
  }
  return cond === value;
}

function resolveContext(path: string, context: Record<string, unknown> | undefined): string {
  if (!context) throw new Error(`Cannot resolve {{${path}}}: context is missing`);
  
  const parts = path.split(".");
  let current: any = context;
  for (const part of parts) {
    if (current == null || typeof current !== "object") {
      throw new Error(`Cannot resolve {{${path}}}: undefined at ${part}`);
    }
    current = current[part];
  }
  
  if (current === undefined || current === null) {
    throw new Error(`Cannot resolve {{${path}}}: resolved to null/undefined`);
  }
  return String(current);
}

function renderTemplate(text: string, context?: Record<string, unknown>): string {
  return text.replace(/\{\{([\w.]+)\}\}/g, (_, path) => resolveContext(path, context));
}

function mapAction(action: Action, context?: Record<string, unknown>): Action {
  switch (action.type) {
    case "set_state": return { ...action, state: renderTemplate(action.state, context) };
    case "add_label": return { ...action, label: renderTemplate(action.label, context) };
    case "remove_label": return { ...action, label: renderTemplate(action.label, context) };
    case "assign": return { ...action, assignee: renderTemplate(action.assignee, context) };
    case "comment": return { ...action, body: renderTemplate(action.body, context) };
    case "log_time": return { ...action, duration: renderTemplate(action.duration, context) };
    case "add_link": return { ...action, url: renderTemplate(action.url, context), title: renderTemplate(action.title, context) };
    case "create_issue": {
      // The project is never a template; re-check it here too, in case a rule object skipped parseRules.
      if (!isRuleProject(action.project)) throw new Error("create_issue project must be a Plane project UUID or identifier");
      return { ...action, title: renderTemplate(action.title, context) };
    }
  }
}

export function evaluate(rules: Rule[], event: RuleEvent): Evaluation {
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]!;
    
    let matchTrigger = false;
    for (const w of rule.when) {
      if (matchGlob(w, event.trigger)) {
        matchTrigger = true;
        break;
      }
    }
    if (!matchTrigger) continue;

    let matchConditions = true;
    const cache = regexCache.get(rule.if) || {};
    
    for (const [k, v] of Object.entries(rule.if)) {
      if (k === "base_branch") {
        if (!event.base_branch) {
          matchConditions = false; break;
        }
        const regex = cache.base_branch || new RegExp(v as string);
        if (!regex.test(event.base_branch)) {
          matchConditions = false; break;
        }
      } else if (k === "head_branch") {
        if (!event.head_branch) {
          matchConditions = false; break;
        }
        const regex = cache.head_branch || new RegExp(v as string);
        if (!regex.test(event.head_branch)) {
          matchConditions = false; break;
        }
      } else if (k === "labels_any") {
        const arr = v as string[];
        if (!event.labels || !arr.some(label => event.labels!.includes(label))) {
          matchConditions = false; break;
        }
      } else if (k === "labels_all") {
        const arr = v as string[];
        if (!event.labels || !arr.every(label => event.labels!.includes(label))) {
          matchConditions = false; break;
        }
      } else if (k === "author") {
        if (!checkConditionEqualOrInArray(v as string | string[], event.author)) {
          matchConditions = false; break;
        }
      } else if (k === "repo") {
        if (!checkConditionEqualOrInArray(v as string | string[], event.repo)) {
          matchConditions = false; break;
        }
      } else if (k === "project") {
        if (!checkConditionExactOrInArray(v as string | string[], event.project)) {
          matchConditions = false; break;
        }
      }
    }
    
    if (matchConditions) {
      const resolvedActions = rule.then.map(a => mapAction(a, event.context));
      return { matched: { index: i, rule }, actions: resolvedActions };
    }
  }

  return { matched: null, actions: [] };
}

export async function run(rules: Rule[], event: RuleEvent, executor: ActionExecutor, opts: { dryRun: boolean }): Promise<RunResult> {
  const evalResult = evaluate(rules, event);
  
  if (!evalResult.matched) {
    return { evaluation: evalResult, executed: [], dryRun: opts.dryRun };
  }
  
  if (opts.dryRun) {
    return { evaluation: evalResult, executed: [], dryRun: true };
  }

  for (const action of evalResult.actions) {
    await executor.execute(action, event);
  }

  return { evaluation: evalResult, executed: evalResult.actions, dryRun: false };
}
