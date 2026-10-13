import { Link, formatTime } from "./common.tsx";
import { workspaceHref } from "./router.ts";
import type { MappingHealth, WorkspaceHealth } from "./types.ts";

export function MappingHealthCard({ slug, health }: { slug: string; health: MappingHealth }) {
  const errors = `${workspaceHref(slug, "audit")}?mappingId=${health.mappingId}&errors=1&hours=24`;
  return <div aria-label="Mapping sync health">
    {health.disabledReason ? <p className="error"><strong>Disabled</strong> · {health.disabledReason}</p> : null}
    <dl className="facts">
      <dt>Last GitHub delivery</dt><dd>{formatTime(health.lastGithubDeliveryAt)}</dd>
      <dt>Last Plane delivery</dt><dd>{formatTime(health.lastPlaneDeliveryAt)}</dd>
      <dt>Last successful write</dt><dd>{formatTime(health.lastSuccessfulWriteAt)}</dd>
      <dt>Errors in the last 24 hours</dt><dd><Link href={errors}>{health.failuresLast24h}</Link></dd>
      {health.rateLimitedUntil ? <><dt>Rate-limited until</dt><dd>{formatTime(health.rateLimitedUntil)}</dd></> : null}
    </dl>
  </div>;
}

export function WorkspaceHealthBanners({ health }: { health: WorkspaceHealth }) {
  return <>
    {!health.database ? <p className="error" role="alert">The sync database is unreachable. Settings and activity cannot be loaded.</p> : null}
    {health.planeWebhookSilent ? <p className="error" role="alert">Plane changes have stopped arriving. Ask a workspace admin to re-enable the Git sync webhook in Plane’s webhook settings.</p> : null}
    {health.database && !health.githubAppCredentials.decryptOk ? <p className="error" role="alert">GitHub App credentials could not be decrypted. Ask an instance admin to repair the GitHub App settings.</p> : null}
    {health.healthError ? <p className="error" role="alert">{health.healthError}</p> : null}
  </>;
}

export function SetupChecklist({ slug, setup }: { slug: string; setup: WorkspaceHealth["setup"] }) {
  return <section aria-label="Setup checklist"><h3>Set up GitHub sync</h3><ol>
    <li>Connect the GitHub App and choose a repository below.</li>
    <li>Rules: {setup.rules === "defaults" ? "shipping defaults are ready; customize them after adding a mapping" : "custom rules are saved"}.</li>
    <li>Conflict policies: {setup.policies === "defaults" ? "default policies are ready; customize them after adding a mapping" : "custom policies are saved"}.</li>
    <li><Link href={workspaceHref(slug, "users")}>Member accounts</Link>: {setup.membersLinked} linked{setup.membersTotal === null ? "; total membership could not be loaded" : ` of ${setup.membersTotal}`}.</li>
    <li>App events: {setup.appEventsVerified === true ? "verified" : setup.appEventsVerified === false ? "need attention from an instance admin" : "not yet verified; ask an instance admin to check setup"}.</li>
  </ol></section>;
}
