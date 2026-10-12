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
    PLANE_API_RATE_PER_MINUTE: 60,
    GITHUB_APP_ID: req("GITHUB_APP_ID"),
    GITHUB_PRIVATE_KEY_PATH: req("GITHUB_PRIVATE_KEY_PATH"),
    GITHUB_CREDENTIAL_MARKER_PATH: env.GITHUB_CREDENTIAL_MARKER_PATH || DEFAULT_CREDENTIAL_MARKER_PATH,
    GITHUB_WEBHOOK_SECRET: req("GITHUB_WEBHOOK_SECRET"),
    GITSYNC_TOKEN_KEY: req("GITSYNC_TOKEN_KEY"),
    PUBLIC_ORIGIN: env.PUBLIC_ORIGIN || "https://tasks.qelal.et",
    REQUIRE_VERIFIED_COMMITS: /^(1|true|yes)$/i.test(env.REQUIRE_VERIFIED_COMMITS ?? ""),
  };
  if (env.PLANE_API_RATE_PER_MINUTE !== undefined && env.PLANE_API_RATE_PER_MINUTE !== "") {
    const rate = Number(env.PLANE_API_RATE_PER_MINUTE);
    if (!Number.isInteger(rate) || rate < 1) {
      console.error(`PLANE_API_RATE_PER_MINUTE must be a positive whole number of requests per minute, got "${env.PLANE_API_RATE_PER_MINUTE}"`);
      process.exit(1);
    }
    config.PLANE_API_RATE_PER_MINUTE = rate;
  }
  if (!config.PLANE_SERVICE_USER_ID && !missing.includes("PLANE_SERVICE_USER_ID")) missing.push("PLANE_SERVICE_USER_ID");
  if (env.GITHUB_API_BASE_URL) config.GITHUB_API_BASE_URL = env.GITHUB_API_BASE_URL;

  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }

  return config;
}
