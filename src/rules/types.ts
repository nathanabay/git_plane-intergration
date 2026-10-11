export type Action =
  | { type: "set_state"; state: string }
  | { type: "add_label"; label: string }
  | { type: "remove_label"; label: string }
  | { type: "assign"; assignee: string }
  | { type: "comment"; body: string }
  | { type: "add_link"; url: string; title: string }
  | { type: "log_time"; duration: string }
  | { type: "create_issue"; project: string; title: string };

export interface RuleConditions {
  base_branch?: string;
  head_branch?: string;
  labels_any?: string[];
  labels_all?: string[];
  author?: string | string[];
  repo?: string | string[];
  project?: string | string[];
}

export interface Rule {
  name?: string;
  when: string[];
  if: RuleConditions;
  then: Action[];
}

export interface RuleEvent {
  trigger: string;
  repo?: string;
  base_branch?: string;
  head_branch?: string;
  labels?: string[];
  author?: string;
  project?: string;
  context?: Record<string, unknown>;
}

export interface Evaluation {
  matched: { index: number; rule: Rule } | null;
  actions: Action[];
}

export interface ActionExecutor {
  execute(action: Action, event: RuleEvent): Promise<unknown>;
}

export interface RunResult {
  evaluation: Evaluation;
  executed: Action[];
  dryRun: boolean;
}
