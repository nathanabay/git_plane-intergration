// Installer: writes git-sync.env. A re-run keeps every value already in the file (secrets above all: a new
// GITSYNC_TOKEN_KEY would make every stored token undecryptable), fills only what is missing, and keeps any
// extra settings the operator added by hand.
import { randomBytes } from "node:crypto";
import { parseEnvText } from "./plane-env.ts";

export interface EnvInputs {
  dbPassword?: string;
  postgresHost: string;
  postgresPort: number;
  redisUrl: string;
  publicOrigin: string;
  apiRatePerMinute: number;
  sessionCookieName: string;
  planePat?: string;
  planeServiceUserId?: string;
  planeWebhookSecret?: string;
  github?: { appId: string; webhookSecret: string };
}

/** Hex, not base64: base64 can contain "/" and "+", which break the postgres:// URL. */
export const newDbPassword = (): string => randomBytes(24).toString("hex");
export const newTokenKey = (): string => randomBytes(32).toString("base64");

/** Keys this installer owns, in the order they are written. Everything else in an existing file is kept as is. */
const SECTIONS: { title: string; keys: string[] }[] = [
  { title: "Service", keys: ["PORT", "PUBLIC_ORIGIN", "QUEUE_PREFIX"] },
  { title: "Storage (Plane's own Postgres and Valkey; the gitsync database is separate from Plane's)", keys: ["DATABASE_URL", "REDIS_URL"] },
  { title: "Plane", keys: ["PLANE_BASE_URL", "PLANE_SESSION_COOKIE_NAME", "PLANE_SERVICE_PAT", "PLANE_SERVICE_USER_ID", "PLANE_WEBHOOK_SECRET", "PLANE_API_RATE_PER_MINUTE"] },
  { title: "Encryption key for stored tokens and App credentials. Back it up; never change it.", keys: ["GITSYNC_TOKEN_KEY"] },
  { title: "GitHub App (optional here: add or change it later in God mode > Git Sync > GitHub App)", keys: ["GITHUB_APP_ID", "GITHUB_PRIVATE_KEY_PATH", "GITHUB_WEBHOOK_SECRET"] },
];
const OWNED = new Set(SECTIONS.flatMap((s) => s.keys));

export function dbPasswordFrom(databaseUrl: string | undefined): string | undefined {
  if (!databaseUrl) return undefined;
  try { return decodeURIComponent(new URL(databaseUrl).password) || undefined; } catch { return undefined; }
}

/** Returns the new file text and the values it holds. `existing` is the current file's text, or "". */
export function renderEnvFile(existingText: string, input: EnvInputs): { text: string; values: Map<string, string> } {
  const existing = parseEnvText(existingText);
  const values = new Map<string, string>();
  const keep = (key: string, fresh: string | undefined) => {
    const old = existing.get(key);
    const value = old !== undefined && old !== "" ? old : fresh;
    if (value !== undefined && value !== "") values.set(key, value);
  };
  // The database password must agree with the role's: the installer sets the role from this value.
  const dbPassword = dbPasswordFrom(existing.get("DATABASE_URL")) ?? input.dbPassword ?? newDbPassword();
  keep("PORT", "3100");
  keep("PUBLIC_ORIGIN", input.publicOrigin);
  keep("QUEUE_PREFIX", "gitsync");
  keep("DATABASE_URL", `postgres://gitsync:${encodeURIComponent(dbPassword)}@${input.postgresHost}:${input.postgresPort}/gitsync`);
  keep("REDIS_URL", input.redisUrl);
  keep("PLANE_BASE_URL", "http://api:8000");
  keep("PLANE_SESSION_COOKIE_NAME", input.sessionCookieName);
  // Answers given on this run replace old ones (a re-run is how an operator changes them).
  const set = (key: string, value: string | undefined) => { if (value) values.set(key, value); else keep(key, undefined); };
  set("PLANE_SERVICE_PAT", input.planePat);
  set("PLANE_SERVICE_USER_ID", input.planeServiceUserId);
  set("PLANE_WEBHOOK_SECRET", input.planeWebhookSecret);
  // Plane's limit is read fresh each run: git-sync must follow it when Plane's is changed.
  values.set("PLANE_API_RATE_PER_MINUTE", String(input.apiRatePerMinute));
  keep("GITSYNC_TOKEN_KEY", newTokenKey());
  if (input.github) {
    values.set("GITHUB_APP_ID", input.github.appId);
    values.set("GITHUB_PRIVATE_KEY_PATH", "/run/secrets/github-app.pem");
    values.set("GITHUB_WEBHOOK_SECRET", input.github.webhookSecret);
  } else {
    for (const k of ["GITHUB_APP_ID", "GITHUB_PRIVATE_KEY_PATH", "GITHUB_WEBHOOK_SECRET"]) keep(k, undefined);
  }

  const lines = ["# git-sync settings, written by install.sh. Re-running install.sh keeps every value here.", ""];
  for (const section of SECTIONS) {
    const present = section.keys.filter((k) => values.has(k));
    lines.push(`# ${section.title}`);
    if (!present.length) lines.push("# (not set)");
    for (const k of present) lines.push(`${k}=${values.get(k)}`);
    lines.push("");
  }
  const extra = [...existing].filter(([k]) => !OWNED.has(k));
  if (extra.length) {
    lines.push("# Other settings (kept from the previous file)");
    for (const [k, v] of extra) { lines.push(`${k}=${v}`); values.set(k, v); }
    lines.push("");
  }
  return { text: lines.join("\n"), values };
}
