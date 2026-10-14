// Installer, container side. install.sh runs this inside the git-sync image on Plane's Docker network, so the
// host needs nothing but Docker. Mounts: /plane = the Plane install directory, /install = a private scratch
// directory holding Plane's container environments (api.env, db.env), Plane's proxy Caddyfile and, optionally,
// a GitHub App private key. Nothing secret is printed.
//
//   node src/install/main.ts configure [--proxy plane|external] [--gateway-network NAME] [--ui-forks] [--yes]
//   node src/install/main.ts uninstall [--purge]
import { chmodSync, chownSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { addGitSyncRoute } from "./caddy.ts";
import { FORK_IMAGES, PROXY_MOUNT, hasGitSync, mergeOverride, removeOverride } from "./compose.ts";
import type { OverrideOptions } from "./compose.ts";
import { dropDatabase, ensureDatabase } from "./database.ts";
import { dbPasswordFrom, renderEnvFile } from "./env-file.ts";
import { parseEnvText, planeFacts } from "./plane-env.ts";
import { planeUserForKey } from "./plane-api.ts";

const PLANE = process.env.GITSYNC_INSTALL_PLANE_DIR ?? "/plane";
const SCRATCH = process.env.GITSYNC_INSTALL_SCRATCH ?? "/install";
const NODE_UID = 1000; // the image's non-root `node` user, which runs git-sync

const say = (msg = "") => process.stdout.write(`${msg}\n`);
const step = (msg: string) => say(`  - ${msg}`);
class InstallError extends Error {}

function args(argv: string[]) {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (!a.startsWith("--")) continue;
    const [k = "", v] = a.slice(2).split("=", 2);
    const next = argv[i + 1];
    if (v !== undefined) flags.set(k, v);
    else if (next !== undefined && !next.startsWith("--")) { flags.set(k, next); i++; }
    else flags.set(k, true);
  }
  return flags;
}

function overridePath(): string {
  for (const name of ["docker-compose.override.yaml", "docker-compose.override.yml", "compose.override.yaml", "compose.override.yml"]) {
    if (existsSync(join(PLANE, name))) return join(PLANE, name);
  }
  const base = readdirSync(PLANE).find((f) => /^(docker-)?compose\.ya?ml$/.test(f)) ?? "docker-compose.yaml";
  return join(PLANE, base.replace(/\.ya?ml$/, (ext) => `.override${ext}`));
}

function backup(path: string): string | null {
  if (!existsSync(path)) return null;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  const to = `${path}.bak-${stamp}`;
  copyFileSync(path, to);
  return to;
}

function writePrivate(path: string, text: string, mode = 0o600) {
  writeFileSync(path, text, { mode });
  chmodSync(path, mode);
}

// ---- prompts ---------------------------------------------------------------------------------------------

const interactive = () => Boolean(process.stdin.isTTY);

function ask(question: string, { secret = false } = {}): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (secret) {
      // Echo nothing while a secret is typed.
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
        if (s.startsWith(question)) process.stdout.write(question);
        else if (s.includes("\n") || s.includes("\r")) process.stdout.write("\n");
      };
    }
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

/** A value from the environment (non-interactive), else from a prompt, else an error naming the flag. */
async function obtain(label: string, envName: string, flag: string, opts: { secret?: boolean; help?: string[] } = {}): Promise<string> {
  const fromEnv = process.env[envName]?.trim();
  if (fromEnv) return fromEnv;
  if (!interactive()) throw new InstallError(`${label} is required: pass ${flag} (or set ${envName})`);
  say();
  for (const line of opts.help ?? []) say(`  ${line}`);
  for (;;) {
    const answer = await ask(`  ${label}: `, { secret: opts.secret });
    if (answer) return answer;
    say("  (required)");
  }
}

function checkValue(name: string, value: string): string {
  // git-sync.env is read by docker compose: keep values to one plain token.
  if (/[\s"'`$\\#]/.test(value)) throw new InstallError(`${name} contains spaces, quotes or other characters that cannot go in git-sync.env`);
  return value;
}

// ---- configure -------------------------------------------------------------------------------------------

async function configure(flags: Map<string, string | true>) {
  const proxy = (flags.get("proxy") ?? "plane") as OverrideOptions["proxy"];
  if (proxy !== "plane" && proxy !== "external") throw new InstallError("--proxy must be plane or external");
  const gatewayNetwork = typeof flags.get("gateway-network") === "string" ? String(flags.get("gateway-network")) : undefined;
  const uiForks = flags.get("ui-forks") === true;

  const api = parseEnvText(readFileSync(join(SCRATCH, "api.env"), "utf8"));
  const db = parseEnvText(readFileSync(join(SCRATCH, "db.env"), "utf8"));
  const facts = planeFacts(api, db);
  const envPath = join(PLANE, "git-sync.env");
  const existingText = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const existing = parseEnvText(existingText);
  const rerun = existingText !== "";

  if (rerun) step("Updating the existing configuration; its secrets are kept");

  // Public origin: Plane's WEB_URL, unless the operator overrides it.
  let publicOrigin = process.env.GITSYNC_PUBLIC_ORIGIN?.trim() || existing.get("PUBLIC_ORIGIN") || facts.publicOrigin;
  if (!publicOrigin) {
    publicOrigin = await obtain("Public URL of your Plane site (e.g. https://plane.example.com)", "GITSYNC_PUBLIC_ORIGIN", "--public-url");
  }
  try { publicOrigin = new URL(publicOrigin).origin; } catch { throw new InstallError(`Public URL "${publicOrigin}" is not a URL`); }
  step(`Plane site: ${publicOrigin}`);

  // Plane service account API key -> its user id, verified against Plane right now.
  const planeBase = existing.get("PLANE_BASE_URL") || "http://api:8000";
  const askPat = async () => checkValue("Plane API key", await obtain(
    "Plane API key of the git-sync service account", "GITSYNC_PLANE_PAT", "GITSYNC_PLANE_PAT", { secret: true, help: [
      "git-sync acts in Plane as a service account. Use a dedicated Plane user (for example \"GitHub Bot\"),",
      "add it to the workspaces you will sync, then in Plane: Profile settings > Personal access tokens > Add.",
    ] }));
  const given = process.env.GITSYNC_PLANE_PAT?.trim();
  let pat = given ? checkValue("Plane API key", given) : existing.get("PLANE_SERVICE_PAT") || await askPat();
  let user;
  const waitUntil = Date.now() + 180_000;
  for (;;) {
    try { user = await planeUserForKey(planeBase, pat); break; }
    catch (err) {
      // A Plane that was just started answers only after its migrations: keep trying for a while.
      if (/Could not reach|answered 5\d\d/.test((err as Error).message) && Date.now() < waitUntil) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      // A stored key that Plane no longer accepts (revoked, user removed): ask for a new one when someone is there.
      const storedKeyRejected = !given && interactive() && /rejected the API key/.test((err as Error).message);
      if (!storedKeyRejected) throw new InstallError((err as Error).message);
      say(`  ${(err as Error).message}`);
      pat = await askPat();
    }
  }
  step(`Plane service account: ${user.displayName || user.email || user.id}`);

  // Plane webhook secret: Plane generates it when the webhook is created.
  const webhookUrl = `${publicOrigin}/git-sync/webhooks/plane`;
  const planeWebhookSecret = checkValue("Plane webhook secret", process.env.GITSYNC_PLANE_WEBHOOK_SECRET?.trim() || existing.get("PLANE_WEBHOOK_SECRET") || await obtain(
    "Plane webhook secret", "GITSYNC_PLANE_WEBHOOK_SECRET", "--plane-webhook-secret", { secret: true, help: [
      "In Plane: Workspace settings > Webhooks > Add webhook",
      `  URL:    ${webhookUrl}`,
      "  Events: Send me everything",
      "Save it, then copy the secret key Plane shows and paste it here.",
    ] }));

  // GitHub App: optional here. Usually added later in God mode > Git Sync.
  let github: { appId: string; webhookSecret: string } | undefined;
  const pemIn = join(SCRATCH, "github-app.pem");
  const appId = process.env.GITSYNC_GITHUB_APP_ID?.trim();
  if (appId) {
    if (!/^\d+$/.test(appId)) throw new InstallError("GitHub App ID must be a number");
    if (!existsSync(pemIn)) throw new InstallError("--github-app-id needs --github-private-key <file.pem>");
    const hook = checkValue("GitHub webhook secret", await obtain("GitHub App webhook secret", "GITSYNC_GITHUB_WEBHOOK_SECRET", "GITSYNC_GITHUB_WEBHOOK_SECRET", { secret: true }));
    github = { appId, webhookSecret: hook };
  }

  // git-sync.env
  const { text, values } = renderEnvFile(existingText, {
    postgresHost: facts.postgresHost, postgresPort: facts.postgresPort, redisUrl: facts.redisUrl,
    publicOrigin, apiRatePerMinute: facts.apiRatePerMinute, sessionCookieName: facts.sessionCookieName,
    planePat: pat, planeServiceUserId: user.id, planeWebhookSecret, github,
  });
  if (rerun) backup(envPath);
  writePrivate(envPath, text);
  step(`Wrote ${envPath.replace(PLANE, "<plane>")} (owner-only permissions); Plane API limit ${facts.apiRatePerMinute}/minute`);

  // State directory, key file and credential marker storage, owned by the container's node user.
  const dir = join(PLANE, "git-sync");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pem = join(dir, "github-app.pem");
  if (github) copyFileSync(pemIn, pem);
  else if (!existsSync(pem)) writeFileSync(pem, ""); // keeps Docker from creating a directory in its place
  chownSync(pem, NODE_UID, NODE_UID);
  chmodSync(pem, 0o400);
  const state = join(dir, "credential-state");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  chownSync(state, NODE_UID, NODE_UID);
  chmodSync(state, 0o700);

  // Database
  const password = dbPasswordFrom(values.get("DATABASE_URL"));
  if (!password) throw new InstallError("DATABASE_URL in git-sync.env has no password");
  try {
    const made = await ensureDatabase({ host: facts.postgresHost, port: facts.postgresPort, user: facts.postgresUser, password: facts.postgresPassword }, password);
    step(made.createdDatabase ? "Created the gitsync database on Plane's Postgres" : "gitsync database already exists (password re-synced)");
  } catch (err) {
    throw new InstallError(`Could not set up the gitsync database on ${facts.postgresHost}: ${(err as Error).message}`);
  }

  // Proxy route
  if (proxy === "plane") {
    const source = join(SCRATCH, "Caddyfile.plane");
    if (!existsSync(source)) throw new InstallError("Plane's proxy Caddyfile was not handed over; is the proxy service running?");
    writeFileSync(join(dir, "Caddyfile"), addGitSyncRoute(readFileSync(source, "utf8")), { mode: 0o644 });
    step("Routed /git-sync/* through Plane's proxy");
  }

  // Compose override
  const override = overridePath();
  const before = existsSync(override) ? readFileSync(override, "utf8") : "";
  const after = mergeOverride(before, { uiForks, proxy, gatewayNetwork });
  if (after !== before) {
    const saved = backup(override);
    writeFileSync(override, after);
    step(`Updated ${override.replace(PLANE, "<plane>")}${saved ? ` (backup: ${saved.replace(PLANE, "<plane>")})` : ""}`);
  } else step("Compose override already up to date");

  writeFileSync(join(SCRATCH, "result.env"), [
    `PUBLIC_ORIGIN=${publicOrigin}`, `PLANE_WEBHOOK_URL=${webhookUrl}`,
    `GITHUB_CONFIGURED=${values.has("GITHUB_APP_ID") ? "yes" : "no"}`, "",
  ].join("\n"));
}

// ---- uninstall -------------------------------------------------------------------------------------------

async function uninstall(flags: Map<string, string | true>) {
  const override = overridePath();
  if (existsSync(override)) {
    const before = readFileSync(override, "utf8");
    if (hasGitSync(before) || before.includes(PROXY_MOUNT) || Object.values(FORK_IMAGES).some((image) => before.includes(image))
      || /plane-(admin|frontend)-gitsync:/.test(before)) {
      const saved = backup(override);
      writeFileSync(override, removeOverride(before));
      step(`Removed git-sync from ${override.replace(PLANE, "<plane>")} (backup: ${saved!.replace(PLANE, "<plane>")})`);
    }
  }
  if (flags.get("purge") === true) {
    const db = parseEnvText(readFileSync(join(SCRATCH, "db.env"), "utf8"));
    const api = parseEnvText(readFileSync(join(SCRATCH, "api.env"), "utf8"));
    const facts = planeFacts(api, db);
    await dropDatabase({ host: facts.postgresHost, port: facts.postgresPort, user: facts.postgresUser, password: facts.postgresPassword });
    step("Dropped the gitsync database and role");
    for (const p of [join(PLANE, "git-sync.env"), join(PLANE, "git-sync")]) rmSync(p, { recursive: true, force: true });
    step("Deleted git-sync.env and the git-sync directory");
  } else {
    step("Kept the gitsync database, git-sync.env and git-sync/ (add --purge to delete them)");
  }
}

const [command, ...rest] = process.argv.slice(2);
const flags = args(rest);
try {
  if (command === "configure") await configure(flags);
  else if (command === "uninstall") await uninstall(flags);
  else throw new InstallError("usage: main.ts configure|uninstall [options]");
} catch (err) {
  process.stderr.write(`\nError: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(err instanceof InstallError ? 2 : 1);
}
