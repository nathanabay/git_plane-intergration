import { evaluate, parseRules } from "../rules/engine.ts";
import type { RuleEvent } from "../rules/types.ts";
import { ruleEventsFor } from "../app/rule-events.ts";
import type { DryRunResult } from "../operations/tooling.ts";
import { ValidationError, requireRecord } from "./validate.ts";
import type { DryRunInput } from "./validate.ts";

/** Uses the same event translation/evaluator as live rules; never calls an action executor. */
export function previewRules(input: DryRunInput, yaml: string, payload: unknown, mapping?: { repo: string; project: string }): DryRunResult {
  const rules = parseRules(yaml);
  let candidates: RuleEvent[];
  if (input.trigger !== undefined) {
    const data = requireRecord(payload, "Rule context");
    for (const field of ["repo", "project", "author", "base_branch", "head_branch"]) {
      if (data[field] !== undefined && typeof data[field] !== "string") throw new ValidationError(`${field} must be a string`);
    }
    if (data.labels !== undefined && (!Array.isArray(data.labels) || !data.labels.every((label) => typeof label === "string"))) throw new ValidationError("labels must be a list of strings");
    if (data.context !== undefined) requireRecord(data.context, "Template context");
    candidates = [{ ...data, trigger: input.trigger } as unknown as RuleEvent];
  } else {
    candidates = ruleEventsFor(input.source ?? "github", input.event!, payload);
  }
  const events = candidates.map((event) => {
    const result = evaluate(rules, { ...(mapping ? { repo: mapping.repo, project: mapping.project } : {}), ...event });
    return { trigger: event.trigger, matched: result.matched ? { index: result.matched.index, name: result.matched.rule.name ?? null } : null, actions: result.actions };
  });
  return { dryRun: true, trigger: events[0]?.trigger ?? null, matched: events[0]?.matched ?? null,
    actions: events.flatMap((event) => event.actions), ...(events.length > 1 ? { events } : {}) };
}
