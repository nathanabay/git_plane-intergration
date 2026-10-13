import { useState } from "react";
import { api } from "./http.ts";
import { Async, ErrorNote, Field, Link, SaveStatus, formatTime, useLoad, usePathname, useSaver } from "./common.tsx";
import { workspaceHref } from "./router.ts";
import type { ClaimableInstallation, ConnectionView, PendingRequest, PersonalLink, PickableRepositories, PickableRepo } from "../install-flow.ts";

const ws = (slug: string) => `/workspaces/${encodeURIComponent(slug)}`;
const REASONS: Record<string, string> = {
  internal: "The connection could not be completed. Try again; ask an instance admin to check the service if it keeps failing.",
  state: "This connection link has expired, was already used, or belongs to another Plane account. Start again.",
  denied: "GitHub authorization was declined. You can connect again when ready.",
  exchange: "GitHub authorization could not be completed. Start again.",
  already_linked: "This GitHub account is already linked to another member in this workspace.",
  not_yours: "Your GitHub account cannot access that installation. Choose an installation you can access, or ask its organization owner to connect it.",
  not_owner: "Only an active GitHub organization owner or admin can connect its installation. Ask an organization owner to connect it using a handoff link. A personal installation must be connected by its account owner.",
  wrong_account: "This handoff link was issued for a different GitHub organization. Use the link for the organization you want to connect.",
  unsupported_account: "This kind of GitHub account is not supported. Choose an organization or personal account installation.",
  taken: "That installation is connected to another workspace.",
  not_configured: "Ask the instance admin to configure the GitHub App client ID, client secret and App slug.",
  installation: "GitHub did not return a valid installation. Start again and choose the intended organization or personal account.",
  github: "GitHub could not complete the connection. Check your account access and try again.",
};
export function connectionNotice(query: string): string | null {
  const q = new URLSearchParams(query);
  if (q.get("connect") === "handoff") return "The organization owner must complete GitHub authorization using the handoff link. Then refresh this workspace's connection.";
  if (q.get("connect") === "updated") return "Repository access updated and mappings rechecked.";
  if (q.get("connect") === "ok") return q.get("via") === "handoff"
    ? "The account owner has connected GitHub to this workspace. You can close this page; the workspace admin can refresh the connection."
    : "GitHub is connected to this workspace.";
  if (q.get("github") === "linked") return "Your personal GitHub account is connected.";
  if (q.get("connect") === "error" || q.get("github") === "error") {
    const reason = q.get("reason") ?? "github";
    const message = Object.hasOwn(REASONS, reason) ? REASONS[reason]! : REASONS.github!;
    return q.get("via") === "handoff" ? `The owner handoff could not be completed. ${message}` : message;
  }
  return null;
}
function CallbackNotice() {
  const path = usePathname();
  const notice = connectionNotice(path.split("?", 2)[1] ?? "");
  return notice ? <p role="status">{notice}</p> : null;
}
function openGithub(url: string) { window.open(url, "_top"); }

export function PersonalAccountCard({ slug, personal, busy, onConnect, onDisconnect }: {
  slug: string; personal: PersonalLink; busy: boolean; onConnect(): void; onDisconnect(): void;
}) {
  const needsAuthorization = !personal.linked || !personal.tokenStored || personal.needsReauth;
  return <>
    {needsAuthorization ? <p role="alert" className="hint">{personal.needsReauth ? "Needs re-authorization. Reconnect your GitHub account to author changes as yourself."
      : "Connect your personal GitHub account to author synced changes as yourself."} Changes use the service account until you connect.</p> : null}
    <p>{personal.linked ? `GitHub account: ${personal.githubLogin}` : "No personal GitHub account connected."}</p>
    {!personal.appConfigured ? <p className="error">The instance admin must configure the GitHub App OAuth credentials.</p> : null}
    <button type="button" disabled={busy || !personal.appConfigured} onClick={onConnect}>{personal.linked ? "Reconnect" : "Connect personal account"}</button>
    {personal.linked || personal.tokenStored ? <button type="button" className="danger" disabled={busy} onClick={onDisconnect}>Disconnect personal account</button> : null}
    <p><Link href={workspaceHref(slug, "account")}>My GitHub account settings</Link></p>
  </>;
}
export function PersonalAccountPanel({ slug }: { slug: string }) {
  const state = useLoad(() => api<PersonalLink>("GET", `${ws(slug)}/github/account`), [slug]);
  const saver = useSaver();
  const connect = async () => {
    await saver.run(async () => { const result = await api<{ authorizeUrl: string }>("POST", `${ws(slug)}/github/account/connect`); openGithub(result.authorizeUrl); });
  };
  const disconnect = async () => {
    if (!window.confirm("Disconnect your GitHub account? Synced writes will use the service account until you reconnect.")) return;
    if (await saver.run(() => api("DELETE", `${ws(slug)}/github/account`))) state.reload();
  };
  return <section className="panel"><h2>My GitHub account</h2><CallbackNotice />
    <Async state={state} denied="Personal account settings need workspace membership.">{(personal) => <PersonalAccountCard slug={slug} personal={personal} busy={saver.busy} onConnect={connect} onDisconnect={disconnect} />}</Async>
    <SaveStatus saver={saver} /></section>;
}

export function OrganisationCard({ item, busy, onDisconnect }: { item: ConnectionView["installations"][number]; busy: boolean; onDisconnect(): void }) {
  return <article className="panel" aria-label="Connected GitHub organization">
    {item.avatarUrl ? <img src={item.avatarUrl} alt="" width={40} height={40} /> : null}
    <strong>{item.accountLogin ?? "GitHub installation"}</strong><p>{item.accountType ?? "Account"} · installation {item.installationId}</p>
    {item.htmlUrl ? <a href={item.htmlUrl} target="_blank" rel="noreferrer">Manage repository access on GitHub</a> : null}
    <button type="button" className="danger" disabled={busy} onClick={onDisconnect}>Disconnect</button>
  </article>;
}
export function OwnerHandoffDialog({ link, expiresAt, onClose }: { link: string; expiresAt: string; onClose(): void }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  return <div role="dialog" aria-modal="false" aria-label="Send a link to an organization owner" className="panel">
    <h3>Send a link to an organization owner</h3><p>Ask an organization owner or admin to install or approve the App, then complete GitHub authorization using this link. They can connect it without a Plane account. Afterwards, refresh this workspace's connection.</p>
    <Field label="Installation link"><input readOnly value={link} onFocus={(event) => event.currentTarget.select()} /></Field>
    <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(link); setCopied(true); setCopyError(false); } catch { setCopied(false); setCopyError(true); } }}>{copied ? "Copied" : "Copy link"}</button>
    {copyError ? <p role="status">Copy failed. Select the link above and copy it.</p> : null}
    <p>Expires {formatTime(expiresAt)}</p><button type="button" onClick={onClose}>Close</button>
  </div>;
}
export function ClaimableList({ slug, list, busy, onClaim, onHandoff }: { slug: string; list: ClaimableInstallation[]; busy: boolean; onClaim(id: number): void; onHandoff(item: ClaimableInstallation): void }) {
  return <ul>{list.map((item) => <li key={item.installationId}>{item.accountLogin ?? "GitHub installation"}
    {item.allowedForWorkspace === slug ? " — connected" : item.allowedForWorkspace ? " — connected to another workspace" : " — available"}
    {item.allowedForWorkspace !== null ? null : item.canClaim
      ? <button type="button" disabled={busy} onClick={() => onClaim(item.installationId)}>Finish connecting</button>
      : <><p>Ask an organization owner to connect it</p><button type="button" disabled={busy} onClick={() => onHandoff(item)}>Send owner handoff link</button></>}
  </li>)}</ul>;
}
/** Audit S3: every hand-off link names its organization, by id when known, else by the login the admin types. */
export function ownerHandoffBody(target: { accountId?: number | null; accountLogin?: string | null }): { accountId: number } | { accountLogin: string } | null {
  if (target.accountId != null) return { accountId: target.accountId };
  const login = target.accountLogin?.trim();
  return login ? { accountLogin: login } : null;
}
export function PendingRequestsList({ requests, busy, onHandoff }: { requests: PendingRequest[]; busy: boolean; onHandoff(accountId?: number): void }) {
  return <ul>{requests.map((request) => <li key={request.id}>
    {request.accountLogin ?? "Organization"} — requested by {request.requesterLogin ?? "your GitHub account"}. Waiting for an owner to approve.
    <button type="button" disabled={busy} onClick={() => onHandoff(request.accountId ?? undefined)}>Send owner handoff link</button>
  </li>)}</ul>;
}
export function GithubConnectionPanel({ slug }: { slug: string }) {
  const state = useLoad(() => api<ConnectionView>("GET", `${ws(slug)}/github/connection`), [slug]);
  const claimable = useLoad(() => api<{ needsGithubAccount: boolean; needsReauth: boolean; installations: ClaimableInstallation[] }>("GET", `${ws(slug)}/github/claimable`), [slug]);
  const [handoff, setHandoff] = useState<{ slug: string; link: string; expiresAt: string } | null>(null);
  const saver = useSaver();
  const reload = () => { state.reload(); claimable.reload(); };
  const createHandoff = async (target: { accountId?: number | null; accountLogin?: string | null }) => {
    const body = ownerHandoffBody(target);
    if (!body) return;
    await saver.run(async () => {
      const result = await api<{ link: string; expiresAt: string }>("POST", `${ws(slug)}/github/connect/handoff`, body);
      setHandoff({ slug, ...result });
    });
  };
  return <section className="panel"><h2>Workspace GitHub connection</h2><CallbackNotice /><button type="button" onClick={reload}>Refresh connection</button>
    <Async state={state} denied="Connecting an organization needs a workspace admin.">{(connection) => <>
      {!connection.appConfigured ? <p className="error">Ask the instance admin to configure the GitHub App client ID, client secret and App slug.</p> : null}
      {connection.installations.map((item) => <OrganisationCard key={item.installationId} item={item} busy={saver.busy} onDisconnect={async () => {
        if (!window.confirm(`Disconnect ${item.accountLogin ?? "this installation"}? Its mappings will be disabled.`)) return;
        if (await saver.run(() => api("DELETE", `${ws(slug)}/github/installations/${item.installationId}`))) reload();
      }} />)}
      <button type="button" disabled={saver.busy || !connection.appConfigured} onClick={async () => { await saver.run(async () => {
        const result = await api<{ installUrl: string }>("POST", `${ws(slug)}/github/connect`); openGithub(result.installUrl);
      }); }}>Connect GitHub</button>
      <button type="button" disabled={saver.busy || !connection.appConfigured} onClick={() => createHandoff({ accountLogin: window.prompt("Which GitHub organization should the owner connect? Enter its login.") })}>Send a link to an organization owner</button>
      {connection.pendingRequests.length ? <><h3>Pending organization approval</h3><PendingRequestsList requests={connection.pendingRequests} busy={saver.busy || !connection.appConfigured} onHandoff={(accountId) => createHandoff({ accountId })} /></> : null}
    </>}</Async>
    {handoff?.slug === slug && state.data ? <OwnerHandoffDialog key={handoff.link} {...handoff} onClose={() => setHandoff(null)} /> : null}
    {claimable.data?.needsGithubAccount || claimable.data?.needsReauth ? <p><Link href={workspaceHref(slug, "account")}>{claimable.data.needsReauth ? "Reconnect" : "Connect"} your personal GitHub account to finish connecting an installation.</Link></p> : null}
    {claimable.data ? <ClaimableList slug={slug} list={claimable.data.installations} busy={saver.busy} onClaim={async (installationId) => {
      if (await saver.run(() => api("POST", `${ws(slug)}/github/installations/${installationId}/claim`))) reload();
    }} onHandoff={(item) => { void createHandoff({ accountId: item.accountId, accountLogin: item.accountLogin }); }} /> : null}
    <ErrorNote error={claimable.error} /><SaveStatus saver={saver} />
  </section>;
}

export function RepositoryPicker({ repositories, value, onChange, disabled }: { repositories: PickableRepo[]; value: number | null; onChange(repo: PickableRepo): void; disabled?: boolean }) {
  return <select aria-label="GitHub repository" value={value ?? ""} required disabled={disabled} onChange={(event) => {
    const repo = repositories.find((item) => item.id === Number(event.target.value)); if (repo) onChange(repo);
  }}><option value="" disabled>Choose a repository</option>{value !== null && !repositories.some((repo) => repo.id === value) ? <option value={value} disabled>Previously mapped repository (access unavailable)</option> : null}
    {repositories.map((repo) => <option key={repo.id} value={repo.id}>{repo.fullName}{repo.private ? " (private)" : ""}</option>)}</select>;
}
export type { PickableRepositories };
