import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api, failedWriteId, isNotAuthorised, retryFailedWrite } from "./http.ts";
import { Async, ErrorNote, Field, Link, SaveStatus, formatTime, useLoad, useSaver } from "./common.tsx";
import type { Loaded } from "./common.tsx";
import { lookupUser } from "./github.ts";
import { mappingHref, workspaceHref } from "./router.ts";
import type { AppRoute, AuditFilters, MappingTab } from "./router.ts";
import type { AuditPage, BackfillResult, DryRunResult, Mapping, PlaneMember, PlaneProject, PlaneState, Policies, RulesDoc, UserLink, WorkspaceHealth } from "./types.ts";
import { GithubConnectionPanel, PersonalAccountPanel, RepositoryPicker } from "./Connect.tsx";
import type { PickableRepositories } from "./Connect.tsx";
import { DevPanel } from "./DevPanel.tsx";
import { MappingHealthCard, SetupChecklist, WorkspaceHealthBanners } from "./health.tsx";
import { CONFLICT_FIELDS, CONFLICT_POLICIES, DRY_RUN_EVENTS, DRY_RUN_TRIGGERS, SYNC_DIRECTIONS, isValidGithubLogin } from "../validate.ts";
import { MemberPicker, StatePicker } from "./pickers.tsx";
import { mappingFormBody } from "./mapping-form.ts";
import { setRuleState } from "./rule-editor.ts";
import { parseRules } from "../../rules/engine.ts";
import { AuditDetail, auditKindLabel, humanLabel } from "./audit.tsx";
import type { DryRunEvent } from "../validate.ts";
import type { ConflictField, ConflictPolicy, SyncDirection } from "../validate.ts";
import { LIFECYCLES, QLL_DEFAULTS, compileLifecycleRules, parseLifecycleMappingFromYaml } from "../../github/pr-automation.ts";
import type { BranchRule, Lifecycle, LifecycleMapping } from "../../github/pr-automation.ts";

const DENIED = "Workspace settings need a workspace admin.";
const ws = (slug: string) => `/workspaces/${encodeURIComponent(slug)}`;

type WorkspaceRoute = Exclude<AppRoute, { name: "admin" } | { name: "notfound" }>;

export function WorkspacePage({ route }: { route: WorkspaceRoute }) {
  const { slug } = route;
  const adminSection = route.name !== "account" && route.name !== "development";
  const health = useLoad(() => adminSection ? api<WorkspaceHealth>("GET", `${ws(slug)}/health`) : Promise.resolve(null), [slug, adminSection]);
  useEffect(() => { if (!adminSection) return; const timer = setInterval(health.reload, 30_000); return () => clearInterval(timer); }, [adminSection, health.reload]);
  // A plain member may open only their own account page; the admin tabs would just say "needs a workspace admin".
  const access = useLoad(() => route.name === "account"
    ? api<WorkspaceHealth>("GET", `${ws(slug)}/health`).then(() => true, (e) => !isNotAuthorised(e))
    : Promise.resolve(true), [slug, route.name === "account"]);
  const memberOnly = route.name === "account" && access.data === false;
  if (route.name === "development") return <DevPanel route={route} />;
  return (
    <main>
      <h1>Git sync: {slug}</h1>
      {memberOnly ? null : <nav aria-label="Workspace sections" className="tabs">
        <Link href={workspaceHref(slug)} aria-current={route.name === "mappings" || route.name === "mapping" ? "page" : undefined}>Repositories</Link>
        <Link href={workspaceHref(slug, "users")} aria-current={route.name === "users" ? "page" : undefined}>User links</Link>
        <Link href={workspaceHref(slug, "account")} aria-current={route.name === "account" ? "page" : undefined}>My GitHub account</Link>
        <Link href={workspaceHref(slug, "audit")} aria-current={route.name === "audit" ? "page" : undefined}>Audit log</Link>
      </nav>}
      {health.data ? <WorkspaceHealthBanners health={health.data} /> : null}
      {adminSection ? <ErrorNote error={health.error} /> : null}
      {route.name === "account" ? <PersonalAccountPanel slug={slug} /> : null}
      {route.name === "mappings" ? <MappingsPage slug={slug} health={health} /> : null}
      {route.name === "mapping" ? <MappingPage slug={slug} id={route.id} tab={route.tab} /> : null}
      {route.name === "users" ? <UserLinksPage slug={slug} /> : null}
      {route.name === "audit" ? <AuditLogPage slug={slug} filters={route.filters} /> : null}
    </main>
  );
}

// ---- repositories ---------------------------------------------------------------------------------
function MappingsPage({ slug, health }: { slug: string; health: Loaded<WorkspaceHealth | null> }) {
  const list = useLoad(() => api<Mapping[]>("GET", `${ws(slug)}/mappings`), [slug]);
  const projects = useLoad(() => api<PlaneProject[]>("GET", `${ws(slug)}/projects`), [slug]);
  const [addedMapping, setAddedMapping] = useState<number | null>(null);
  useEffect(() => { setAddedMapping(null); }, [slug]);
  const remove = useSaver();
  return (
    <>
      <PersonalAccountPanel slug={slug} />
      <GithubConnectionPanel slug={slug} />
      <button type="button" onClick={health.reload}>Refresh sync health</button>
      {addedMapping !== null ? <section className="panel" aria-label="Mapping added">
        <h2>Repository mapped</h2><BackfillPanel key={addedMapping} slug={slug} id={addedMapping} offer />
        <button type="button" onClick={() => setAddedMapping(null)}>Not now</button>
      </section> : null}
      <section className="panel" aria-labelledby="maps-h">
        <h2 id="maps-h">Mapped repositories</h2>
        <Async state={list} denied={DENIED}>
          {(maps) => maps.length === 0 ? <><p>No repository is mapped to a project in this workspace yet.</p>
            {health.data ? <SetupChecklist slug={slug} setup={health.data.setup} /> : <p>Loading setup checklist…</p>}</> : (
            <table>
              <thead><tr><th>Repository</th><th>Plane project</th><th>Direction</th><th>Sync health</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {maps.map((m) => (
                  <tr key={m.id}>
                    <td>{m.ghRepoFullName}</td>
                    <td>{projects.data?.find((project) => project.id === m.planeProjectId)?.label ?? (projects.loading ? "Loading project…" : "Project unavailable")}</td>
                    <td>{m.syncDirection === "bidirectional" ? "Two-way" : "GitHub to Plane"}</td>
                    <td>{health.data?.mappings.find((item) => item.mappingId === m.id) ? <MappingHealthCard slug={slug} health={health.data.mappings.find((item) => item.mappingId === m.id)!} /> : "Health unavailable"}</td>
                    <td className="actions">
                      <Link href={mappingHref(slug, m.id, "settings")}>Edit</Link>
                      <button type="button" className="danger" disabled={remove.busy}
                        onClick={async () => {
                          if (!window.confirm(`Remove the mapping for ${m.ghRepoFullName}? Its rules and conflict policies are deleted too.`)) return;
                          if (await remove.run(() => api("DELETE", `${ws(slug)}/mappings/${m.id}`))) list.reload();
                        }}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Async>
        <SaveStatus saver={remove} />
        <ErrorNote error={projects.error} />
        {projects.error ? <button type="button" onClick={projects.reload}>Reload project names</button> : null}
      </section>
      {list.error && isNotAuthorised(list.error) ? null : (
        <section className="panel" aria-labelledby="new-h">
          <h2 id="new-h">Map a repository</h2>
          <MappingForm slug={slug} onSaved={(id) => { list.reload(); health.reload(); if (id !== undefined) setAddedMapping(id); }} />
        </section>
      )}
    </>
  );
}

export function MappingForm({ slug, existing, onSaved }: { slug: string; existing?: Mapping; onSaved(id?: number): void }) {
  const [repoName, setRepoName] = useState(existing?.ghRepoFullName ?? "");
  const [repoId, setRepoId] = useState(existing ? String(existing.ghRepoId) : "");
  const [project, setProject] = useState(existing?.planeProjectId ?? "");
  const [direction, setDirection] = useState<SyncDirection>(existing?.syncDirection ?? "bidirectional");
  const [smart, setSmart] = useState<boolean | undefined>(undefined);
  const defaults = useLoad(() => existing ? Promise.resolve({ smartCommitsDefault: existing.smartCommitsEnabled })
    : api<{ smartCommitsDefault: boolean }>("GET", `${ws(slug)}/defaults`), [slug, existing?.id]);
  const [linkback, setLinkback] = useState(existing?.linkbackComments ?? true);
  const [reportProblems, setReportProblems] = useState(existing?.reportProblems ?? false);
  // C4: per-mapping open/closed Plane states (state ids); empty means the project default.
  const stored = existing as (Mapping & { openStateId?: string | null; closedStateId?: string | null }) | undefined;
  const [openState, setOpenState] = useState(stored?.openStateId ?? "");
  const [closedState, setClosedState] = useState(stored?.closedStateId ?? "");
  const states = useLoad(() => project ? api<PlaneState[]>("GET", `${ws(slug)}/projects/${encodeURIComponent(project)}/states`) : Promise.resolve([] as PlaneState[]), [slug, project]);
  const sameState = openState !== "" && openState === closedState;
  const repositories = useLoad(() => api<PickableRepositories>("GET", `${ws(slug)}/github/repositories`), [slug]);
  const projects = useLoad(() => api<PlaneProject[]>("GET", `${ws(slug)}/projects`), [slug]);
  const saver = useSaver();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = mappingFormBody({
      ghRepoId: Number(repoId), ghRepoFullName: repoName.trim(), planeProjectId: project.trim(), syncDirection: direction,
      linkbackComments: linkback, reportProblems,
    }, smart);
    const withStates = { ...body, openStateId: openState || null, closedStateId: closedState || null };
    let savedId: number | undefined;
    const ok = await saver.run(async () => {
      const saved = await api<{ id: number }>(existing ? "PATCH" : "POST", existing ? `${ws(slug)}/mappings/${existing.id}` : `${ws(slug)}/mappings`, withStates);
      savedId = saved.id;
    });
    if (ok) {
      if (!existing) { setRepoName(""); setRepoId(""); setProject(""); setSmart(undefined); setOpenState(""); setClosedState(""); setReportProblems(false); defaults.reload(); }
      onSaved(savedId);
    }
  };

  return (
    <form onSubmit={submit}>
      <Field label="GitHub repository" hint="Repositories your account can access in this workspace's connected installations.">
        <RepositoryPicker repositories={repositories.data?.repositories ?? []} value={repoId ? Number(repoId) : null} disabled={repositories.loading || !!repositories.error}
          onChange={(repo) => { setRepoId(String(repo.id)); setRepoName(repo.fullName); }} />
      </Field>
      <ErrorNote error={repositories.error} /><button type="button" onClick={repositories.reload}>Refresh repositories</button>
      {repositories.data?.needsGithubAccount || repositories.data?.needsReauth ? <p><Link href={workspaceHref(slug, "account")}>{repositories.data.needsReauth ? "Reconnect" : "Connect"} your personal GitHub account to select a repository.</Link></p> : null}
      {repositories.data && !repositories.data.needsGithubAccount && !repositories.data.needsReauth && !repositories.data.repositories.length ? <p>No repositories available. Connect an installation or ask its owner to grant repository access.</p> : null}
      <Field label="Plane project">
          <select value={project} onChange={(e) => { setProject(e.target.value); setOpenState(""); setClosedState(""); }} required disabled={projects.loading || !!projects.error}>
            <option value="" disabled>Choose a project</option>
            {project && !projects.data?.some((p) => p.id === project) ? <option value={project}>Previously selected project (unavailable)</option> : null}
            {(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
      </Field>
      <ErrorNote error={projects.error} />
      {projects.error ? <button type="button" onClick={projects.reload}>Reload projects</button> : null}
      {!projects.loading && projects.data?.length === 0 ? <p>No projects are available in this workspace.</p> : null}
      <Field label="Open state" hint="Where an issue goes when it is reopened on GitHub (and where new open issues start). Leave empty for the project's default not-started state; new issues then keep Plane's default state.">
        <StatePicker states={states.data ?? []} valueKind="id" label="Open state" value={openState} onChange={setOpenState} disabled={!project || states.loading || !!states.error} />
      </Field>
      <Field label="Closed state" hint="Where an issue goes when it is closed on GitHub. Leave empty for the project's default completed state.">
        <StatePicker states={states.data ?? []} valueKind="id" label="Closed state" value={closedState} onChange={setClosedState} disabled={!project || states.loading || !!states.error} />
      </Field>
      {sameState ? <p className="error" role="alert">Choose different states for open and closed.</p> : null}
      <ErrorNote error={states.error} />
      {states.error ? <button type="button" onClick={states.reload}>Reload states</button> : null}
      <Field label="Sync direction" hint="Two-way mirrors issues both ways; GitHub to Plane only never writes back to GitHub.">
        <select value={direction} onChange={(e) => setDirection(e.target.value as SyncDirection)}>
          {SYNC_DIRECTIONS.map((d) => <option key={d} value={d}>{d === "bidirectional" ? "Two-way" : "GitHub to Plane only"}</option>)}
        </select>
      </Field>
      <label className="check"><input type="checkbox" checked={smart ?? existing?.smartCommitsEnabled ?? defaults.data?.smartCommitsDefault ?? false}
        disabled={!existing && defaults.data === null} onChange={(e) => setSmart(e.target.checked)} /><span>Smart Commits</span></label>
      {!existing && defaults.loading ? <p className="hint">Loading instance default…</p> : null}
      <ErrorNote error={defaults.error} />
      {defaults.error ? <button type="button" onClick={defaults.reload}>Reload defaults</button> : null}
      <label className="check"><input type="checkbox" checked={linkback} onChange={(e) => setLinkback(e.target.checked)} /><span>Post link-back comments on GitHub</span></label>
      <label className="check"><input type="checkbox" checked={reportProblems} onChange={(e) => setReportProblems(e.target.checked)} /><span>Report problems as comments on GitHub and Plane</span></label>
      <label className="check"><input type="checkbox" checked={existing?.autolinks ?? false} disabled /><span>GitHub autolink references (unavailable)</span></label>
      <button type="submit" disabled={saver.busy || sameState || (!existing && defaults.data === null) || !projects.data || !repositories.data?.repositories.some((repo) => repo.id === Number(repoId))}>{existing ? "Save changes" : "Add mapping"}</button>
      <SaveStatus saver={saver} />
    </form>
  );
}

// ---- one mapping: settings, conflict policies, rules ----------------------------------------------
const TAB_LABELS: Record<MappingTab, string> = { settings: "Settings", policies: "Conflict policies", rules: "Rules", "dry-run": "Test rules" };

function MappingPage({ slug, id, tab }: { slug: string; id: number; tab: MappingTab }) {
  const list = useLoad(() => api<Mapping[]>("GET", `${ws(slug)}/mappings`), [slug]);
  return (
    <Async state={list} denied={DENIED}>
      {(maps) => {
        const mapping = maps.find((m) => m.id === id);
        if (!mapping) return <section className="panel"><p>That mapping does not exist in this workspace.</p><Link href={workspaceHref(slug)}>Back to repositories</Link></section>;
        return (
          <section className="panel">
            <h2>{mapping.ghRepoFullName}</h2>
            <nav aria-label="Mapping sections" className="tabs">
              {(Object.keys(TAB_LABELS) as MappingTab[]).map((t) => (
                <Link key={t} href={mappingHref(slug, id, t)} aria-current={t === tab ? "page" : undefined}>{TAB_LABELS[t]}</Link>
              ))}
            </nav>
            {tab === "settings" ? <><MappingForm key={`${id}:${mapping.smartCommitsEnabled}:${mapping.autolinks}`} slug={slug} existing={mapping} onSaved={list.reload} /><BackfillPanel slug={slug} id={id} /></> : null}
            {tab === "dry-run" ? <DryRunPanel slug={slug} id={id} /> : null}
            {tab === "policies" ? <PoliciesEditor slug={slug} id={id} /> : null}
            {tab === "rules" ? <RulesEditor slug={slug} id={id} projectId={mapping.planeProjectId} /> : null}
          </section>
        );
      }}
    </Async>
  );
}

const FIELD_LABELS: Record<ConflictField, string> = {
  title: "Title", description: "Description", state: "State", assignees: "Assignees", labels: "Labels", comments: "Comments",
};
const POLICY_LABELS: Record<ConflictPolicy, string> = {
  last_write_wins: "Last write wins",
  "source_of_truth:github": "GitHub is the source of truth",
  "source_of_truth:plane": "Plane is the source of truth",
};

function PoliciesEditor({ slug, id }: { slug: string; id: number }) {
  const policies = useLoad(() => api<Policies>("GET", `${ws(slug)}/mappings/${id}/conflict-policies`), [slug, id]);
  return <Async state={policies} denied={DENIED}>{(p) => <PolicyFields slug={slug} id={id} initial={p} />}</Async>;
}

function PolicyFields({ slug, id, initial }: { slug: string; id: number; initial: Policies }) {
  const [values, setValues] = useState<Policies>(initial);
  const saver = useSaver();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await saver.run(() => api("PUT", `${ws(slug)}/mappings/${id}/conflict-policies`, values));
  };
  return (
    <form onSubmit={submit}>
      <p>Which side wins when both change the same field between syncs.</p>
      {CONFLICT_FIELDS.map((f) => (
        <Field key={f} label={FIELD_LABELS[f]}>
          <select value={values[f]} onChange={(e) => setValues({ ...values, [f]: e.target.value as ConflictPolicy })}>
            {CONFLICT_POLICIES.map((p) => <option key={p} value={p}>{POLICY_LABELS[p]}</option>)}
          </select>
        </Field>
      ))}
      <button type="submit" disabled={saver.busy}>Save policies</button>
      <SaveStatus saver={saver} />
    </form>
  );
}

function RulesEditor({ slug, id, projectId }: { slug: string; id: number; projectId: string }) {
  const rules = useLoad(() => api<RulesDoc>("GET", `${ws(slug)}/mappings/${id}/rules`), [slug, id]);
  const versions = useLoad(() => api<Omit<RulesDoc, "yaml">[]>("GET", `${ws(slug)}/mappings/${id}/rules/versions`), [slug, id]);
  const members = useLoad(() => api<PlaneMember[]>("GET", `${ws(slug)}/members`), [slug]);
  const states = useLoad(() => api<PlaneState[]>("GET", `${ws(slug)}/projects/${encodeURIComponent(projectId)}/states`), [slug, projectId]);
  const restore = useSaver();
  return <>
    <ErrorNote error={states.error} />
    {states.error ? <button type="button" onClick={states.reload}>Reload states</button> : null}
    <Async state={rules} denied={DENIED}>{(r) => <RulesFields key={`${id}:${r.version}`} slug={slug} id={id} initial={r}
      states={states.data ?? []} statesLoading={states.loading} onSaved={() => { rules.reload(); versions.reload(); }} />}</Async>
    <h3>Rule versions</h3>
    <ErrorNote error={members.error} />
    {members.error ? <button type="button" onClick={members.reload}>Reload author names</button> : null}
    <Async state={versions} denied={DENIED}>{(history) => <RuleVersions versions={history} members={members.data ?? []}
      currentVersion={rules.data?.version ?? 0} busy={restore.busy} onRestore={async (version) => {
        if (!window.confirm(`Restore version ${version}? This creates a new version and replaces unsaved editor changes.`)) return;
        await restore.run(async () => {
          await api("POST", `${ws(slug)}/mappings/${id}/rules/versions/${version}/restore`);
          rules.set(await api<RulesDoc>("GET", `${ws(slug)}/mappings/${id}/rules`));
          versions.reload();
        });
      }} />}</Async>
    <SaveStatus saver={restore} />
  </>;
}

export function RuleVersions({ versions, members, currentVersion, busy, onRestore }: {
  versions: Omit<RulesDoc, "yaml">[]; members: PlaneMember[]; currentVersion: number; busy: boolean; onRestore(version: number): void;
}) {
  if (!versions.length) return <p>No saved versions yet.</p>;
  return <table><thead><tr><th>Version</th><th>Saved by</th><th>Saved at</th><th>Action</th></tr></thead>
    <tbody>{versions.map((version) => <tr key={version.version}>
      <td>{version.version}{version.version === currentVersion ? " (current)" : ""}</td>
      <td>{version.updatedBy ? members.find((member) => member.id === version.updatedBy)?.name ?? "Former or unavailable member" : "System"}</td>
      <td>{formatTime(version.updatedAt)}</td>
      <td><button type="button" disabled={busy || version.version === currentVersion} onClick={() => onRestore(version.version)}>Restore</button></td>
    </tr>)}</tbody></table>;
}

const LIFECYCLE_LABELS: Record<Lifecycle, string> = {
  branch_pushed: "Branch pushed",
  drafted: "PR drafted",
  opened: "PR opened",
  review_requested: "Review requested",
  changes_requested: "Changes requested",
  approved: "PR approved",
  ready_for_merge: "Ready for merge",
  merged: "PR merged",
  closed_unmerged: "PR closed without merge",
  reopened: "PR reopened",
};

export function RulesFields({ slug, id, initial, states = [], statesLoading = false, onSaved = () => {} }: {
  slug: string; id: number; initial: RulesDoc; states?: PlaneState[]; statesLoading?: boolean; onSaved?(): void;
}) {
  const initialMapping = initial.version > 0 && initial.yaml.trim()
    ? parseLifecycleMappingFromYaml(initial.yaml)
    : QLL_DEFAULTS;
  const initialMode = initial.version > 0 && !initialMapping ? "yaml" : "table";
  const [mode, setMode] = useState<"table" | "yaml">(initialMode);
  const [mapping, setMapping] = useState<LifecycleMapping>(initialMapping ?? QLL_DEFAULTS);
  const [yaml, setYaml] = useState(
    initial.version > 0 && initial.yaml.trim()
      ? initial.yaml
      : compileLifecycleRules(QLL_DEFAULTS)
  );
  const [version, setVersion] = useState(initial.version);
  const [selectedRule, setSelectedRule] = useState("0");
  const [selectedState, setSelectedState] = useState("");
  const saver = useSaver();
  let yamlRules: ReturnType<typeof parseRules> = [];
  try { yamlRules = parseRules(yaml); } catch { /* Invalid drafts remain editable. */ }

  const handleStateChange = (lc: Lifecycle, value: string) => {
    setMapping((prev) => ({
      ...prev,
      states: { ...prev.states, [lc]: value },
    }));
    saver.clear();
  };

  const handleBranchRuleChange = (index: number, field: keyof BranchRule, value: string) => {
    setMapping((prev) => {
      const nextRules = [...prev.branchRules];
      const cur = nextRules[index] ?? { baseBranch: "", lifecycle: "merged" as Lifecycle, state: "" };
      nextRules[index] = { ...cur, [field]: value };
      return { ...prev, branchRules: nextRules };
    });
    saver.clear();
  };

  const addBranchRule = () => {
    setMapping((prev) => ({
      ...prev,
      branchRules: [...prev.branchRules, { baseBranch: "^staging$", lifecycle: "merged", state: "" }],
    }));
    saver.clear();
  };

  const removeBranchRule = (index: number) => {
    setMapping((prev) => ({
      ...prev,
      branchRules: prev.branchRules.filter((_, i) => i !== index),
    }));
    saver.clear();
  };

  const switchToYaml = () => {
    try {
      const cleanStates: Partial<Record<Lifecycle, string>> = {};
      for (const lc of LIFECYCLES) {
        const val = mapping.states[lc]?.trim();
        if (val) cleanStates[lc] = val;
      }
      const compiled = compileLifecycleRules({
        states: cleanStates,
        mergedBaseBranch: mapping.mergedBaseBranch.trim() || "^main$",
        branchRules: mapping.branchRules.map((r) => ({
          baseBranch: r.baseBranch.trim(),
          lifecycle: r.lifecycle,
          state: r.state.trim(),
        })),
      });
      setYaml(compiled);
    } catch {
      // Keep current yaml if compile fails
    }
    setMode("yaml");
  };

  const switchToTable = () => {
    const parsed = parseLifecycleMappingFromYaml(yaml);
    if (parsed) {
      setMapping(parsed);
      setMode("table");
    } else {
      if (typeof window !== "undefined" && !window.confirm("The current YAML contains custom rules or manual edits that cannot be represented in the table. Switching to table mode will replace your rules with defaults upon save. Discard custom YAML?")) {
        return;
      }
      setMapping(QLL_DEFAULTS);
      setMode("table");
    }
  };

  const submitTable = async (e: FormEvent) => {
    e.preventDefault();
    if (initial.version > 0 && !parseLifecycleMappingFromYaml(yaml)) {
      if (typeof window !== "undefined" && !window.confirm("Saving the mapping table will overwrite your custom YAML rules. Overwrite?")) {
        return;
      }
    }
    await saver.run(async () => {
      const cleanStates: Partial<Record<Lifecycle, string>> = {};
      for (const lc of LIFECYCLES) {
        const val = mapping.states[lc]?.trim();
        if (val) cleanStates[lc] = val;
      }
      const compiled = compileLifecycleRules({
        states: cleanStates,
        mergedBaseBranch: mapping.mergedBaseBranch.trim() || "^main$",
        branchRules: mapping.branchRules.map((r) => ({
          baseBranch: r.baseBranch.trim(),
          lifecycle: r.lifecycle,
          state: r.state.trim(),
        })),
      });
      const r = await api<{ version: number }>("PUT", `${ws(slug)}/mappings/${id}/rules`, { yaml: compiled });
      setVersion(r.version);
      setYaml(compiled);
      onSaved();
    });
  };

  const submitYaml = async (e: FormEvent) => {
    e.preventDefault();
    await saver.run(async () => {
      const r = await api<{ version: number }>("PUT", `${ws(slug)}/mappings/${id}/rules`, { yaml });
      setVersion(r.version);
      const parsed = parseLifecycleMappingFromYaml(yaml);
      if (parsed) setMapping(parsed);
      onSaved();
    });
  };

  return (
    <div>
      <p>
        Rules decide what happens on each GitHub event. State mappings are rules too, for example
        <code> when: pull_request.merged </code> then <code> set_state: completed:Done</code>.
        {version > 0 ? ` Saved version ${version}.` : " Using shipping defaults (not saved yet)."}
      </p>
      <div style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
        <button
          type="button"
          onClick={mode === "table" ? undefined : switchToTable}
          style={mode === "table" ? { fontWeight: "bold", borderColor: "var(--accent)" } : undefined}
        >
          Lifecycle mapping table
        </button>
        <button
          type="button"
          onClick={mode === "yaml" ? undefined : switchToYaml}
          style={mode === "yaml" ? { fontWeight: "bold", borderColor: "var(--accent)" } : undefined}
        >
          Raw YAML editor
        </button>
      </div>

      {mode === "table" ? (
        <form onSubmit={submitTable}>
          <h3>Lifecycle points → Plane state</h3>
          <p className="hint" style={{ marginBottom: "12px" }}>
            Choose a project state for each event. Leave it empty for no state change.
          </p>
          <table>
            <thead>
              <tr>
                <th style={{ width: "220px" }}>Lifecycle event</th>
                <th>Target state</th>
              </tr>
            </thead>
            <tbody>
              {LIFECYCLES.map((lc) => (
                <tr key={lc}>
                  <td>
                    <strong>{LIFECYCLE_LABELS[lc]}</strong>
                  </td>
                  <td>
                    <StatePicker states={states} label={`${LIFECYCLE_LABELS[lc]} target state`} disabled={statesLoading}
                      value={mapping.states[lc] ?? ""}
                      onChange={(value) => handleStateChange(lc, value)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ marginTop: "16px" }}>
            <Field label="Merged base-branch regex" hint="The PR base branch must match this regex for the merged state to apply (default: ^main$).">
              <input
                value={mapping.mergedBaseBranch}
                onChange={(e) => { setMapping({ ...mapping, mergedBaseBranch: e.target.value }); saver.clear(); }}
                required
                placeholder="^main$"
              />
            </Field>
          </div>

          <h3>Branch-aware rules</h3>
          <p className="hint">
            Evaluated before defaults; first match wins. Useful for staging/release branch flows.
          </p>
          {mapping.branchRules.length > 0 ? (
            <table style={{ marginBottom: "12px" }}>
              <thead>
                <tr>
                  <th>Base branch (regex)</th>
                  <th>Lifecycle</th>
                  <th>Target state</th>
                  <th><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {mapping.branchRules.map((rule, idx) => (
                  <tr key={idx}>
                    <td>
                      {rule.lifecycle === "branch_pushed" ? (
                        <span className="hint">N/A (branch has no base)</span>
                      ) : (
                        <input
                          value={rule.baseBranch}
                          onChange={(e) => handleBranchRuleChange(idx, "baseBranch", e.target.value)}
                          placeholder="^staging$"
                          required
                        />
                      )}
                    </td>
                    <td>
                      <select
                        value={rule.lifecycle}
                        onChange={(e) => handleBranchRuleChange(idx, "lifecycle", e.target.value as Lifecycle)}
                      >
                        {LIFECYCLES.map((l) => (
                          <option key={l} value={l}>{LIFECYCLE_LABELS[l]}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <StatePicker states={states} label={`Branch rule ${idx + 1} target state`} disabled={statesLoading}
                        value={rule.state}
                        onChange={(value) => handleBranchRuleChange(idx, "state", value)}
                        required
                      />
                    </td>
                    <td className="actions">
                      <button type="button" className="danger" onClick={() => removeBranchRule(idx)}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="hint" style={{ marginBottom: "12px" }}>No branch-specific rules configured.</p>
          )}
          <button type="button" onClick={addBranchRule} style={{ marginBottom: "16px" }}>+ Add branch rule</button>

          <div>
            <button type="submit" disabled={saver.busy}>Save mapping table</button>
            <SaveStatus saver={saver} />
          </div>
        </form>
      ) : (
        <form onSubmit={submitYaml}>
          <Field
            label="Rules (YAML)"
            hint="Use lifecycle, branch, push, check, deployment, issue or comment triggers. Test rules before saving."
          >
            <textarea
              className="code"
              rows={16}
              value={yaml}
              onChange={(e) => { setYaml(e.target.value); saver.clear(); }}
              spellCheck={false}
            />
          </Field>
          <p className="hint">Example: <code>{'- when: pull_request.merged\n  then: [{set_state: "completed:Done"}]'}</code></p>
          <Field label="Rule to update">
            <select value={selectedRule} onChange={(event) => setSelectedRule(event.target.value)} disabled={!yamlRules.length}>
              {yamlRules.map((rule, index) => <option key={index} value={index}>{rule.name ?? `Rule ${index + 1}`} · {rule.when.join(", ")}</option>)}
            </select>
          </Field>
          <Field label="Target state"><StatePicker states={states} value={selectedState} onChange={setSelectedState}
            label="Custom rule target state" disabled={statesLoading} /></Field>
          <button type="button" disabled={!selectedState || !yamlRules[Number(selectedRule)]} onClick={() => {
            try { setYaml(setRuleState(yaml, Number(selectedRule), selectedState)); saver.clear(); }
            catch (error) { void saver.run(async () => { throw error; }); }
          }}>Apply state to selected rule</button>
          <button type="submit" disabled={saver.busy}>Validate and save YAML</button>
          <SaveStatus saver={saver} />
        </form>
      )}
    </div>
  );
}

// ---- user links -----------------------------------------------------------------------------------
function UserLinksPage({ slug }: { slug: string }) {
  const links = useLoad(() => api<UserLink[]>("GET", `${ws(slug)}/user-links`), [slug]);
  const members = useLoad(() => api<PlaneMember[]>("GET", `${ws(slug)}/members`), [slug]);
  const unlink = useSaver();
  return (
    <>
      <PersonalAccountPanel slug={slug} />
      <section className="panel" aria-labelledby="links-h">
        <h2 id="links-h">Linked GitHub accounts</h2>
        <Async state={links} denied={DENIED}>
          {(list) => list.length === 0 ? <p>No Plane users are linked to GitHub accounts yet. Unlinked users are attributed to the service account.</p> : (
            <table>
              <thead><tr><th>Plane member</th><th>GitHub account</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {list.map((l) => (
                  <tr key={l.planeUserId}>
                    <td>{members.data?.find((member) => member.id === l.planeUserId)?.name ?? (members.loading ? "Loading member…" : "Former or unavailable member")}</td>
                    <td>{l.githubLogin}{l.needsReauth ? <p className="error">Needs re-authorization. <Link role="button" href={workspaceHref(slug, "account")}>Reconnect</Link> using this member’s own Plane session.</p> : null}</td>
                    <td className="actions">
                      <button type="button" className="danger" disabled={unlink.busy}
                        onClick={async () => {
                          if (!window.confirm(`Unlink ${l.githubLogin}? Any credentials stored for this user are deleted.`)) return;
                          if (await unlink.run(() => api("DELETE", `${ws(slug)}/user-links/${encodeURIComponent(l.planeUserId)}`))) links.reload();
                        }}>Unlink</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Async>
        <SaveStatus saver={unlink} />
        <ErrorNote error={members.error} />
        {members.error ? <button type="button" onClick={members.reload}>Reload member names</button> : null}
      </section>
      {links.error && isNotAuthorised(links.error) ? null : (
        <section className="panel" aria-labelledby="link-new-h">
          <h2 id="link-new-h">Link a user</h2>
          <LinkForm slug={slug} onSaved={links.reload} />
        </section>
      )}
    </>
  );
}

export function LinkForm({ slug, onSaved }: { slug: string; onSaved(): void }) {
  const [userId, setUserId] = useState("");
  const [login, setLogin] = useState("");
  const [ghId, setGhId] = useState("");
  const [lookupError, setLookupError] = useState<string | null>(null);
  const saver = useSaver();
  const members = useLoad(() => api<PlaneMember[]>("GET", `${ws(slug)}/members`), [slug]);
  const lookup = async () => {
    setLookupError(null);
    try {
      const u = await lookupUser(slug, login.trim());
      setLogin(u.login);
      setGhId(String(u.id));
    } catch (e) {
      setLookupError(e instanceof Error ? e.message : "Lookup failed");
    }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await saver.run(() => api("PUT", `${ws(slug)}/user-links/${encodeURIComponent(userId.trim())}`, {
      githubLogin: login.trim(), githubId: Number(ghId),
    }));
    if (ok) { setUserId(""); setLogin(""); setGhId(""); onSaved(); }
  };
  return (
    <form onSubmit={submit}>
      <Field label="Plane member">
        <MemberPicker members={members.data ?? []} value={userId} onChange={setUserId} disabled={members.loading || !!members.error} />
      </Field>
      <ErrorNote error={members.error} />
      {members.error ? <button type="button" onClick={members.reload}>Reload members</button> : null}
      {!members.loading && members.data?.length === 0 ? <p>No active members are available.</p> : null}
      <Field label="GitHub username">
        <span className="row">
          <input value={login} onChange={(e) => setLogin(e.target.value)} required />
          <button type="button" onClick={lookup} disabled={!isValidGithubLogin(login.trim())}>Look up id</button>
        </span>
      </Field>
      <Field label="GitHub user id" hint="Numeric and stable across renames.">
        <input inputMode="numeric" value={ghId} onChange={(e) => setGhId(e.target.value)} required />
      </Field>
      {lookupError ? <p className="error" role="alert">{lookupError}</p> : null}
      <button type="submit" disabled={saver.busy || !userId || !members.data}>Link account</button>
      <SaveStatus saver={saver} />
    </form>
  );
}

// ---- audit log ------------------------------------------------------------------------------------
export function AuditLogPage({ slug, filters = {} }: { slug?: string; filters?: AuditFilters }) {
  const params = new URLSearchParams({ limit: "50", ...(filters.mappingId ? { mappingId: String(filters.mappingId) } : {}),
    ...(filters.errorsOnly ? { errors: "1" } : {}), ...(filters.hours ? { hours: String(filters.hours) } : {}), ...(filters.allWorkspaces ? { scope: "all" } : {}) });
  const endpoint = slug ? `${ws(slug)}/audit` : "/instance/audit";
  const query = params.toString();
  const first = useLoad(() => api<AuditPage>("GET", `${endpoint}?${query}`), [endpoint, query]);
  const [more, setMore] = useState<AuditPage["entries"]>([]);
  const [cursor, setCursor] = useState<number | null | undefined>(undefined);
  const saver = useSaver();
  const replay = useSaver();
  const retry = useSaver();
  const [retried, setRetried] = useState<Set<string>>(new Set());
  useEffect(() => { setRetried(new Set()); }, [slug]);
  useEffect(() => { setMore([]); setCursor(undefined); }, [endpoint, query, first.data]);
  const next = cursor === undefined ? first.data?.nextBefore ?? null : cursor;
  return (
    <section className="panel" aria-labelledby="audit-h">
      <h2 id="audit-h">Audit log</h2>
      {filters.errorsOnly ? <p>Errors{filters.hours ? ` in the last ${filters.hours} hours` : ""}{filters.mappingId ? ` for mapping ${filters.mappingId}` : ""}.</p> : null}
      {!slug ? <p>{filters.allWorkspaces ? "Showing instance and workspace activity." : "Showing activity with no workspace."}</p> : null}
      <Async state={first as Loaded<AuditPage>} denied={slug ? DENIED : "A Plane instance-admin session is required."}>
        {(page) => {
          const entries = [...page.entries, ...more];
          if (entries.length === 0) return <p>No activity matches this view.</p>;
          return (
            <>
              <table>
                <thead><tr><th>When</th>{!slug ? <th>Workspace</th> : null}<th>Event</th><th>Outcome</th><th>Detail</th><th><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id}>
                      <td>{formatTime(e.createdAt)}</td>
                      {!slug ? <td>{e.workspaceSlug ? <Link href={workspaceHref(e.workspaceSlug, "audit")}>View workspace activity</Link> : "Instance"}</td> : null}
                      <td>{auditKindLabel(e.kind)}{e.source ? <span className="hint"> · {e.source === "github" ? "GitHub" : "Plane"}</span> : null}</td>
                      <td className={e.error ? "error" : undefined}>{humanLabel(e.outcome)}</td>
                      <td><AuditDetail entry={e} /></td>
                      <td className="actions">
                        {slug && e.kind === "inbound_delivery" ? (
                          <button type="button" disabled={replay.busy} onClick={async () => {
                            if (!window.confirm("Replay this delivery? It runs again under a new delivery id and may write to Plane and GitHub.")) return;
                            if (await replay.run(() => api("POST", `${ws(slug)}/audit/${e.id}/replay`))) first.reload();
                          }}>Replay</button>
                        ) : null}
                        {slug && failedWriteId(e) ? (
                          <FailedWriteRetry slug={slug} id={failedWriteId(e)!} busy={retry.busy}
                            retried={retried.has(failedWriteId(e)!)} run={retry.run} onScheduled={(id) => {
                              setRetried((ids) => new Set([...ids, id]));
                              first.reload();
                            }} />
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {next !== null ? (
                <button type="button" disabled={saver.busy} onClick={() => saver.run(async () => {
                  const p = await api<AuditPage>("GET", `${endpoint}?${query}&before=${next}`);
                  setMore((m) => [...m, ...p.entries]);
                  setCursor(p.nextBefore);
                })}>Load older entries</button>
              ) : null}
              <SaveStatus saver={saver} />
              <SaveStatus saver={replay} />
              <SaveStatus saver={retry} />
            </>
          );
        }}
      </Async>
    </section>
  );
}

export function FailedWriteRetry({ slug, id, busy, retried, run, onScheduled }: {
  slug: string; id: string; busy: boolean; retried: boolean;
  run(work: () => Promise<unknown>): Promise<boolean>; onScheduled(id: string): void;
}) {
  return <button type="button" disabled={busy || retried} onClick={async () => {
    if (await run(() => retryFailedWrite(slug, id))) onScheduled(id);
  }}>{retried ? "Retry scheduled" : "Retry"}</button>;
}


// ---- operations (§7.6) ----------------------------------------------------------------------------
export function BackfillControls({ busy, offer, result, onStart, onContinue }: { busy: boolean; offer: boolean; result: BackfillResult | null; onStart(): void; onContinue(): void }) {
  return <><button type="button" disabled={busy} onClick={onStart}>{offer ? "Link existing open PRs and issues now" : "Run backfill"}</button>
    {result?.complete === false && result.cursor ? <button type="button" disabled={busy} onClick={onContinue}>Continue</button> : null}</>;
}
export function BackfillPanel({ slug, id, offer = false }: { slug: string; id: number; offer?: boolean }) {
  const saver = useSaver();
  const [result, setResult] = useState<BackfillResult | null>(null);
  return (
    <section aria-labelledby="backfill-h">
      <h3 id="backfill-h">Backfill</h3>
      <p>Link this repository's open pull requests and issues to the Plane work items they mention.</p>
      <BackfillControls busy={saver.busy} offer={offer} result={result} onStart={() => { void saver.run(async () => {
        setResult(await api<BackfillResult>("POST", `${ws(slug)}/mappings/${id}/backfill`));
      }); }} onContinue={() => { if (result?.complete === false && result.cursor) void saver.run(async () => {
        setResult(await api<BackfillResult>("POST", `${ws(slug)}/mappings/${id}/backfill`, { cursor: result.cursor }));
      }); }} />
      <SaveStatus saver={saver} />
      {result ? (
        <p aria-live="polite">
          Checked {result.pullRequests} pull requests and {result.issues} issues: {result.linked} links made, {result.unresolved} references did not match a work item.
          {result.complete === false ? " More items remain; continue to check the next batch." : null}
        </p>
      ) : null}
    </section>
  );
}

export function DryRunPanel({ slug, id }: { slug: string; id: number }) {
  const [event, setEvent] = useState<DryRunEvent>("pull_request");
  const [mode, setMode] = useState<"delivery" | "trigger">("delivery");
  const [trigger, setTrigger] = useState("pull_request.opened");
  const [source, setSource] = useState<"github" | "plane">("github");
  const [payload, setPayload] = useState("");
  const [auditId, setAuditId] = useState("");
  const [yaml, setYaml] = useState("");
  const [result, setResult] = useState<DryRunResult | null>(null);
  const saver = useSaver();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setResult(null);
    await saver.run(async () => {
      const body: Record<string, unknown> = { mappingId: id, ...(mode === "trigger" ? { trigger } : { event, source }) };
      if (mode === "delivery" && auditId.trim()) body.auditId = Number(auditId);
      else {
        try { body.payload = JSON.parse(payload); } catch { throw new Error("The payload is not valid JSON"); }
      }
      if (yaml.trim()) body.yaml = yaml;
      setResult(await api<DryRunResult>("POST", `${ws(slug)}/dry-run`, body));
    });
  };
  return (
    <form onSubmit={submit}>
      <p>Run a delivery through the rules without writing anything. Leave the rules empty to use this mapping's saved rules.</p>
      <Field label="Test input">
        <select value={mode} onChange={(event) => setMode(event.target.value as "delivery" | "trigger")}>
          <option value="delivery">Webhook delivery</option><option value="trigger">Specific rule trigger</option>
        </select>
      </Field>
      {mode === "delivery" ? <>
      <Field label="Source"><select value={source} onChange={(event) => {
        const source = event.target.value as "github" | "plane";
        setSource(source); setEvent(source === "plane" ? "issue" : "pull_request");
      }}>
        <option value="github">GitHub</option><option value="plane">Plane</option>
      </select></Field>
      <Field label="Event">
        <select value={event} onChange={(e) => setEvent(e.target.value as DryRunEvent)}>
          {DRY_RUN_EVENTS.filter((event) => source === "plane" ? ["issue", "issue_comment"].includes(event) : event !== "issue")
            .map((ev) => <option key={ev} value={ev}>{humanLabel(ev)}</option>)}
        </select>
      </Field>
      </> : <Field label="Rule trigger" hint="Choose a suggestion or enter any trigger accepted by the engine, including issue.*, comment.*, check_suite.* and deployment_status.* families.">
        <input list={`rule-triggers-${id}`} value={trigger} onChange={(event) => setTrigger(event.target.value)} required />
        <datalist id={`rule-triggers-${id}`}>{DRY_RUN_TRIGGERS.map((trigger) => <option key={trigger} value={trigger} />)}</datalist>
      </Field>}
      {mode === "delivery" ? <Field label="Recorded delivery (audit entry id)" hint="Uses the payload stored in the audit log instead of the one below.">
        <input inputMode="numeric" value={auditId} onChange={(e) => setAuditId(e.target.value)} />
      </Field> : null}
      <Field label={mode === "trigger" ? "Rule context (JSON)" : "Payload (JSON)"}
        hint={mode === "trigger" ? 'Optional fields: repo, project, author, base_branch, head_branch, labels, context (for templates). Use {} to test only the trigger.' : undefined}>
        <textarea className="code" rows={8} value={payload} onChange={(e) => setPayload(e.target.value)} spellCheck={false} required={mode === "trigger" || !auditId.trim()} />
      </Field>
      <Field label="Rules to test (YAML, optional)">
        <textarea className="code" rows={6} value={yaml} onChange={(e) => setYaml(e.target.value)} spellCheck={false} />
      </Field>
      <button type="submit" disabled={saver.busy}>Run dry-run</button>
      <SaveStatus saver={saver} />
      {result ? (
        <div aria-live="polite">
          {(result.events ?? [result]).map((event, index) => <p key={index}>{event.trigger === null ? "That delivery is not an automation event." : `Trigger: ${event.trigger}. ${event.matched ? `Matched rule ${event.matched.index + 1}${event.matched.name ? ` (${event.matched.name})` : ""}.` : "No rule matched."}`}</p>)}
          {result.actions.length ? <pre><code>{JSON.stringify(result.actions, null, 2)}</code></pre> : <p>No actions would run.</p>}
        </div>
      ) : null}
    </form>
  );
}
