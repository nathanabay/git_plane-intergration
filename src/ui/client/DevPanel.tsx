// Development panel (N3), rendered in an iframe in Plane's work-item sidebar:
// /git-sync/ui/workspaces/:slug/projects/:projectId/work-items/:issueId/development
import { useState } from "react";
import type { CreateBranchResult, DevPanelData, DevPanelRepo } from "../dev-panel.ts";
import { Async, ErrorNote, useLoad } from "./common.tsx";
import { api } from "./http.ts";
import { UI_BASE } from "./router.ts";

export interface DevPanelRoute { slug: string; projectId: string; issueId: string }

const ID = /^[A-Za-z0-9_-]{1,100}$/;

/** The panel's own path; null for any other path (app.tsx checks this before the settings router). */
export function parseDevPanelPath(pathname: string): DevPanelRoute | null {
  if (!pathname.startsWith(UI_BASE + "/")) return null;
  let parts: string[];
  try { parts = pathname.slice(UI_BASE.length).split("/").filter(Boolean).map(decodeURIComponent); } catch { return null; }
  if (parts.length !== 7 || parts[0] !== "workspaces" || parts[2] !== "projects" || parts[4] !== "work-items" || parts[6] !== "development") return null;
  const [, slug, , projectId, , issueId] = parts as [string, string, string, string, string, string, string];
  return ID.test(slug) && ID.test(projectId) && ID.test(issueId) ? { slug, projectId, issueId } : null;
}

export function devPanelApiPath(r: DevPanelRoute, leaf: "development" | "branches"): string {
  return `/workspaces/${encodeURIComponent(r.slug)}/projects/${encodeURIComponent(r.projectId)}/work-items/${encodeURIComponent(r.issueId)}/${leaf}`;
}

async function copy(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

function RepoBranch({ route, repo, canCreate }: { route: DevPanelRoute; repo: DevPanelRepo; canCreate: boolean }) {
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const onCopy = async () => setNote((await copy(repo.branchName)) ? "Copied" : "Copy failed; select the name and copy it");
  const onCreate = async () => {
    setBusy(true); setError(null); setNote(null);
    try {
      const r = await api<CreateBranchResult>("POST", devPanelApiPath(route, "branches"), { mappingId: repo.mappingId });
      setNote(r.created ? "Branch created" : "Branch already exists");
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <li>
      <span className="hint">{repo.repo}</span>
      <div className="row">
        <input readOnly value={repo.branchName} aria-label={`Branch name for ${repo.repo}`} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" onClick={onCopy}>Copy branch name</button>
        {canCreate && <button type="button" onClick={onCreate} disabled={busy}>{busy ? "Creating…" : "Create branch"}</button>}
      </div>
      <p className="status" role="status">{note && <a href={repo.branchUrl} target="_blank" rel="noreferrer">{note}</a>}</p>
      <ErrorNote error={error} />
    </li>
  );
}

function Links({ title, items }: { title: string; items: { text: string; url: string }[] }) {
  if (!items.length) return null;
  return (
    <>
      <h3>{title}</h3>
      <ul>{items.map((l) => <li key={l.url}><a href={l.url} target="_blank" rel="noreferrer">{l.text}</a></li>)}</ul>
    </>
  );
}

export function DevPanel({ route }: { route: DevPanelRoute }) {
  const state = useLoad(() => api<DevPanelData>("GET", devPanelApiPath(route, "development")), [route.slug, route.projectId, route.issueId]);
  return (
    <main>
      <Async state={state} denied="You cannot see this work item.">
        {(d) => (
          <>
            <h2>Development {d.prStatus && <span className="hint">PRs: {d.prStatus}</span>}</h2>
            <Links title="Pull requests" items={d.prs.map((p) => ({ url: p.url, text: [p.title, p.status, p.review].filter(Boolean).join(" · ") }))} />
            <Links title="Builds" items={d.builds} />
            <Links title="Deployments" items={d.deployments} />
            <Links title="Previews" items={d.previews} />
            <Links title="Branches" items={d.branches.filter((b) => !b.suggested)} />
            {d.repos.length > 0
              ? <><h3>Start work</h3><ul>{d.repos.map((r) => <RepoBranch key={r.mappingId} route={route} repo={r} canCreate={d.canCreateBranch} />)}</ul></>
              : <p className="hint">No GitHub repository is mapped to this project.</p>}
          </>
        )}
      </Async>
    </main>
  );
}
