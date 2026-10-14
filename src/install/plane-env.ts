// Installer: reads what git-sync needs from a running Plane install. install.sh hands over the environment of
// Plane's own `api` and `plane-db` containers (`docker inspect`), which is authoritative whatever the env file
// is called (plane.env, variables.env, ...), so the operator is never asked for a value Plane already has.

/** Parses KEY=VALUE lines (env files and `docker inspect` output). Blank lines and # comments are skipped;
 *  one pair of matching surrounding quotes is removed. The first `=` splits, so values may contain `=`. */
export function parseEnvText(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice(7) : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1);
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    out.set(key, value);
  }
  return out;
}

export interface PlaneFacts {
  /** Superuser that may create the gitsync role and database. */
  postgresUser: string;
  postgresPassword: string;
  postgresHost: string;
  postgresPort: number;
  redisUrl: string;
  /** Browser origin of the Plane site, e.g. https://tasks.example.com. Empty when Plane does not say. */
  publicOrigin: string;
  /** Plane's API_KEY_RATE_LIMIT expressed per minute (git-sync must not exceed it). */
  apiRatePerMinute: number;
  sessionCookieName: string;
}

/** Plane's limit is a Django REST framework rate: "<n>/<period>", period second|minute|hour|day (or s/m/h/d). */
export function ratePerMinute(value: string | undefined): number {
  if (!value?.trim()) return 60;
  const m = /^\s*(\d+)\s*\/\s*([a-z]+)\s*$/i.exec(value);
  if (!m) throw new Error(`API_KEY_RATE_LIMIT "${value}" is not of the form <number>/<period>`);
  const n = Number(m[1]);
  const unit = (m[2] ?? "").toLowerCase()[0];
  const perMinute = unit === "s" ? n * 60 : unit === "m" ? n : unit === "h" ? Math.floor(n / 60) : unit === "d" ? Math.floor(n / 1440) : NaN;
  if (!Number.isFinite(perMinute)) throw new Error(`API_KEY_RATE_LIMIT "${value}" has an unknown period`);
  return Math.max(1, perMinute);
}

function origin(value: string | undefined): string {
  if (!value?.trim()) return "";
  try {
    const u = new URL(value.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : "";
  } catch { return ""; }
}

/** `api` carries Plane's application settings; `db` the Postgres container's (POSTGRES_USER/PASSWORD). */
export function planeFacts(api: Map<string, string>, db: Map<string, string>): PlaneFacts {
  const pick = (...keys: string[]) => { for (const k of keys) { const v = api.get(k) ?? db.get(k); if (v) return v; } return ""; };
  const postgresUser = db.get("POSTGRES_USER") || api.get("POSTGRES_USER") || "plane";
  const postgresPassword = db.get("POSTGRES_PASSWORD") || api.get("POSTGRES_PASSWORD") || "";
  if (!postgresPassword) throw new Error("Could not read POSTGRES_PASSWORD from Plane's plane-db container");
  const redisHost = api.get("REDIS_HOST") || "plane-redis";
  const redisPort = api.get("REDIS_PORT") || "6379";
  const appDomain = api.get("APP_DOMAIN");
  const publicOrigin = origin(api.get("WEB_URL")) || (appDomain && appDomain !== "localhost" ? origin(`https://${appDomain}`) : "");
  return {
    postgresUser,
    postgresPassword,
    postgresHost: api.get("PGHOST") || "plane-db",
    postgresPort: Number(api.get("POSTGRES_PORT") || 5432),
    redisUrl: api.get("REDIS_URL") || `redis://${redisHost}:${redisPort}`,
    publicOrigin,
    apiRatePerMinute: ratePerMinute(pick("API_KEY_RATE_LIMIT")),
    sessionCookieName: pick("SESSION_COOKIE_NAME") || "session-id",
  };
}
