import { parse, stringify } from "yaml";
import { parseRules } from "../../rules/engine.ts";

/** Changes only this rule's state actions; other conditions/actions retain their meaning. */
export function setRuleState(source: string, index: number, state: string): string {
  const rules = parseRules(source);
  if (!Number.isSafeInteger(index) || !rules[index]) throw new Error("Choose a rule to update");
  if (!state.trim()) throw new Error("Choose a state");
  const data = parse(source) as { then: Record<string, unknown>[] }[];
  const rule = data[index]!;
  const last = rule.then.findLastIndex((action) => Object.hasOwn(action, "set_state"));
  if (last < 0) rule.then.push({ set_state: state });
  else rule.then[last] = { set_state: state };
  const result = stringify(data);
  parseRules(result);
  return result;
}
