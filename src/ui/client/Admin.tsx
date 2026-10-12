import { useState } from "react";
import type { FormEvent } from "react";
import { api, isNotAuthorised } from "./http.ts";
import { Async, Field, NotAuthorised, SaveStatus, formatTime, useLoad, useSaver } from "./common.tsx";
import type { GithubAppInfo, Health, InstanceSettings, MagicWords, WorkspaceInstallation } from "./types.ts";
import { MAGIC_TIERS } from "../validate.ts";
import type { MagicTier } from "../validate.ts";
import type { DisabledMapping } from "../../app/mappings.ts";

const DENIED = "The instance settings need a Plane instance-admin session.";

export function AdminPage() {
  const health = useLoad(() => api<Health>("GET", "/instance/health"), []);
  if (health.error && isNotAuthorised(health.error)) return <NotAuthorised what={DENIED} />;
  return (
    <main>
      <h1>Git sync: instance settings</h1>
      <HealthPanel state={health} />
      <GithubAppForm onSaved={health.reload} />
      <WorkspaceInstallationsPanel />
      <DisabledMappingsPanel />
      <MagicWordsForm />
      <SettingsForm />
    </main>
  );
}

function DisabledMappingsPanel() {
  const state = useLoad(() => api<DisabledMapping[]>("GET", "/instance/disabled-mappings"), []);
  return (
    <section className="panel" aria-labelledby="disabled-mappings-h">
      <h2 id="disabled-mappings-h">Disabled repository mappings</h2>
      <p>Unresolved mappings and mappings whose installation is no longer allowed are disabled. Allow-list the installation for its workspace, then have a workspace admin save the mapping to verify it.</p>
      <button type="button" onClick={state.reload}>Refresh mappings</button>
      <Async state={state} denied={DENIED}>
        {(list) => list.length === 0 ? <p>No disabled mappings.</p> : (
          <table>
            <thead><tr><th>Workspace</th><th>Repository</th><th>Project</th><th>Installation</th><th>Reason</th></tr></thead>
            <tbody>{list.map((m) => <tr key={m.id}>
              <td>{m.workspaceSlug}</td><td>{m.ghRepoFullName}</td><td>{m.planeProjectId}</td>
              <td>{m.installationId ?? "Unresolved"}</td><td>{m.reason === "unresolved" ? "Save the mapping to verify its installation" : "Installation is not allowed for this workspace"}</td>
            </tr>)}</tbody>
          </table>
        )}
      </Async>
    </section>
  );
}

function HealthPanel({ state }: { state: ReturnType<typeof useLoad<Health>> }) {
  return (
    <section className="panel" aria-labelledby="health-h">
      <h2 id="health-h">Connection health</h2>
      <Async state={state} denied={DENIED}>
        {(h) => (
          <dl className="facts">
            <dt>Database</dt><dd>{h.database ? "reachable" : "unreachable"}</dd>
            <dt>GitHub App</dt><dd>{h.githubAppConfigured ? "configured" : "not configured"}</dd>
            <dt>Repository mappings</dt><dd>{h.mappings}</dd>
            <dt>Last sync activity</dt><dd>{formatTime(h.lastActivityAt)}</dd>
            <dt>Failures in the last 24 hours</dt><dd className={h.failuresLast24h > 0 ? "error" : undefined}>{h.failuresLast24h}</dd>
          </dl>
        )}
      </Async>
    </section>
  );
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
  const [ghe, setGhe] = useState(app.gheBaseUrl ?? "");
  const [privateKey, setPrivateKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const saver = useSaver();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await saver.run(() => api("PUT", "/instance/github-app", {
      appId: Number(appId),
      gheBaseUrl: ghe.trim() === "" ? null : ghe.trim(),
      ...(privateKey.trim() ? { privateKey } : {}),
      ...(webhookSecret ? { webhookSecret } : {}),
    }));
    if (ok) { setPrivateKey(""); setWebhookSecret(""); onSaved(); }
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
      <Field label="GitHub Enterprise base URL" hint="Leave empty for github.com.">
        <input type="url" value={ghe} onChange={(e) => setGhe(e.target.value)} placeholder="https://github.example.com" />
      </Field>
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
              <th>Workspace slug</th>
              <th>Installation ID</th>
              <th>Account / Org</th>
              <th>Allow-listed at</th>
              <th><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {list.map((item) => (
              <tr key={item.installationId}>
                <td><code>{item.workspaceSlug}</code></td>
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
          <Field label="Workspace slug" hint="Workspace allowed to use this installation.">
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="e.g. acme"
              required
            />
          </Field>
          <Field label="Account / Org (optional)" hint="GitHub org or user name for display.">
            <input
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              placeholder="e.g. octocat"
            />
          </Field>
        </div>
        <button type="submit" disabled={saver.busy}>Allow-list installation</button>
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

function SettingsFields({ initial }: { initial: InstanceSettings }) {
  const [smart, setSmart] = useState(initial.smartCommitsDefault);
  const [interval, setInterval_] = useState(String(initial.reconciliationIntervalMinutes));
  const [ttl, setTtl] = useState(String(initial.opTtlMinutes));
  const saver = useSaver();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await saver.run(() => api("PUT", "/instance/settings", {
      smartCommitsDefault: smart, reconciliationIntervalMinutes: Number(interval), opTtlMinutes: Number(ttl),
    }));
  };
  return (
    <form onSubmit={submit}>
      <label className="check">
        <input type="checkbox" checked={smart} onChange={(e) => setSmart(e.target.checked)} />
        <span>Enable Smart Commits for newly mapped repositories</span>
      </label>
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
