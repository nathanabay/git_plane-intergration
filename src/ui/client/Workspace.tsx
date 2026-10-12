import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api, failedWriteId, isNotAuthorised, retryFailedWrite } from "./http.ts";
import { Async, Field, Link, SaveStatus, formatTime, useLoad, useSaver } from "./common.tsx";
import type { Loaded } from "./common.tsx";
import { lookupRepo, lookupUser } from "./github.ts";
import { mappingHref, workspaceHref } from "./router.ts";
import type { AppRoute, MappingTab } from "./router.ts";
import type { AuditPage, BackfillResult, DryRunResult, Mapping, Policies, RulesDoc, UserLink } from "./types.ts";
import { CONFLICT_FIELDS, CONFLICT_POLICIES, DRY_RUN_EVENTS, SYNC_DIRECTIONS, isValidGithubLogin } from "../validate.ts";
import type { DryRunEvent } from "../validate.ts";
import type { ConflictField, ConflictPolicy, SyncDirection } from "../validate.ts";
import { LIFECYCLES, QLL_DEFAULTS, compileLifecycleRules, parseLifecycleMappingFromYaml } from "../../github/pr-automation.ts";
import type { BranchRule, Lifecycle, LifecycleMapping } from "../../github/pr-automation.ts";

const DENIED = "Workspace settings need a workspace admin.";
const ws = (slug: string) => `/workspaces/${encodeURIComponent(slug)}`;

type WorkspaceRoute = Exclude<AppRoute, { name: "admin" } | { name: "notfound" }>;

export function WorkspacePage({ route }: { route: WorkspaceRoute }) {
  const { slug } = route;
  return (
    <main>
      <h1>Git sync: {slug}</h1>
      <nav aria-label="Workspace sections" className="tabs">
        <Link href={workspaceHref(slug)} aria-current={route.name === "mappings" || route.name === "mapping" ? "page" : undefined}>Repositories</Link>
        <Link href={workspaceHref(slug, "users")} aria-current={route.name === "users" ? "page" : undefined}>User links</Link>
        <Link href={workspaceHref(slug, "audit")} aria-current={route.name === "audit" ? "page" : undefined}>Audit log</Link>
      </nav>
      {route.name === "mappings" ? <MappingsPage slug={slug} /> : null}
      {route.name === "mapping" ? <MappingPage slug={slug} id={route.id} tab={route.tab} /> : null}
      {route.name === "users" ? <UserLinksPage slug={slug} /> : null}
      {route.name === "audit" ? <AuditLogPage slug={slug} /> : null}
    </main>
  );
}

// ---- repositories ---------------------------------------------------------------------------------
function MappingsPage({ slug }: { slug: string }) {
  const list = useLoad(() => api<Mapping[]>("GET", `${ws(slug)}/mappings`), [slug]);
  const remove = useSaver();
  return (
    <>
      <section className="panel" aria-labelledby="maps-h">
        <h2 id="maps-h">Mapped repositories</h2>
        <Async state={list} denied={DENIED}>
          {(maps) => maps.length === 0 ? <p>No repository is mapped to a project in this workspace yet.</p> : (
            <table>
              <thead><tr><th>Repository</th><th>Plane project</th><th>Direction</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {maps.map((m) => (
                  <tr key={m.id}>
                    <td>{m.ghRepoFullName}</td>
                    <td><code>{m.planeProjectId}</code></td>
                    <td>{m.syncDirection === "bidirectional" ? "Two-way" : "GitHub to Plane"}</td>
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
      </section>
      {list.error && isNotAuthorised(list.error) ? null : (
        <section className="panel" aria-labelledby="new-h">
          <h2 id="new-h">Map a repository</h2>
          <MappingForm slug={slug} onSaved={list.reload} />
        </section>
      )}
    </>
  );
}

interface PlaneProject { id: string; label: string }

/** Best effort: the browser asks Plane (same origin, own session) for the workspace's projects. */
function useProjects(slug: string): PlaneProject[] | null {
  const [projects, setProjects] = useState<PlaneProject[] | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/workspaces/${encodeURIComponent(slug)}/projects/`, { credentials: "same-origin", headers: { accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : null))
      .then((json: unknown) => {
        const items = Array.isArray(json) ? json : (typeof json === "object" && json !== null && Array.isArray((json as { results?: unknown }).results)
          ? (json as { results: unknown[] }).results : null);
        if (!items || !live) return;
        const out: PlaneProject[] = [];
        for (const p of items) {
          if (typeof p !== "object" || p === null) continue;
          const { id, name, identifier } = p as { id?: unknown; name?: unknown; identifier?: unknown };
          if (typeof id === "string") out.push({ id, label: [identifier, name].filter((x) => typeof x === "string").join(" · ") || id });
        }
        if (out.length) setProjects(out);
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [slug]);
  return projects;
}

function MappingForm({ slug, existing, onSaved }: { slug: string; existing?: Mapping; onSaved(): void }) {
  const [repoName, setRepoName] = useState(existing?.ghRepoFullName ?? "");
  const [repoId, setRepoId] = useState(existing ? String(existing.ghRepoId) : "");
  const [project, setProject] = useState(existing?.planeProjectId ?? "");
  const [direction, setDirection] = useState<SyncDirection>(existing?.syncDirection ?? "bidirectional");
  const [smart, setSmart] = useState(existing?.smartCommitsEnabled ?? true);
  const [linkback, setLinkback] = useState(existing?.linkbackComments ?? true);
  const [autolinks, setAutolinks] = useState(existing?.autolinks ?? false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const projects = useProjects(slug);
  const saver = useSaver();

  const lookup = async () => {
    setLookupError(null);
    try {
      const r = await lookupRepo(repoName.trim());
      setRepoName(r.fullName);
      setRepoId(String(r.id));
    } catch (e) {
      setLookupError(e instanceof Error ? e.message : "Lookup failed");
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = {
      ghRepoId: Number(repoId), ghRepoFullName: repoName.trim(), planeProjectId: project.trim(), syncDirection: direction,
      smartCommitsEnabled: smart, linkbackComments: linkback, autolinks,
    };
    const ok = await saver.run(() => existing
      ? api("PATCH", `${ws(slug)}/mappings/${existing.id}`, body)
      : api("POST", `${ws(slug)}/mappings`, body));
    if (ok) {
      if (!existing) { setRepoName(""); setRepoId(""); setProject(""); }
      onSaved();
    }
  };

  return (
    <form onSubmit={submit}>
      <Field label="GitHub repository" hint="owner/repo">
        <span className="row">
          <input value={repoName} onChange={(e) => setRepoName(e.target.value)} required pattern="[A-Za-z0-9_.\-]+/[A-Za-z0-9_.\-]+" />
          <button type="button" onClick={lookup} disabled={!repoName.includes("/")}>Look up id</button>
        </span>
      </Field>
      <Field label="GitHub repository id" hint="Numeric id; Look up id fills it from api.github.com.">
        <input inputMode="numeric" value={repoId} onChange={(e) => setRepoId(e.target.value)} required />
      </Field>
      {lookupError ? <p className="error" role="alert">{lookupError}</p> : null}
      <Field label="Plane project">
        {projects ? (
          <select value={project} onChange={(e) => setProject(e.target.value)} required>
            <option value="" disabled>Choose a project</option>
            {project && !projects.some((p) => p.id === project) ? <option value={project}>{project}</option> : null}
            {projects.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        ) : (
          <input value={project} onChange={(e) => setProject(e.target.value)} required placeholder="project id" />
        )}
      </Field>
      <Field label="Sync direction" hint="Two-way mirrors issues both ways; GitHub to Plane only never writes back to GitHub.">
        <select value={direction} onChange={(e) => setDirection(e.target.value as SyncDirection)}>
          {SYNC_DIRECTIONS.map((d) => <option key={d} value={d}>{d === "bidirectional" ? "Two-way" : "GitHub to Plane only"}</option>)}
        </select>
      </Field>
      <label className="check"><input type="checkbox" checked={smart} onChange={(e) => setSmart(e.target.checked)} /><span>Smart Commits</span></label>
      <label className="check"><input type="checkbox" checked={linkback} onChange={(e) => setLinkback(e.target.checked)} /><span>Post link-back comments on GitHub</span></label>
      <label className="check"><input type="checkbox" checked={autolinks} onChange={(e) => setAutolinks(e.target.checked)} /><span>Create GitHub autolink references</span></label>
      <button type="submit" disabled={saver.busy}>{existing ? "Save changes" : "Add mapping"}</button>
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
            {tab === "settings" ? <><MappingForm slug={slug} existing={mapping} onSaved={list.reload} /><BackfillPanel slug={slug} id={id} /></> : null}
            {tab === "dry-run" ? <DryRunPanel slug={slug} id={id} /> : null}
            {tab === "policies" ? <PoliciesEditor slug={slug} id={id} /> : null}
            {tab === "rules" ? <RulesEditor slug={slug} id={id} /> : null}
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

function RulesEditor({ slug, id }: { slug: string; id: number }) {
  const rules = useLoad(() => api<RulesDoc>("GET", `${ws(slug)}/mappings/${id}/rules`), [slug, id]);
  return <Async state={rules} denied={DENIED}>{(r) => <RulesFields slug={slug} id={id} initial={r} />}</Async>;
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

function RulesFields({ slug, id, initial }: { slug: string; id: number; initial: RulesDoc }) {
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
  const saver = useSaver();

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
      branchRules: [...prev.branchRules, { baseBranch: "^staging$", lifecycle: "merged", state: "started:In Review" }],
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
    });
  };

  const submitYaml = async (e: FormEvent) => {
    e.preventDefault();
    await saver.run(async () => {
      const r = await api<{ version: number }>("PUT", `${ws(slug)}/mappings/${id}/rules`, { yaml });
      setVersion(r.version);
      const parsed = parseLifecycleMappingFromYaml(yaml);
      if (parsed) setMapping(parsed);
    });
  };

  return (
    <div>
      <p>
        Rules decide what happens on each GitHub event. State mappings are rules too, for example
        <code> when: pull_request.merged </code> then <code> set_state: Done</code>.
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
            Map each §7.1 lifecycle point to a Plane state (e.g. <code>started:In Progress</code> or <code>completed:Done</code>). Leave blank for no change.
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
                    <span className="hint"><code>{lc}</code></span>
                  </td>
                  <td>
                    <input
                      value={mapping.states[lc] ?? ""}
                      onChange={(e) => handleStateChange(lc, e.target.value)}
                      placeholder="e.g. started:In Progress (leave blank for no change)"
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
                      <input
                        value={rule.state}
                        onChange={(e) => handleBranchRuleChange(idx, "state", e.target.value)}
                        placeholder="started:In Review"
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
            hint="Triggers: branch.created (first branch push), push (every push), commit.pushed_to_default, pull_request.* (e.g. opened, approved, ready_for_merge, merged, closed_unmerged, reopened), check_suite.success, check_suite.failure."
          >
            <textarea
              className="code"
              rows={16}
              value={yaml}
              onChange={(e) => { setYaml(e.target.value); saver.clear(); }}
              spellCheck={false}
            />
          </Field>
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
  const unlink = useSaver();
  return (
    <>
      <section className="panel" aria-labelledby="links-h">
        <h2 id="links-h">Linked GitHub accounts</h2>
        <Async state={links} denied={DENIED}>
          {(list) => list.length === 0 ? <p>No Plane users are linked to GitHub accounts yet. Unlinked users are attributed to the service account.</p> : (
            <table>
              <thead><tr><th>Plane user id</th><th>GitHub account</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {list.map((l) => (
                  <tr key={l.planeUserId}>
                    <td><code>{l.planeUserId}</code></td>
                    <td>{l.githubLogin} <span className="hint">(id {l.githubId})</span></td>
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

function LinkForm({ slug, onSaved }: { slug: string; onSaved(): void }) {
  const [userId, setUserId] = useState("");
  const [login, setLogin] = useState("");
  const [ghId, setGhId] = useState("");
  const [lookupError, setLookupError] = useState<string | null>(null);
  const saver = useSaver();
  const lookup = async () => {
    setLookupError(null);
    try {
      const u = await lookupUser(login.trim());
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
      <Field label="Plane user id" hint="The user's id in Plane, not their email.">
        <input value={userId} onChange={(e) => setUserId(e.target.value)} required pattern="[A-Za-z0-9_\-]{1,64}" />
      </Field>
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
      <button type="submit" disabled={saver.busy}>Link account</button>
      <SaveStatus saver={saver} />
    </form>
  );
}

// ---- audit log ------------------------------------------------------------------------------------
function AuditLogPage({ slug }: { slug: string }) {
  const first = useLoad(() => api<AuditPage>("GET", `${ws(slug)}/audit?limit=50`), [slug]);
  const [more, setMore] = useState<AuditPage["entries"]>([]);
  const [cursor, setCursor] = useState<number | null | undefined>(undefined);
  const saver = useSaver();
  const replay = useSaver();
  const retry = useSaver();
  const [retried, setRetried] = useState<Set<string>>(new Set());
  useEffect(() => { setRetried(new Set()); }, [slug]);
  useEffect(() => { setMore([]); setCursor(undefined); }, [slug, first.data]);
  const next = cursor === undefined ? first.data?.nextBefore ?? null : cursor;
  return (
    <section className="panel" aria-labelledby="audit-h">
      <h2 id="audit-h">Audit log</h2>
      <Async state={first as Loaded<AuditPage>} denied={DENIED}>
        {(page) => {
          const entries = [...page.entries, ...more];
          if (entries.length === 0) return <p>Nothing has been recorded for this workspace yet.</p>;
          return (
            <>
              <table>
                <thead><tr><th>When</th><th>Event</th><th>Outcome</th><th>Detail</th><th><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id}>
                      <td>{formatTime(e.createdAt)}</td>
                      <td>{e.kind}{e.source ? <span className="hint"> · {e.source}</span> : null}</td>
                      <td className={e.error ? "error" : undefined}>{e.outcome}</td>
                      <td>{e.error ?? (e.detail ? <code className="detail">{JSON.stringify(e.detail)}</code> : "")}</td>
                      <td className="actions">
                        {e.kind === "inbound_delivery" ? (
                          <button type="button" disabled={replay.busy} onClick={async () => {
                            if (!window.confirm("Replay this delivery? It runs again under a new delivery id and may write to Plane and GitHub.")) return;
                            if (await replay.run(() => api("POST", `${ws(slug)}/audit/${e.id}/replay`))) first.reload();
                          }}>Replay</button>
                        ) : null}
                        {failedWriteId(e) ? (
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
                  const p = await api<AuditPage>("GET", `${ws(slug)}/audit?limit=50&before=${next}`);
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
function BackfillPanel({ slug, id }: { slug: string; id: number }) {
  const saver = useSaver();
  const [result, setResult] = useState<BackfillResult | null>(null);
  return (
    <section aria-labelledby="backfill-h">
      <h3 id="backfill-h">Backfill</h3>
      <p>Link this repository's open pull requests and issues to the Plane work items they mention.</p>
      <button type="button" disabled={saver.busy} onClick={() => saver.run(async () => {
        setResult(await api<BackfillResult>("POST", `${ws(slug)}/mappings/${id}/backfill`));
      })}>Run backfill</button>
      <SaveStatus saver={saver} />
      {result ? (
        <p aria-live="polite">
          Checked {result.pullRequests} pull requests and {result.issues} issues: {result.linked} links made, {result.unresolved} references did not match a work item.
        </p>
      ) : null}
    </section>
  );
}

function DryRunPanel({ slug, id }: { slug: string; id: number }) {
  const [event, setEvent] = useState<DryRunEvent>("pull_request");
  const [payload, setPayload] = useState("");
  const [auditId, setAuditId] = useState("");
  const [yaml, setYaml] = useState("");
  const [result, setResult] = useState<DryRunResult | null>(null);
  const saver = useSaver();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setResult(null);
    await saver.run(async () => {
      const body: Record<string, unknown> = { event, mappingId: id };
      if (auditId.trim()) body.auditId = Number(auditId);
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
      <Field label="Event">
        <select value={event} onChange={(e) => setEvent(e.target.value as DryRunEvent)}>
          {DRY_RUN_EVENTS.map((ev) => <option key={ev} value={ev}>{ev}</option>)}
        </select>
      </Field>
      <Field label="Recorded delivery (audit entry id)" hint="Uses the payload stored in the audit log instead of the one below.">
        <input inputMode="numeric" value={auditId} onChange={(e) => setAuditId(e.target.value)} />
      </Field>
      <Field label="Payload (JSON)">
        <textarea className="code" rows={8} value={payload} onChange={(e) => setPayload(e.target.value)} spellCheck={false} required={!auditId.trim()} />
      </Field>
      <Field label="Rules to test (YAML, optional)">
        <textarea className="code" rows={6} value={yaml} onChange={(e) => setYaml(e.target.value)} spellCheck={false} />
      </Field>
      <button type="submit" disabled={saver.busy}>Run dry-run</button>
      <SaveStatus saver={saver} />
      {result ? (
        <div aria-live="polite">
          <p>{result.trigger === null ? "That delivery is not an automation event." : `Trigger: ${result.trigger}. ${result.matched ? `Matched rule ${result.matched.index + 1}${result.matched.name ? ` (${result.matched.name})` : ""}.` : "No rule matched."}`}</p>
          {result.actions.length ? <pre><code>{JSON.stringify(result.actions, null, 2)}</code></pre> : <p>No actions would run.</p>}
        </div>
      ) : null}
    </form>
  );
}
