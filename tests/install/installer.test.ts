// Installer building blocks: Plane facts, git-sync.env rendering, compose override merge/removal, Caddyfile route,
// and the Plane API key lookup.
import test from "node:test";
import { deepStrictEqual, doesNotMatch, match, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { parseEnvText, planeFacts, ratePerMinute } from "../../src/install/plane-env.ts";
import { dbPasswordFrom, renderEnvFile } from "../../src/install/env-file.ts";
import type { EnvInputs } from "../../src/install/env-file.ts";
import { FORK_IMAGES, PROXY_MOUNT, hasGitSync, mergeOverride, removeOverride } from "../../src/install/compose.ts";
import { GITSYNC_ROUTE, addGitSyncRoute } from "../../src/install/caddy.ts";
import { planeUserForKey } from "../../src/install/plane-api.ts";
import { loadConfig } from "../../src/config/env.ts";

// ---- Plane facts ------------------------------------------------------------------------------------------

test("parseEnvText reads docker inspect output and env files, keeping '=' inside values", () => {
  const env = parseEnvText("PATH=/usr/bin\n# comment\n\nDATABASE_URL=postgres://u:p@h/db?x=1\nQUOTED=\"a b\"\nexport E=1\nbad line\n1X=no\n");
  strictEqual(env.get("DATABASE_URL"), "postgres://u:p@h/db?x=1");
  strictEqual(env.get("QUOTED"), "a b");
  strictEqual(env.get("E"), "1");
  strictEqual(env.has("1X"), false);
  strictEqual(env.size, 4);
});

test("ratePerMinute converts Plane's DRF rates and defaults to 60", () => {
  strictEqual(ratePerMinute(undefined), 60);
  strictEqual(ratePerMinute("60/minute"), 60);
  strictEqual(ratePerMinute("600/min"), 600);
  strictEqual(ratePerMinute("2/second"), 120);
  strictEqual(ratePerMinute("3000/hour"), 50);
  strictEqual(ratePerMinute("10/hour"), 1);
  strictEqual(ratePerMinute("2880/day"), 2);
  throws(() => ratePerMinute("lots"), /not of the form/);
  throws(() => ratePerMinute("5/fortnight"), /unknown period/);
});

test("planeFacts takes Postgres credentials from plane-db and site settings from api", () => {
  const api = parseEnvText("WEB_URL=https://tasks.example.com/\nAPI_KEY_RATE_LIMIT=600/minute\nREDIS_URL=redis://plane-redis:6379/\nPGHOST=plane-db\n");
  const db = parseEnvText("POSTGRES_USER=planeadmin\nPOSTGRES_PASSWORD=s3cret\n");
  deepStrictEqual(planeFacts(api, db), {
    postgresUser: "planeadmin", postgresPassword: "s3cret", postgresHost: "plane-db", postgresPort: 5432,
    redisUrl: "redis://plane-redis:6379/", publicOrigin: "https://tasks.example.com", apiRatePerMinute: 600, sessionCookieName: "session-id",
  });
});

test("planeFacts falls back to APP_DOMAIN, default Redis and default user; requires a password", () => {
  const f = planeFacts(parseEnvText("APP_DOMAIN=plane.example.org\nSESSION_COOKIE_NAME=sid\n"), parseEnvText("POSTGRES_PASSWORD=x\n"));
  strictEqual(f.publicOrigin, "https://plane.example.org");
  strictEqual(f.redisUrl, "redis://plane-redis:6379");
  strictEqual(f.postgresUser, "plane");
  strictEqual(f.sessionCookieName, "sid");
  strictEqual(planeFacts(parseEnvText("APP_DOMAIN=localhost\n"), parseEnvText("POSTGRES_PASSWORD=x\n")).publicOrigin, "");
  throws(() => planeFacts(new Map(), new Map()), /POSTGRES_PASSWORD/);
});

// ---- git-sync.env -----------------------------------------------------------------------------------------

const inputs: EnvInputs = {
  postgresHost: "plane-db", postgresPort: 5432, redisUrl: "redis://plane-redis:6379", publicOrigin: "https://tasks.example.com",
  apiRatePerMinute: 60, sessionCookieName: "session-id", planePat: "plane_api_abc", planeServiceUserId: "user-1", planeWebhookSecret: "plane_wh_x",
};

test("a fresh git-sync.env has every value the service requires, and the service accepts it", () => {
  const { text, values } = renderEnvFile("", inputs);
  const env = Object.fromEntries(parseEnvText(text));
  const config = loadConfig(env);
  strictEqual(config.PLANE_SERVICE_USER_ID, "user-1");
  strictEqual(config.PUBLIC_ORIGIN, "https://tasks.example.com");
  strictEqual(config.GITHUB_APP_ID, "");
  match(values.get("DATABASE_URL")!, /^postgres:\/\/gitsync:[0-9a-f]{48}@plane-db:5432\/gitsync$/);
  strictEqual(Buffer.from(values.get("GITSYNC_TOKEN_KEY")!, "base64").length, 32);
  strictEqual(values.get("PLANE_BASE_URL"), "http://api:8000");
});

test("generated secrets differ between installs", () => {
  const a = renderEnvFile("", inputs).values, b = renderEnvFile("", inputs).values;
  ok(a.get("GITSYNC_TOKEN_KEY") !== b.get("GITSYNC_TOKEN_KEY"));
  ok(a.get("DATABASE_URL") !== b.get("DATABASE_URL"));
});

test("a re-run keeps the token key, database password and hand-added settings", () => {
  const first = renderEnvFile("", inputs).text + "\nREQUIRE_VERIFIED_COMMITS=true\n";
  const second = renderEnvFile(first, { ...inputs, planePat: undefined, planeWebhookSecret: undefined, planeServiceUserId: undefined });
  const a = parseEnvText(first), b = second.values;
  for (const k of ["GITSYNC_TOKEN_KEY", "DATABASE_URL", "PLANE_SERVICE_PAT", "PLANE_WEBHOOK_SECRET", "PLANE_SERVICE_USER_ID"]) strictEqual(b.get(k), a.get(k), k);
  strictEqual(b.get("REQUIRE_VERIFIED_COMMITS"), "true");
  match(second.text, /# Other settings \(kept from the previous file\)\nREQUIRE_VERIFIED_COMMITS=true/);
  strictEqual(renderEnvFile(second.text, inputs).text, renderEnvFile(second.text, inputs).text, "stable on repeat");
});

test("a re-run takes new answers and follows Plane's rate limit", () => {
  const first = renderEnvFile("", inputs).text;
  const second = renderEnvFile(first, { ...inputs, planePat: "plane_api_new", apiRatePerMinute: 600 }).values;
  strictEqual(second.get("PLANE_SERVICE_PAT"), "plane_api_new");
  strictEqual(second.get("PLANE_API_RATE_PER_MINUTE"), "600");
});

test("a GitHub App given at install time fills all three bootstrap values; otherwise none", () => {
  const withApp = renderEnvFile("", { ...inputs, github: { appId: "123", webhookSecret: "gh" } }).values;
  deepStrictEqual([withApp.get("GITHUB_APP_ID"), withApp.get("GITHUB_PRIVATE_KEY_PATH"), withApp.get("GITHUB_WEBHOOK_SECRET")], ["123", "/run/secrets/github-app.pem", "gh"]);
  const without = renderEnvFile("", inputs);
  strictEqual(without.values.has("GITHUB_APP_ID"), false);
  match(without.text, /# GitHub App \(optional here[^\n]*\n# \(not set\)/);
  // A previously configured App survives a re-run that does not mention it.
  strictEqual(renderEnvFile(renderEnvFile("", { ...inputs, github: { appId: "9", webhookSecret: "s" } }).text, inputs).values.get("GITHUB_APP_ID"), "9");
});

test("dbPasswordFrom decodes the password and ignores junk", () => {
  strictEqual(dbPasswordFrom("postgres://gitsync:a%2Fb@plane-db:5432/gitsync"), "a/b");
  strictEqual(dbPasswordFrom("not a url"), undefined);
  strictEqual(dbPasswordFrom(undefined), undefined);
});

// ---- compose override ---------------------------------------------------------------------------------------

const operatorOverride = `# my notes
services:
  proxy:
    ports: !override
      - "8443:443"
  extra:
    image: busybox
    command: [sleep, "1"]
`;

test("merge adds git-sync to an empty or missing override", () => {
  for (const before of ["", "\n"]) {
    const out = parse(mergeOverride(before, { uiForks: false, proxy: "plane" }));
    strictEqual(out.services["git-sync"].image, "${GITSYNC_IMAGE:-git-sync:local}");
    deepStrictEqual(out.services["git-sync"].env_file, ["git-sync.env"]);
    deepStrictEqual(out.services.proxy.volumes, [PROXY_MOUNT]);
    strictEqual(out.networks, undefined);
  }
});

test("merge keeps the operator's services, comments and Compose !override tags", () => {
  const merged = mergeOverride(operatorOverride, { uiForks: false, proxy: "plane" });
  match(merged, /^# my notes/);
  match(merged, /!override/);
  match(merged, /# Added by git-sync install\.sh/);
  const out = parse(merged, { customTags: [{ tag: "!override", collection: "seq", resolve: (v: unknown) => v }] });
  deepStrictEqual(out.services.extra, { image: "busybox", command: ["sleep", "1"] });
  deepStrictEqual(out.services.proxy.ports, ["8443:443"]);
  deepStrictEqual(out.services.proxy.volumes, [PROXY_MOUNT]);
});

test("merge refreshes an existing git-sync entry but keeps what the operator added", () => {
  const before = `services:
  git-sync:
    image: git-sync:old
    env_file: [old.env]
    labels: [team=ops]
    networks:
      default:
        aliases: [sink.gitsync.test]
`;
  const out = parse(mergeOverride(before, { uiForks: false, proxy: "plane" })).services["git-sync"];
  strictEqual(out.image, "${GITSYNC_IMAGE:-git-sync:local}");
  deepStrictEqual(out.env_file, ["git-sync.env"]);
  deepStrictEqual(out.labels, ["team=ops"]);
  deepStrictEqual(out.networks, { default: { aliases: ["sink.gitsync.test"] } });
  const gw = parse(mergeOverride(before, { uiForks: false, proxy: "external", gatewayNetwork: "gateway" })).services["git-sync"];
  deepStrictEqual(gw.networks, { default: { aliases: ["sink.gitsync.test"] }, gateway: { aliases: ["git-sync"] } });
});

test("merge is idempotent", () => {
  const once = mergeOverride(operatorOverride, { uiForks: true, proxy: "plane" });
  strictEqual(mergeOverride(once, { uiForks: true, proxy: "plane" }), once);
});

test("merge with UI forks sets the admin and web images, and refuses to replace someone else's image", () => {
  const out = parse(mergeOverride("", { uiForks: true, proxy: "plane" }));
  strictEqual(out.services.admin.image, FORK_IMAGES.admin);
  strictEqual(out.services.web.image, FORK_IMAGES.web);
  throws(() => mergeOverride("services:\n  web:\n    image: mycorp/plane-web:1\n", { uiForks: true, proxy: "plane" }), /already sets services\.web\.image/);
});

test("merge refuses a proxy that already mounts its own Caddyfile", () => {
  throws(() => mergeOverride("services:\n  proxy:\n    volumes:\n      - ./mine:/etc/caddy/Caddyfile:ro\n", { uiForks: false, proxy: "plane" }), /--proxy external/);
});

test("external proxy mode joins the gateway network and leaves Plane's proxy alone", () => {
  const out = parse(mergeOverride("", { uiForks: false, proxy: "external", gatewayNetwork: "gateway" }));
  deepStrictEqual(out.services["git-sync"].networks, { default: {}, gateway: { aliases: ["git-sync"] } });
  deepStrictEqual(out.networks, { gateway: { external: true } });
  strictEqual(out.services.proxy, undefined);
});

test("the git-sync service matches the reference compose fragment shipped in the repository", () => {
  const reference = parse(readFileSync(new URL("../../docker-compose.override.yaml", import.meta.url), "utf8")).services["git-sync"];
  const ours = parse(mergeOverride("", { uiForks: false, proxy: "external", gatewayNetwork: "gateway" })).services["git-sync"];
  for (const k of ["image", "restart", "depends_on", "environment", "volumes", "networks"]) deepStrictEqual(ours[k], reference[k], k);
  deepStrictEqual(ours.healthcheck.test.slice(0, 3), reference.healthcheck.test.slice(0, 3));
});

test("remove takes out exactly what merge added", () => {
  for (const opts of [{ uiForks: true, proxy: "plane" as const }, { uiForks: false, proxy: "external" as const, gatewayNetwork: "gateway" }]) {
    const merged = mergeOverride(operatorOverride, opts);
    ok(hasGitSync(merged));
    const removed = removeOverride(merged);
    strictEqual(hasGitSync(removed), false);
    deepStrictEqual(parse(removed, { customTags: [{ tag: "!override", collection: "seq", resolve: (v: unknown) => v }] }),
      parse(operatorOverride, { customTags: [{ tag: "!override", collection: "seq", resolve: (v: unknown) => v }] }));
    doesNotMatch(removed, /git-sync/);
  }
});

test("remove also takes out Git Sync UI images written by hand from the runbook", () => {
  const removed = parse(removeOverride("services:\n  admin:\n    image: plane-admin-gitsync:v1.4.2\n  web:\n    image: plane-frontend-gitsync:v1.4.2\n  api:\n    image: mine:1\n"));
  deepStrictEqual(removed.services, { api: { image: "mine:1" } });
});

test("remove keeps a gateway network that another service still uses", () => {
  const before = "services:\n  proxy:\n    networks: [gateway]\nnetworks:\n  gateway:\n    external: true\n";
  const removed = parse(removeOverride(mergeOverride(before, { uiForks: false, proxy: "external", gatewayNetwork: "gateway" })));
  deepStrictEqual(removed.networks, { gateway: { external: true } });
});

test("invalid override YAML is reported, not overwritten", () => {
  throws(() => mergeOverride("services: [\n", { uiForks: false, proxy: "plane" }), /not valid YAML/);
  throws(() => mergeOverride("- a\n- b\n", { uiForks: false, proxy: "plane" }), /mapping at the top level/);
});

// ---- Caddyfile ----------------------------------------------------------------------------------------------

const planeCaddy = `(plane_proxy) {
\treverse_proxy /api/* api:8000

\treverse_proxy /* web:3000
}

{$SITE_ADDRESS} {
\timport plane_proxy
}`;

test("the git-sync route goes before Plane's catch-all, with the same indentation, once", () => {
  const out = addGitSyncRoute(planeCaddy);
  const lines = out.split("\n");
  const route = lines.indexOf(`\t${GITSYNC_ROUTE}`), catchAll = lines.indexOf("\treverse_proxy /* web:3000");
  ok(route > 0 && route < catchAll, out);
  strictEqual(addGitSyncRoute(out), out);
});

test("the route is added to the Caddyfile of the real Plane v1.4.2 proxy image", () => {
  const real = readFileSync(new URL("./fixtures/plane-proxy-v1.4.2.Caddyfile", import.meta.url), "utf8");
  const out = addGitSyncRoute(real);
  ok(out.indexOf(GITSYNC_ROUTE) < out.indexOf("reverse_proxy /* web:3000"));
  strictEqual(out.split(GITSYNC_ROUTE).length, 2);
});

test("a Caddyfile without Plane's catch-all is refused", () => {
  throws(() => addGitSyncRoute(":80 {\n  respond ok\n}\n"), /--proxy external/);
});

// ---- Plane API key lookup -----------------------------------------------------------------------------------

const fakeFetch = (status: number, body: unknown, seen: { url?: string; key?: string } = {}) =>
  (async (url: string, init: RequestInit) => {
    seen.url = url; seen.key = (init.headers as Record<string, string>)["X-API-Key"];
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;

test("planeUserForKey returns the key's user from /api/v1/users/me/", async () => {
  const seen: { url?: string; key?: string } = {};
  const user = await planeUserForKey("http://api:8000/", "k1", fakeFetch(200, { id: "u-1", email: "bot@x", display_name: "bot" }, seen));
  deepStrictEqual(user, { id: "u-1", email: "bot@x", displayName: "bot" });
  strictEqual(seen.url, "http://api:8000/api/v1/users/me/");
  strictEqual(seen.key, "k1");
});

test("planeUserForKey explains a rejected key, an error status, a bad body and an unreachable Plane", async () => {
  await rejects(planeUserForKey("http://api:8000", "bad", fakeFetch(403, { detail: "no" })), /rejected the API key/);
  await rejects(planeUserForKey("http://api:8000", "k", fakeFetch(500, {})), /answered 500/);
  await rejects(planeUserForKey("http://api:8000", "k", fakeFetch(200, { email: "x" })), /did not return a user id/);
  await rejects(planeUserForKey("http://api:8000", "k", (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch), /Could not reach Plane's API at http:\/\/api:8000: fetch failed/);
});
