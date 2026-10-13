import { useState } from "react";
import type { FormEvent } from "react";
import { api, isNotAuthorised } from "./http.ts";
import { Async, ErrorNote, Field, Link, NotAuthorised, SaveStatus, formatTime, useLoad, usePathname, useSaver } from "./common.tsx";
import type { GithubAppInfo, Health, InstanceSettings, MagicWords, PlaneProject, PlaneWorkspace, WorkspaceInstallation } from "./types.ts";
import { AuditLogPage } from "./Workspace.tsx";
import { parseLocation, UI_BASE } from "./router.ts";
import type { SetupCheckResult } from "../setup-check.ts";
import { WorkspacePicker } from "./pickers.tsx";
import { MAGIC_TIERS } from "../validate.ts";
import type { MagicTier } from "../validate.ts";
import type { DisabledMapping } from "../../app/mappings.ts";

const DENIED = "The instance settings need a Plane instance-admin session.";

export function AdminPage() {
  const route = parseLocation(usePathname());
  const audit = route.name === "admin" && route.tab === "audit";
  const health = useLoad(() => api<Health>("GET", "/instance/health"), []);
  if (health.error && isNotAuthorised(health.error)) return <NotAuthorised what={DENIED} />;
  return (
    <main>
      <h1>Git sync: instance settings</h1>
      <nav className="tabs" aria-label="Instance sections"><Link href={`${UI_BASE}/admin`} aria-current={!audit ? "page" : undefined}>Settings</Link><Link href={`${UI_BASE}/admin/audit`} aria-current={audit ? "page" : undefined}>Instance audit</Link></nav>
      {audit ? <AuditLogPage filters={route.name === "admin" ? route.filters : undefined} /> : <>
      <HealthPanel state={health} />
      <SetupCheckPanel />
      <GithubAppForm onSaved={health.reload} />
      <WorkspaceInstallationsPanel />
      <DisabledMappingsPanel />
      <ManualMappingPanel />
      <MagicWordsForm />
      <SettingsForm />
      </>}
    </main>
  );
}

function ManualMappingPanel() {
  const workspaces = useLoad(() => api<PlaneWorkspace[]>("GET", "/instance/workspaces"), []);
  const [slug, setSlug] = useState("");
  const projects = useLoad(() => slug ? api<PlaneProject[]>("GET", `/instance/workspaces/${encodeURIComponent(slug)}/projects`) : Promise.resolve([]), [slug]);
  const [project, setProject] = useState("");
  const [repoId, setRepoId] = useState("");
  const [repo, setRepo] = useState("");
  const saver = useSaver();
  return <section className="panel"><h2>Manual mapping recovery</h2><p>Instance admins can map a repository by ID when personal GitHub authorization is unavailable. The App installation and Plane project are still verified.</p>
    <form onSubmit={async (event) => { event.preventDefault(); if (await saver.run(() => api("POST", `/instance/workspaces/${encodeURIComponent(slug)}/mappings`, {
      ghRepoId: Number(repoId), ghRepoFullName: repo.trim(), planeProjectId: project,
    }))) { setRepoId(""); setRepo(""); setProject(""); } }}>
      <Field label="Workspace"><WorkspacePicker workspaces={workspaces.data ?? []} value={slug} onChange={(value) => { setSlug(value); setProject(""); }} disabled={workspaces.loading || !!workspaces.error} /></Field>
      <Field label="Plane project"><select value={project} onChange={(event) => setProject(event.target.value)} required disabled={!slug || projects.loading || !!projects.error}>
        <option value="" disabled>Choose a project</option>{projects.data?.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select></Field>
      <Field label="GitHub repository"><input value={repo} onChange={(event) => setRepo(event.target.value)} required placeholder="owner/repository" /></Field>
      <Field label="GitHub repository ID"><input value={repoId} onChange={(event) => setRepoId(event.target.value)} inputMode="numeric" required /></Field>
      <button type="submit" disabled={saver.busy || !slug || !project || projects.loading}>Add manual mapping</button><SaveStatus saver={saver} />
    </form><ErrorNote error={workspaces.error ?? projects.error} />
  </section>;
}

function DisabledMappingsPanel() {
  const state = useLoad(() => api<DisabledMapping[]>("GET", "/instance/disabled-mappings"), []);
  return (
    <section className="panel" aria-labelledby="disabled-mappings-h">
      <h2 id="disabled-mappings-h">Disabled repository mappings</h2>
      <p>Unresolved mappings and mappings whose installation is no longer allowed are disabled. Allow-list the installation for its workspace, then have a workspace admin save the mapping to verify it.</p>
      <button type="button" onClick={state.reload}>Refresh mappings</button>
      <Async state={state} denied={DENIED}>
        {(list) => list.length === 0 ? <p>No disabled mappings.</p> : <DisabledMappingsTable list={list} />}
      </Async>
    </section>
  );
}

function DisabledMappingsTable({ list }: { list: DisabledMapping[] }) {
  const workspaces = useLoad(() => api<PlaneWorkspace[]>("GET", "/instance/workspaces"), []);
  const slugs = [...new Set(list.map((mapping) => mapping.workspaceSlug))].sort();
  const projects = useLoad(async () => {
    const result = await Promise.all(slugs.map(async (slug) => {
      try { return { slug, projects: await api<PlaneProject[]>("GET", `/instance/workspaces/${encodeURIComponent(slug)}/projects`), error: null }; }
      catch (error) { return { slug, projects: [] as PlaneProject[], error }; }
    }));
    return result;
  }, [slugs.join(",")]);
  return <>
    <ErrorNote error={workspaces.error} />
    {workspaces.error ? <button type="button" onClick={workspaces.reload}>Reload workspace names</button> : null}
    {projects.data?.some((result) => result.error) ? <p className="error">Some project names could not be loaded. <button type="button" onClick={projects.reload}>Reload project names</button></p> : null}
    <table><thead><tr><th>Workspace</th><th>Repository</th><th>Project</th><th>Installation</th><th>Reason</th></tr></thead>
      <tbody>{list.map((mapping) => <tr key={mapping.id}>
        <td>{workspaces.data?.find((workspace) => workspace.slug === mapping.workspaceSlug)?.name ?? "Workspace unavailable"}</td>
        <td>{mapping.ghRepoFullName}</td>
        <td>{projects.data?.find((result) => result.slug === mapping.workspaceSlug)?.projects.find((project) => project.id === mapping.planeProjectId)?.label ?? (projects.loading ? "Loading project…" : "Project unavailable")}</td>
        <td>{mapping.installationId ?? "Unresolved"}</td><td>{mapping.reason === "unresolved" ? "Save the mapping to verify its installation" : "Installation is not allowed for this workspace"}</td>
      </tr>)}</tbody></table>
  </>;
}

export function HealthPanel({ state }: { state: ReturnType<typeof useLoad<Health>> }) {
  return (
    <section className="panel" aria-labelledby="health-h">
      <h2 id="health-h">Connection health</h2>
      <Async state={state} denied={DENIED}>
        {(h) => (
          <>
          {h.healthError ? <p className="error" role="alert">{h.healthError}</p> : null}
          {h.database && h.githubAppCredentials?.decryptOk === false ? <p className="error" role="alert">GitHub App credentials cannot be decrypted. Save the App secrets again.</p> : null}
          <dl className="facts">
            <dt>Database</dt><dd>{h.database ? "reachable" : "unreachable"}</dd>
            <dt>GitHub App</dt><dd>{h.githubAppConfigured ? "configured" : "not configured"}</dd>
            <dt>Repository mappings</dt><dd>{h.mappings ?? "Unknown"}</dd>
            <dt>Last sync activity</dt><dd>{formatTime(h.lastActivityAt)}</dd>
            <dt>Failures in the last 24 hours</dt><dd className={(h.failuresLast24h ?? 0) > 0 ? "error" : undefined}>{h.failuresLast24h === null ? "Unknown" : <Link href={`${UI_BASE}/admin/audit?errors=1&hours=24&scope=all`}>{h.failuresLast24h}</Link>}</dd>
          </dl></>
        )}
      </Async>
    </section>
  );
}

function SetupCheckPanel() {
  const state = useLoad(() => api<SetupCheckResult>("GET", "/instance/setup-check"), []);
  return <section className="panel"><h2>Setup checks</h2><button type="button" onClick={state.reload}>Check setup again</button>
    <Async state={state} denied={DENIED}>{(result) => <><p>Checked {formatTime(result.checkedAt)}</p><ul>{result.checks.map((check) => <li key={check.id}>
      <strong>{check.title}: {check.status === "pass" ? "Verified" : check.status === "fail" ? "Needs attention" : "Not verified"}</strong> — {check.detail}
    </li>)}</ul></>}</Async></section>;
}

function GithubAppForm({ onSaved }: { onSaved(): void }) {
  const info = useLoad(() => api<GithubAppInfo>("GET", "/instance/github-app"), []);
  return (
    <section className="panel" aria-labelledby="app-h">
      <h2 id="app-h">GitHub App</h2>
      <Async state={info} denied={DENIED}>
        {(app) => <GithubAppFields app={app} onSaved={() => { info.reload(); onSaved(); }} />}
      </Async>
    </section>
  );
}

function GithubAppFields({ app, onSaved }: { app: GithubAppInfo; onSaved(): void }) {
  const [appId, setAppId] = useState(app.appId === null ? "" : String(app.appId));
  const [clientId, setClientId] = useState(app.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [appSlug, setAppSlug] = useState(app.appSlug ?? "");
  const [edition, setEdition] = useState(app.edition ?? "github");
  const [subdomain, setSubdomain] = useState(app.gheSubdomain ?? "");
  const [ghe, setGhe] = useState(app.gheBaseUrl ?? "");
  const [privateKey, setPrivateKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const saver = useSaver();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await saver.run(() => api("PUT", "/instance/github-app", {
      appId: Number(appId),
      edition, gheSubdomain: edition === "ghe_cloud" ? subdomain.trim() : null,
      gheBaseUrl: edition === "ghes" ? ghe.trim() : null,
      ...(clientId.trim() !== (app.clientId ?? "") ? { clientId: clientId.trim() || null } : {}),
      ...(appSlug.trim() !== (app.appSlug ?? "") ? { appSlug: appSlug.trim() || null } : {}),
      ...(clientSecret ? { clientSecret } : {}),
      ...(privateKey.trim() ? { privateKey } : {}),
      ...(webhookSecret ? { webhookSecret } : {}),
    }));
    if (ok) { setPrivateKey(""); setWebhookSecret(""); setClientSecret(""); onSaved(); }
  };

  return (
    <form onSubmit={submit}>
      <p>{app.configured ? "A GitHub App is configured. Leave the secrets empty to keep the stored ones." : "No GitHub App is configured yet."}</p>
      <Field label="App ID"><input inputMode="numeric" value={appId} onChange={(e) => setAppId(e.target.value)} required /></Field>
      <Field label="Private key (PEM)" hint="Stored encrypted; it is never shown again.">
        <textarea rows={5} value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} spellCheck={false} autoComplete="off"
          required={!app.configured} />
      </Field>
      <Field label="Webhook secret" hint="Stored encrypted; it is never shown again.">
        <input type="password" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} autoComplete="new-password"
          required={!app.configured} />
      </Field>
      <Field label="App slug" hint="Used for the Connect GitHub installation link."><input value={appSlug} onChange={(event) => setAppSlug(event.target.value)} /></Field>
      <Field label="OAuth client ID"><input value={clientId} onChange={(event) => setClientId(event.target.value)} /></Field>
      <Field label="OAuth client secret" hint={app.clientSecretConfigured ? "Configured. Leave empty to keep the secret." : "Required for personal account authorization."}>
        <input type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} autoComplete="new-password" /></Field>
      <Field label="GitHub edition"><select value={edition} onChange={(event) => setEdition(event.target.value as typeof edition)}>
        <option value="github">GitHub.com</option><option value="ghe_cloud">Enterprise Cloud with data residency</option><option value="ghes">Enterprise Server</option>
      </select></Field>
      {edition === "ghe_cloud" ? <Field label="Enterprise Cloud subdomain" hint="The enterprise name before .ghe.com."><input value={subdomain} onChange={(event) => setSubdomain(event.target.value)} required /></Field> : null}
      {edition === "ghes" ? <Field label="Enterprise Server URL"><input type="url" value={ghe} onChange={(event) => setGhe(event.target.value)} placeholder="https://github.example.com" required /></Field> : null}
      <button type="submit" disabled={saver.busy}>Save GitHub App</button>
      <SaveStatus saver={saver} />
    </form>
  );
}

export function WorkspaceInstallationsPanel() {
  const installations = useLoad(() => api<WorkspaceInstallation[]>("GET", "/instance/installations"), []);
  return (
    <section className="panel" aria-labelledby="installations-h">
      <h2 id="installations-h">Workspace GitHub App installations</h2>
      <p>Allow-list GitHub App installations per workspace. A repository can only be mapped if its installation is allow-listed for that workspace.</p>
      <Async state={installations} denied={DENIED}>
        {(list) => <WorkspaceInstallationsTable list={list} onReload={installations.reload} />}
      </Async>
    </section>
  );
}

export function WorkspaceInstallationsTable({ list, onReload }: { list: WorkspaceInstallation[]; onReload(): void }) {
  const workspaces = useLoad(() => api<PlaneWorkspace[]>("GET", "/instance/workspaces"), []);
  const [instId, setInstId] = useState("");
  const [slug, setSlug] = useState("");
  const [login, setLogin] = useState("");
  const saver = useSaver();
  const remover = useSaver();

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const id = Number(instId);
    if (!Number.isSafeInteger(id) || id <= 0) return;
    const ok = await saver.run(() => api("PUT", `/instance/installations/${id}`, {
      workspaceSlug: slug.trim(),
      ...(login.trim() ? { accountLogin: login.trim() } : {}),
    }));
    if (ok) {
      setInstId("");
      setSlug("");
      setLogin("");
      onReload();
    }
  };

  const remove = async (id: number) => {
    if (typeof window !== "undefined" && typeof window.confirm === "function") {
      if (!window.confirm(`Remove allow-list entry for installation ${id}?`)) return;
    }
    const ok = await remover.run(() => api("DELETE", `/instance/installations/${id}`));
    if (ok) onReload();
  };

  return (
    <div>
      {list.length === 0 ? (
        <p className="hint">No installations allow-listed yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Workspace</th>
              <th>Installation ID</th>
              <th>Account / Org</th>
              <th>Allow-listed at</th>
              <th><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {list.map((item) => (
              <tr key={item.installationId}>
                <td>{workspaces.data?.find((workspace) => workspace.slug === item.workspaceSlug)?.name ?? (workspaces.loading ? "Loading workspace…" : "Workspace unavailable")}</td>
                <td><code>{item.installationId}</code></td>
                <td>{item.accountLogin ?? <span className="hint">—</span>}</td>
                <td>{formatTime(item.createdAt)}</td>
                <td className="actions">
                  <button
                    type="button"
                    className="danger"
                    disabled={remover.busy}
                    onClick={() => remove(item.installationId)}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <SaveStatus saver={remover} />
      <ErrorNote error={workspaces.error} />
      {workspaces.error ? <button type="button" onClick={workspaces.reload}>Reload workspaces</button> : null}

      <h3 style={{ marginTop: "16px" }}>Allow-list an installation</h3>
      <form onSubmit={add}>
        <div className="row">
          <Field label="Installation ID" hint="Numeric GitHub App installation ID.">
            <input
              inputMode="numeric"
              value={instId}
              onChange={(e) => setInstId(e.target.value)}
              placeholder="e.g. 12345678"
              required
            />
          </Field>
          <Field label="Workspace" hint="Workspace allowed to use this installation.">
            <WorkspacePicker workspaces={workspaces.data ?? []} value={slug} onChange={setSlug} disabled={workspaces.loading || !!workspaces.error} />
          </Field>
          <Field label="Account / Org (optional)" hint="GitHub org or user name for display.">
            <input
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              placeholder="e.g. octocat"
            />
          </Field>
        </div>
        <button type="submit" disabled={saver.busy || !slug || !workspaces.data}>Allow-list installation</button>
        <SaveStatus saver={saver} />
      </form>
    </div>
  );
}

const TIER_LABELS: Record<MagicTier, string> = {
  closing: "Closing words",
  non_closing: "Non-closing words",
  relation: "Relation phrases",
};

function MagicWordsForm() {
  const words = useLoad(() => api<MagicWords>("GET", "/instance/magic-words"), []);
  return (
    <section className="panel" aria-labelledby="words-h">
      <h2 id="words-h">Magic words</h2>
      <Async state={words} denied={DENIED}>{(w) => <MagicWordsFields initial={w} />}</Async>
    </section>
  );
}

function MagicWordsFields({ initial }: { initial: MagicWords }) {
  const [text, setText] = useState<Record<MagicTier, string>>({
    closing: initial.closing.join("\n"),
    non_closing: initial.non_closing.join("\n"),
    relation: initial.relation.join("\n"),
  });
  const saver = useSaver();
  const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await saver.run(() => api("PUT", "/instance/magic-words", {
      closing: lines(text.closing), non_closing: lines(text.non_closing), relation: lines(text.relation),
    }));
  };
  return (
    <form onSubmit={submit}>
      <p>One word or phrase per line. A word may belong to only one tier.</p>
      {MAGIC_TIERS.map((tier) => (
        <Field key={tier} label={TIER_LABELS[tier]}>
          <textarea rows={6} value={text[tier]} onChange={(e) => setText({ ...text, [tier]: e.target.value })} spellCheck={false} />
        </Field>
      ))}
      <button type="submit" disabled={saver.busy}>Save magic words</button>
      <SaveStatus saver={saver} />
    </form>
  );
}

function SettingsForm() {
  const settings = useLoad(() => api<InstanceSettings>("GET", "/instance/settings"), []);
  return (
    <section className="panel" aria-labelledby="settings-h">
      <h2 id="settings-h">Defaults</h2>
      <Async state={settings} denied={DENIED}>{(s) => <SettingsFields initial={s} />}</Async>
    </section>
  );
}

export function SettingsFields({ initial }: { initial: InstanceSettings }) {
  const [verified, setVerified] = useState(initial.requireVerifiedCommits ?? false);
  const [smart, setSmart] = useState(initial.smartCommitsDefault);
  const [interval, setInterval_] = useState(String(initial.reconciliationIntervalMinutes));
  const [ttl, setTtl] = useState(String(initial.opTtlMinutes));
  const saver = useSaver();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await saver.run(() => api("PUT", "/instance/settings", {
      smartCommitsDefault: smart, requireVerifiedCommits: verified, reconciliationIntervalMinutes: Number(interval), opTtlMinutes: Number(ttl),
    }));
  };
  return (
    <form onSubmit={submit}>
      <label className="check">
        <input type="checkbox" checked={smart} onChange={(e) => setSmart(e.target.checked)} />
        <span>Enable Smart Commits for newly mapped repositories</span>
      </label>
      <label className="check"><input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} /><span>Require signed commits for Smart Commits</span></label>
      <p className="hint">Only commits GitHub marks as verified can run Smart Commit commands when enabled.</p>
      <Field label="Reconciliation interval (minutes)" hint="How often missed webhooks are reconciled.">
        <input inputMode="numeric" value={interval} onChange={(e) => setInterval_(e.target.value)} required />
      </Field>
      <Field label="Echo-suppression TTL (minutes)" hint="How long an applied operation is remembered to stop sync loops.">
        <input inputMode="numeric" value={ttl} onChange={(e) => setTtl(e.target.value)} required />
      </Field>
      <button type="submit" disabled={saver.busy}>Save defaults</button>
      <SaveStatus saver={saver} />
    </form>
  );
}
