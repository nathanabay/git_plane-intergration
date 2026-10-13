import test from "node:test";
import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { deriveGithubHosts, githubAppInstallUrl, githubServiceUrls } from "../../src/github/hosts.ts";
import type { GithubEdition, GithubHostInput } from "../../src/github/hosts.ts";
import { loadConfig } from "../../src/config/env.ts";

const env = {
  DATABASE_URL: "postgres://db", REDIS_URL: "redis://cache", PLANE_BASE_URL: "http://plane",
  PLANE_SERVICE_PAT: "plane-pat", PLANE_SERVICE_USER_ID: "service", PLANE_WEBHOOK_SECRET: "plane-hook",
  GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY_PATH: "/app.pem", GITHUB_WEBHOOK_SECRET: "github-hook", GITSYNC_TOKEN_KEY: "key",
};

test("C8: GitHub.com defaults keep API and browser/OAuth origins distinct", () => {
  deepStrictEqual(deriveGithubHosts(), {
    edition: "github", apiBaseUrl: "https://api.github.com", webOrigin: "https://github.com",
    oauthAuthorizeUrl: "https://github.com/login/oauth/authorize",
    oauthAccessTokenUrl: "https://github.com/login/oauth/access_token",
  });
});

test("C8: Enterprise Cloud normalizes its subdomain and never appends the GHES API prefix", () => {
  deepStrictEqual(deriveGithubHosts({ edition: "ghe_cloud", gheSubdomain: " Octo-Corp " }), {
    edition: "ghe_cloud", apiBaseUrl: "https://api.octo-corp.ghe.com", webOrigin: "https://octo-corp.ghe.com",
    oauthAuthorizeUrl: "https://octo-corp.ghe.com/login/oauth/authorize",
    oauthAccessTokenUrl: "https://octo-corp.ghe.com/login/oauth/access_token",
  });
});

test("C8: GHES normalizes trailing slashes and preserves ports without doubling api/v3", () => {
  for (const base of ["https://GHE.example:8443/", "https://ghe.example:8443/api/v3///"]) {
    deepStrictEqual(deriveGithubHosts({ edition: "ghes", gheBaseUrl: base }), {
      edition: "ghes", apiBaseUrl: "https://ghe.example:8443/api/v3", webOrigin: "https://ghe.example:8443",
      oauthAuthorizeUrl: "https://ghe.example:8443/login/oauth/authorize",
      oauthAccessTokenUrl: "https://ghe.example:8443/login/oauth/access_token",
    });
  }
});

test("C8: legacy API URLs infer the correct edition and browser host", () => {
  for (const [api, edition, web] of [
    ["https://api.github.com/", "github", "https://github.com"],
    ["https://api.octocorp.ghe.com/", "ghe_cloud", "https://octocorp.ghe.com"],
    ["https://ghe.example:8443/api/v3/", "ghes", "https://ghe.example:8443"],
  ] as const) {
    const hosts = deriveGithubHosts({ apiBaseUrl: api });
    strictEqual(hosts.edition, edition);
    strictEqual(hosts.webOrigin, web);
    strictEqual(hosts.apiBaseUrl, api.replace(/\/+$/, ""));
  }
  strictEqual(deriveGithubHosts({ gheSubdomain: "corp" }).edition, "ghe_cloud");
  strictEqual(deriveGithubHosts({ gheBaseUrl: "https://ghe.example" }).edition, "ghes");
});

test("C8: loopback HTTP API overrides bootstrap the local GitHub fake without changing browser origins", () => {
  for (const host of ["127.0.0.1", "[::1]", "localhost"]) {
    const api = `http://${host}:4567`;
    const expected = { ...deriveGithubHosts(), apiBaseUrl: api };
    deepStrictEqual(deriveGithubHosts({ apiBaseUrl: `${api}/` }), expected);
    deepStrictEqual(deriveGithubHosts({ edition: "github", apiBaseUrl: api }), expected);
    const config = loadConfig({ ...env, GITHUB_API_BASE_URL: `${api}/` });
    strictEqual(config.GITHUB_EDITION, "github");
    strictEqual(config.GITHUB_API_BASE_URL, api);
    strictEqual(config.GITHUB_WEB_ORIGIN, "https://github.com");
  }
});

test("C8: local GHES HTTP keeps its API prefix and loopback browser origin", () => {
  for (const host of ["127.0.0.1", "[::1]", "localhost"]) {
    const web = `http://${host}:4567`;
    const expected = {
      edition: "ghes", apiBaseUrl: `${web}/api/v3`, webOrigin: web,
      oauthAuthorizeUrl: `${web}/login/oauth/authorize`, oauthAccessTokenUrl: `${web}/login/oauth/access_token`,
    };
    deepStrictEqual(deriveGithubHosts({ apiBaseUrl: `${web}/api/v3/` }), expected);
    deepStrictEqual(deriveGithubHosts({ edition: "ghes", gheBaseUrl: web, apiBaseUrl: `${web}/api/v3` }), expected);
  }
});

test("C8: HTTP GitHub hosts reject non-loopback and lookalike addresses and retain plain-URL checks", () => {
  for (const host of ["ghe.example", "api.github.com", "api.corp.ghe.com", "127.0.0.2", "0.0.0.0", "[::]",
    "[::ffff:127.0.0.1]", "localhost.example", "127.0.0.1.example", "localhost."]) {
    throws(() => deriveGithubHosts({ apiBaseUrl: `http://${host}:4567/api/v3` }), /HTTPS/, host);
    throws(() => deriveGithubHosts({ edition: "ghes", gheBaseUrl: `http://${host}:4567` }), /HTTPS/, host);
  }
  for (const apiBaseUrl of ["http://u:p@localhost:4567", "http://localhost:4567?x=1", "http://localhost:4567#fragment",
    "http:localhost:4567", "ftp://localhost:4567", "http://localhost:4567/suffix"])
    throws(() => deriveGithubHosts({ apiBaseUrl }), Error, apiBaseUrl);
  throws(() => deriveGithubHosts({ edition: "ghe_cloud", gheSubdomain: "corp", apiBaseUrl: "http://localhost:4567" }), /conflicts/);
});

test("C8: malformed and conflicting edition/host inputs fail closed", () => {
  const invalid: GithubHostInput[] = [
    { edition: "unknown" as GithubEdition }, { edition: "ghe_cloud" }, { edition: "ghes" },
    { edition: "github", gheSubdomain: "corp" }, { edition: "ghe_cloud", gheBaseUrl: "https://ghe.example" },
    { gheSubdomain: "corp", gheBaseUrl: "https://ghe.example" },
    { edition: "github", apiBaseUrl: "https://ghe.example/api/v3" },
    { edition: "ghe_cloud", gheSubdomain: "one", apiBaseUrl: "https://api.two.ghe.com" },
    { edition: "ghes", gheBaseUrl: "https://one.example", apiBaseUrl: "https://two.example/api/v3" },
    ...["-corp", "corp-", "corp.ghe.com", "corp/evil", "corp?x", "a".repeat(64)].map((gheSubdomain) => ({ edition: "ghe_cloud" as const, gheSubdomain })),
    ...["/relative", "https:ghe.example", "https://ghe.example\\suffix", "http://ghe.example", "ftp://ghe.example", "https://u:p@ghe.example", "https://ghe.example?x=1",
      "https://ghe.example#part", "https://ghe.example/suffix", "https://github.com", "https://corp.ghe.com"].map((gheBaseUrl) => ({ edition: "ghes" as const, gheBaseUrl })),
    { apiBaseUrl: "https://ghe.example" }, { apiBaseUrl: "https://api.corp.ghe.com/api/v3" },
    { apiBaseUrl: "https://ghe.example/api/v4" },
  ];
  for (const input of invalid) throws(() => deriveGithubHosts(input), Error, JSON.stringify(input));
});

test("C8: compatible explicit and legacy host selections agree", () => {
  strictEqual(deriveGithubHosts({ edition: "ghe_cloud", gheSubdomain: "CORP", apiBaseUrl: "https://api.corp.ghe.com/" }).webOrigin,
    "https://corp.ghe.com");
  strictEqual(deriveGithubHosts({ edition: "ghes", gheBaseUrl: "https://ghe.example/", apiBaseUrl: "https://ghe.example/api/v3/" }).apiBaseUrl,
    "https://ghe.example/api/v3");
});

test("C8: installation and OAuth URLs use the selected web host for every edition", () => {
  const inputs: GithubHostInput[] = [{}, { edition: "ghe_cloud", gheSubdomain: "corp" }, { edition: "ghes", gheBaseUrl: "https://ghe.example:8443" }];
  const state = "opaque+token&return=/safe?x=1#part";
  for (const input of inputs) {
    const hosts = deriveGithubHosts(input);
    const url = new URL(githubAppInstallUrl(hosts, "plane-sync", state));
    strictEqual(url.origin, hosts.webOrigin);
    strictEqual(url.pathname, "/apps/plane-sync/installations/new");
    strictEqual(url.searchParams.get("state"), state);
    strictEqual(url.searchParams.size, 1);
    strictEqual(url.hash, "");
    strictEqual(githubAppInstallUrl(hosts, "plane-sync"), `${hosts.webOrigin}/apps/plane-sync/installations/new`);
    strictEqual(new URL(hosts.oauthAuthorizeUrl).origin, hosts.webOrigin);
    strictEqual(new URL(hosts.oauthAccessTokenUrl).origin, hosts.webOrigin);
  }
  for (const slug of ["", "../other", "evil/name", "app?state=forged", "app#fragment", "app name"])
    throws(() => githubAppInstallUrl(deriveGithubHosts(), slug), /appSlug/);
});

test("C0/N7: OAuth, installation callbacks and webhook stay on the sync service origin", () => {
  deepStrictEqual(githubServiceUrls("https://tasks.example:8443/"), {
    oauthCallbackUrl: "https://tasks.example:8443/git-sync/oauth/github/callback",
    installCallbackUrl: "https://tasks.example:8443/git-sync/install/github/callback",
    webhookUrl: "https://tasks.example:8443/git-sync/webhooks/github",
  });
  strictEqual(githubServiceUrls("http://localhost:3100").oauthCallbackUrl, "http://localhost:3100/git-sync/oauth/github/callback");
  for (const origin of ["https://tasks.example/subpath", "https://u:p@tasks.example", "https://tasks.example?query", "https://tasks.example#fragment"])
    throws(() => githubServiceUrls(origin), /PUBLIC_ORIGIN/);
});

test("C8/C0: environment defaults and optional OAuth bootstrap preserve existing startup", () => {
  const defaults = loadConfig(env);
  strictEqual(defaults.GITHUB_EDITION, "github");
  strictEqual(defaults.GITHUB_WEB_ORIGIN, "https://github.com");
  strictEqual(defaults.GITHUB_API_BASE_URL, undefined);
  strictEqual(defaults.GITHUB_CLIENT_ID, undefined);
  strictEqual(defaults.GITHUB_CLIENT_SECRET, undefined);
  const oauth = loadConfig({ ...env, GITHUB_CLIENT_ID: " client-id ", GITHUB_CLIENT_SECRET: "secret", GITHUB_APP_SLUG: "plane-sync" });
  strictEqual(oauth.GITHUB_CLIENT_ID, "client-id");
  strictEqual(oauth.GITHUB_CLIENT_SECRET, "secret");
  strictEqual(oauth.GITHUB_APP_SLUG, "plane-sync");
});

test("C8: environment bootstraps each Enterprise edition and legacy API-only deployments", () => {
  const cloud = loadConfig({ ...env, GITHUB_EDITION: "ghe_cloud", GITHUB_GHE_SUBDOMAIN: " CORP " });
  strictEqual(cloud.GITHUB_API_BASE_URL, "https://api.corp.ghe.com");
  strictEqual(cloud.GITHUB_WEB_ORIGIN, "https://corp.ghe.com");
  strictEqual(cloud.GITHUB_GHE_SUBDOMAIN, "corp");
  const server = loadConfig({ ...env, GITHUB_EDITION: "ghes", GITHUB_GHES_BASE_URL: "https://ghe.example:8443/" });
  strictEqual(server.GITHUB_API_BASE_URL, "https://ghe.example:8443/api/v3");
  strictEqual(server.GITHUB_WEB_ORIGIN, "https://ghe.example:8443");
  strictEqual(server.GITHUB_GHES_BASE_URL, server.GITHUB_WEB_ORIGIN);
  const legacy = loadConfig({ ...env, GITHUB_API_BASE_URL: "https://ghe.example/api/v3/" });
  strictEqual(legacy.GITHUB_EDITION, "ghes");
  strictEqual(legacy.GITHUB_API_BASE_URL, "https://ghe.example/api/v3");
  const legacyCloud = loadConfig({ ...env, GITHUB_EDITION: "", GITHUB_API_BASE_URL: "https://api.corp.ghe.com" });
  strictEqual(legacyCloud.GITHUB_EDITION, "ghe_cloud");
  strictEqual(legacyCloud.GITHUB_GHE_SUBDOMAIN, "corp");
});

test("C8/C0: invalid bootstrap fails at startup without logging credentials", () => {
  const originalExit = process.exit, originalError = console.error;
  const messages: string[] = [];
  process.exit = ((code?: number) => { throw new Error(`exit ${code}`); }) as typeof process.exit;
  console.error = (message) => { messages.push(String(message)); };
  try {
    for (const extra of [
      { GITHUB_EDITION: "unknown" }, { GITHUB_EDITION: "ghe_cloud" }, { GITHUB_EDITION: "ghes" },
      { GITHUB_EDITION: "github", GITHUB_API_BASE_URL: "https://ghe.example/api/v3" },
      { GITHUB_CLIENT_ID: "client-id" }, { GITHUB_CLIENT_SECRET: "super-secret" },
      { GITHUB_GHES_BASE_URL: "https://user:super-secret@ghe.example" }, { GITHUB_APP_SLUG: "../forged" },
    ]) throws(() => loadConfig({ ...env, ...extra }), /exit 1/);
  } finally { process.exit = originalExit; console.error = originalError; }
  strictEqual(messages.length, 8);
  strictEqual(messages.some((message) => message.includes("super-secret")), false);
});
