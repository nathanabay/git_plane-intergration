import type { PlaneMember, PlaneState, PlaneWorkspace } from "./types.ts";

export const STATE_GROUP_LABELS: Record<string, string> = { backlog: "Backlog", unstarted: "Not started", started: "In progress", completed: "Completed", cancelled: "Cancelled" };
export const stateTarget = (state: PlaneState): string => `${state.group}:${state.name}`;

/** Shared by lifecycle mappings, branch rules and custom YAML state actions. */
export function StatePicker({ states, value, onChange, label, required = false, disabled = false, valueKind = "target", emptyLabel }: {
  states: PlaneState[]; value: string; onChange(value: string): void; label: string;
  required?: boolean; disabled?: boolean; valueKind?: "target" | "id"; emptyLabel?: string;
}) {
  const choices = states.filter((state) => state.group !== "triage");
  const key = (state: PlaneState) => valueKind === "id" ? state.id : stateTarget(state);
  const known = choices.some((state) => key(state) === value);
  return <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} required={required} disabled={disabled}>
    <option value="">{emptyLabel ?? (required ? "Choose a state" : valueKind === "id" ? "Project default" : "No state change")}</option>
    {value && !known ? <option value={value}>{STATE_GROUP_LABELS[value] ? `${STATE_GROUP_LABELS[value]} (any matching state)` : `Previously selected: ${value}`}</option> : null}
    {choices.map((state) => <option key={state.id} value={key(state)}>{state.name} · {STATE_GROUP_LABELS[state.group] ?? state.group}</option>)}
  </select>;
}

export function MemberPicker({ members, value, onChange, disabled = false }: {
  members: PlaneMember[]; value: string; onChange(value: string): void; disabled?: boolean;
}) {
  return <select aria-label="Plane member" value={value} onChange={(event) => onChange(event.target.value)} required disabled={disabled}>
    <option value="" disabled>Choose a member</option>
    {members.map((member) => <option key={member.id} value={member.id}>{member.name}{member.email && member.name !== member.email ? ` · ${member.email}` : ""}</option>)}
  </select>;
}

export function WorkspacePicker({ workspaces, value, onChange, disabled = false }: {
  workspaces: PlaneWorkspace[]; value: string; onChange(value: string): void; disabled?: boolean;
}) {
  return <select aria-label="Workspace" value={value} onChange={(event) => onChange(event.target.value)} required disabled={disabled}>
    <option value="" disabled>Choose a workspace</option>
    {workspaces.map((workspace) => <option key={workspace.id} value={workspace.slug}>{workspace.name}</option>)}
  </select>;
}
