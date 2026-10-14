import { deriveGithubHosts, githubAppInstallUrl } from "../github/hosts.ts";
import type { GithubEdition } from "../github/hosts.ts";

export const DEFAULT_CREDENTIAL_MARKER_PATH = "/var/lib/gitsync/credentials/bootstrap-retired";

export interface Config {
  PORT: number;
  HOST: string;
  DATABASE_URL: string;
  REDIS_URL: string;
  QUEUE_PREFIX: string;
  PLANE_BASE_URL: string;
  PLANE_SERVICE_PAT: string;
  PLANE_WEBHOOK_SECRET: string;
  /** Accepted alongside the current secret during Plane webhook secret rotation. */
  PLANE_WEBHOOK_SECRET_PREVIOUS?: string;
  /** Match Plane SESSION_COOKIE_NAME; defaults to session-id. */
  PLANE_SESSION_COOKIE_NAME?: string;
  /** GitHub App bootstrap. Optional: all three are set together, or all are empty ("") and the App is
   *  configured later in the instance-admin UI, which stores it encrypted in the database. */
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY_PATH: string;
  /** Durable writable storage, separate from the read-only private-key mount. */
  GITHUB_CREDENTIAL_MARKER_PATH?: string;
  GITHUB_WEBHOOK_SECRET: string;
  GITSYNC_TOKEN_KEY: string;
  PLANE_SERVICE_USER_ID: string;
  /** Requests per minute the Plane client may send. Must equal Plane's own API_KEY_RATE_LIMIT (plane.env), 60 by default. */
  PLANE_API_RATE_PER_MINUTE?: number;
  GITHUB_API_BASE_URL?: string;
  /** Inferred from legacy GITHUB_API_BASE_URL when no edition is supplied. */
  GITHUB_EDITION?: GithubEdition;
  GITHUB_GHE_SUBDOMAIN?: string;
  GITHUB_GHES_BASE_URL?: string;
  /** Derived output; configure the edition/host rather than setting this environment variable. */
  GITHUB_WEB_ORIGIN?: string;
  /** Optional OAuth bootstrap; wave 2 stores the secret encrypted with App credentials. */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_APP_SLUG?: string;
  PUBLIC_ORIGIN: string;
  REQUIRE_VERIFIED_COMMITS: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const missing: string[] = [];
  const req = (name: string): string => {
    const val = env[name];
    if (!val) {
      missing.push(name);
      return "";
    }
    return val;
  };

  const config: Config = {
    PORT: env.PORT ? parseInt(env.PORT, 10) : 3100,
    HOST: env.HOST || "0.0.0.0",
    DATABASE_URL: req("DATABASE_URL"),
    REDIS_URL: req("REDIS_URL"),
    QUEUE_PREFIX: env.QUEUE_PREFIX || "gitsync",
    PLANE_BASE_URL: req("PLANE_BASE_URL"),
    PLANE_SERVICE_PAT: req("PLANE_SERVICE_PAT"),
    PLANE_SERVICE_USER_ID: req("PLANE_SERVICE_USER_ID").trim(),
    PLANE_WEBHOOK_SECRET: req("PLANE_WEBHOOK_SECRET"),
    PLANE_SESSION_COOKIE_NAME: env.PLANE_SESSION_COOKIE_NAME || "session-id",
    PLANE_API_RATE_PER_MINUTE: 60,
    GITHUB_APP_ID: env.GITHUB_APP_ID?.trim() ?? "",
    GITHUB_PRIVATE_KEY_PATH: env.GITHUB_PRIVATE_KEY_PATH?.trim() ?? "",
    GITHUB_CREDENTIAL_MARKER_PATH: env.GITHUB_CREDENTIAL_MARKER_PATH || DEFAULT_CREDENTIAL_MARKER_PATH,
    GITHUB_WEBHOOK_SECRET: env.GITHUB_WEBHOOK_SECRET ?? "",
    GITSYNC_TOKEN_KEY: req("GITSYNC_TOKEN_KEY"),
    PUBLIC_ORIGIN: env.PUBLIC_ORIGIN || "https://tasks.qelal.et",
    REQUIRE_VERIFIED_COMMITS: /^(1|true|yes)$/i.test(env.REQUIRE_VERIFIED_COMMITS ?? ""),
  };
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(config.PLANE_SESSION_COOKIE_NAME!)) {
    console.error("PLANE_SESSION_COOKIE_NAME must be a valid cookie name");
    process.exit(1);
  }
  if (env.PLANE_API_RATE_PER_MINUTE !== undefined && env.PLANE_API_RATE_PER_MINUTE !== "") {
    const rate = Number(env.PLANE_API_RATE_PER_MINUTE);
    if (!Number.isInteger(rate) || rate < 1) {
      console.error(`PLANE_API_RATE_PER_MINUTE must be a positive whole number of requests per minute, got "${env.PLANE_API_RATE_PER_MINUTE}"`);
      process.exit(1);
    }
    config.PLANE_API_RATE_PER_MINUTE = rate;
  }
  if (!config.PLANE_SERVICE_USER_ID && !missing.includes("PLANE_SERVICE_USER_ID")) missing.push("PLANE_SERVICE_USER_ID");
  const githubBootstrap = { GITHUB_APP_ID: config.GITHUB_APP_ID, GITHUB_PRIVATE_KEY_PATH: config.GITHUB_PRIVATE_KEY_PATH, GITHUB_WEBHOOK_SECRET: config.GITHUB_WEBHOOK_SECRET };
  const githubSet = Object.entries(githubBootstrap).filter(([, v]) => v !== "");
  if (githubSet.length > 0 && githubSet.length < 3) {
    for (const [name, v] of Object.entries(githubBootstrap)) if (v === "") missing.push(name);
  }
  try {
    const hosts = deriveGithubHosts({
      edition: (env.GITHUB_EDITION?.trim() || undefined) as GithubEdition | undefined,
      gheSubdomain: env.GITHUB_GHE_SUBDOMAIN,
      gheBaseUrl: env.GITHUB_GHES_BASE_URL,
      apiBaseUrl: env.GITHUB_API_BASE_URL,
    });
    config.GITHUB_EDITION = hosts.edition;
    config.GITHUB_WEB_ORIGIN = hosts.webOrigin;
    // Keep the existing unset default for GitHub.com bootstrap consumers.
    if (hosts.edition !== "github" || env.GITHUB_API_BASE_URL) config.GITHUB_API_BASE_URL = hosts.apiBaseUrl;
    if (hosts.edition === "ghe_cloud") config.GITHUB_GHE_SUBDOMAIN = hosts.webOrigin.slice("https://".length, -".ghe.com".length);
    if (hosts.edition === "ghes") config.GITHUB_GHES_BASE_URL = hosts.webOrigin;
    const clientId = env.GITHUB_CLIENT_ID?.trim() || undefined;
    const clientSecret = env.GITHUB_CLIENT_SECRET || undefined;
    if (Boolean(clientId) !== Boolean(clientSecret)) throw new Error("GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be supplied together");
    if (clientId) { config.GITHUB_CLIENT_ID = clientId; config.GITHUB_CLIENT_SECRET = clientSecret; }
    if (env.GITHUB_APP_SLUG) {
      config.GITHUB_APP_SLUG = env.GITHUB_APP_SLUG.trim();
      githubAppInstallUrl(hosts, config.GITHUB_APP_SLUG); // Reject path/query injection before callback wiring.
    }
  } catch (error) {
    console.error(`Invalid GitHub configuration: ${error instanceof Error ? error.message : "invalid host or OAuth settings"}`);
    process.exit(1);
  }
  if (env.PLANE_WEBHOOK_SECRET_PREVIOUS) config.PLANE_WEBHOOK_SECRET_PREVIOUS = env.PLANE_WEBHOOK_SECRET_PREVIOUS;

  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }

  return config;
}

