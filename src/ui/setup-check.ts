import type { Db } from "../db/migrate.ts";
import type { CredentialSource } from "../app/credentials.ts";
import type { GithubClient } from "../app/github.ts";
import { classifyGithubError } from "../github/errors.ts";

/** Context7 /websites/github_en_rest; N7 checks the registration via App-JWT GET /app. */
export const REQUIRED_APP_PERMISSIONS = Object.freeze({
  pull_requests: "write", issues: "write", contents: "write", checks: "read",
  statuses: "read", deployments: "read", metadata: "read", members: "read",
} as const);

/** installation/installation_repositories are automatic, not manually selectable subscriptions. */
export const REQUIRED_APP_EVENTS = Object.freeze([
  "pull_request", "pull_request_review", "push", "issues", "issue_comment",
  "check_suite", "check_run", "status", "deployment_status",
]);

export type SetupCheckStatus = "pass" | "fail" | "unknown";
export interface SetupCheckItem {
  id: "credentials" | "github_permissions" | "github_events" | "github_delivery" | "plane_delivery" | "plane_rate_limit";
  title: string;
  status: SetupCheckStatus;
  detail: string;
  /** Anchor in deploy/APPLY.md; the UI resolves the runbook's location. */
  runbookAnchor: string;
  data: Record<string, unknown>;
}
export interface SetupCheckResult { checkedAt: string; ok: boolean; checks: SetupCheckItem[] }
export interface SetupCheckDeps {
  db: Db;
  credentials: Pick<CredentialSource, "describe">;
  github: Pick<GithubClient, "appRequest">;
  plane: { readonly rateLimitPerMinute: number };
  config: { PLANE_API_RATE_PER_MINUTE?: number };
  /** Authoritative deployment-setting read, if available. CE v1.4.2 has no total-limit response header. */
  readPlaneRateLimit?: () => Promise<number | null>;
  now?: () => number;
}

const item = (id: SetupCheckItem["id"], title: string, status: SetupCheckStatus, detail: string,
  runbookAnchor: string, data: Record<string, unknown> = {}): SetupCheckItem => ({ id, title, status, detail, runbookAnchor, data });
const permissionLevel = (value: unknown): number => value === "read" ? 1 : value === "write" ? 2 : value === "admin" ? 3 : 0;

/** No remote writes. G5 must register this behind the existing instance-admin authorization wrapper. */
export function createSetupCheckHandler(deps: SetupCheckDeps): () => Promise<SetupCheckResult> {
  return () => checkSetup(deps);
}

export async function checkSetup(deps: SetupCheckDeps): Promise<SetupCheckResult> {
  const at = new Date((deps.now ?? Date.now)());
  const [credentials, deliveries, autolinks, serverRate] = await Promise.allSettled([
    Promise.resolve().then(() => deps.credentials.describe()),
    Promise.resolve().then(() => deps.db.query<{ source: "github" | "plane"; at: string | Date | null }>(`WITH seen AS (
      SELECT source, max(received_at) AS at FROM webhook_deliveries
        WHERE source IN ('github', 'plane') AND received_at <= $1
          AND delivery_id NOT LIKE 'github-rate-limit:%' AND delivery_id NOT LIKE 'content:%'
          AND delivery_id NOT LIKE 'replay-%' AND delivery_id NOT LIKE 'backfill-%'
        GROUP BY source
      UNION ALL
      SELECT source, max(created_at) AS at FROM audit_log
        WHERE kind = 'inbound_delivery' AND source IN ('github', 'plane') AND created_at <= $1
          AND delivery_id NOT LIKE 'replay-%' AND delivery_id NOT LIKE 'backfill-%'
          AND delivery_id NOT LIKE 'content:%' AND delivery_id NOT LIKE 'github-rate-limit:%'
        GROUP BY source
      UNION ALL
      SELECT source, max(received_at) AS at FROM inbound_spool
        WHERE source IN ('github', 'plane') AND received_at <= $1
          AND delivery_id NOT LIKE 'replay-%' AND delivery_id NOT LIKE 'backfill-%'
          AND delivery_id NOT LIKE 'content:%' AND delivery_id NOT LIKE 'github-rate-limit:%'
        GROUP BY source
    ) SELECT source, max(at) AS at FROM seen GROUP BY source`, [at])),
    Promise.resolve().then(() => deps.db.query<{ enabled: boolean }>("SELECT EXISTS (SELECT 1 FROM repo_mappings WHERE autolinks_enabled = true) AS enabled")),
    Promise.resolve().then(() => deps.readPlaneRateLimit ? deps.readPlaneRateLimit() : null),
  ]);
  const checks: SetupCheckItem[] = [];
  const decryptOk = credentials.status === "fulfilled" && credentials.value.decryptOk === true;
  checks.push(item("credentials", "App credentials", decryptOk ? "pass" : "fail",
    decryptOk ? "Active App credentials can be read and decrypted." : "App credentials cannot be read or decrypted. Check the stored key and token encryption key.",
    "4-setup-secrets--environment", credentials.status === "fulfilled" ? { source: credentials.value.source, decryptOk } : { decryptOk }));

  let app: any, appError: unknown;
  if (decryptOk && deps.github.appRequest) {
    try { app = (await deps.github.appRequest("GET /app", {})).data; }
    catch (err) { appError = err; }
  }
  if (!app || appError || !decryptOk) {
    const failure = appError ? classifyGithubError(appError, { now: at.getTime() }) : undefined;
    const status: SetupCheckStatus = failure?.kind === "permission" || (appError && failure?.kind === "permanent") ? "fail" : "unknown";
    const detail = !decryptOk ? "Read the App credentials first."
      : failure?.kind === "rate_limited" ? "GitHub has deferred this check until its rate limit resets."
      : !deps.github.appRequest ? "The App JWT client is unavailable."
      : "The App registration could not be read from GitHub. Retry after checking App authentication and connectivity.";
    const data = failure?.kind === "rate_limited" ? { retryAt: failure.retryAt } : {};
    checks.push(item("github_permissions", "App permissions", status, detail, "github-app-registration", data));
    checks.push(item("github_events", "App webhook events", status, detail, "github-app-registration", data));
  } else {
    const required: Record<string, "read" | "write"> = { ...REQUIRED_APP_PERMISSIONS };
    if (autolinks.status === "fulfilled" && autolinks.value.rows[0]?.enabled) required.administration = "write";
    const permissionsValid = app.permissions !== null && typeof app.permissions === "object" && !Array.isArray(app.permissions);
    const granted: Record<string, string> = permissionsValid ? app.permissions : {};
    const missing = Object.entries(required).filter(([name, level]) => permissionLevel(granted[name]) < permissionLevel(level))
      .map(([permission, required]) => ({ permission, required, granted: permissionLevel(granted[permission]) ? granted[permission] : null }));
    const permissionStatus = !permissionsValid || missing.length ? "fail" : autolinks.status === "rejected" ? "unknown" : "pass";
    checks.push(item("github_permissions", "App permissions", permissionStatus,
      !permissionsValid ? "GitHub returned an invalid permissions object."
        : missing.length ? "The App registration is missing required permission levels. Update it and verify installation approval."
        : autolinks.status === "rejected" ? "Base permissions match, but the optional autolink permission requirement could not be checked."
        : "Required App registration permissions match. Verify installation approval after any permission change.",
      "github-app-registration", { required, missing, scope: "app_registration", ...(autolinks.status === "fulfilled" ? { autolinksEnabled: Boolean(autolinks.value.rows[0]?.enabled) } : {}) }));
    const eventsValid = Array.isArray(app.events) && app.events.every((event: unknown) => typeof event === "string");
    const subscribed = new Set<string>(eventsValid ? app.events : []);
    const missingEvents = REQUIRED_APP_EVENTS.filter((event) => !subscribed.has(event));
    checks.push(item("github_events", "App webhook events", eventsValid && !missingEvents.length ? "pass" : "fail",
      !eventsValid ? "GitHub returned an invalid event list." : missingEvents.length ? "Subscribe the App to the missing webhook events." : "Required webhook subscriptions match.",
      "github-app-registration", { required: [...REQUIRED_APP_EVENTS], missing: missingEvents }));
  }

  for (const source of ["github", "plane"] as const) {
    const raw = deliveries.status === "fulfilled" ? deliveries.value.rows.find((row) => row.source === source)?.at : null;
    const date = raw ? new Date(raw) : null;
    const lastDeliveryAt = date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
    checks.push(item(source === "github" ? "github_delivery" : "plane_delivery",
      source === "github" ? "Signed GitHub deliveries" : "Plane deliveries",
      deliveries.status === "rejected" ? "unknown" : lastDeliveryAt ? "pass" : "unknown",
      deliveries.status === "rejected" ? "Delivery history could not be read."
        : lastDeliveryAt ? "A verified transport delivery was processed or durably spooled."
        : "No verified transport delivery is recorded yet. Make an issue or PR change to verify the webhook.",
      "8-register-webhooks--rate-limiting", { lastDeliveryAt, evidence: "processed_or_spooled" }));
  }

  const configured = deps.config.PLANE_API_RATE_PER_MINUTE ?? 60;
  const client = deps.plane.rateLimitPerMinute;
  const actual = serverRate.status === "fulfilled" ? serverRate.value : null;
  const positive = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;
  const localMatches = positive(configured) && positive(client) && configured === client;
  const serverKnown = positive(actual);
  const rateStatus: SetupCheckStatus = !localMatches || (actual !== null && !serverKnown) || (serverKnown && actual !== configured) ? "fail"
    : serverKnown ? "pass" : "unknown";
  checks.push(item("plane_rate_limit", "Plane request rate", rateStatus,
    !localMatches ? "The active client request limit differs from PLANE_API_RATE_PER_MINUTE. Restart with matching settings."
      : serverKnown && actual !== configured ? "Plane API_KEY_RATE_LIMIT differs from this service's request limit. Set matching limits."
      : actual !== null && !serverKnown ? "The Plane deployment rate setting is invalid."
      : serverKnown ? "Plane's deployment setting and this service's request limit match."
      : "The client limit matches config. Confirm Plane API_KEY_RATE_LIMIT separately: Plane v1.4.2 does not expose the total limit in API response headers.",
    "8-register-webhooks--rate-limiting", { configuredPerMinute: configured, clientPerMinute: client, planePerMinute: actual, serverVerified: serverKnown }));
  return { checkedAt: at.toISOString(), ok: checks.every((check) => check.status === "pass"), checks };
}
