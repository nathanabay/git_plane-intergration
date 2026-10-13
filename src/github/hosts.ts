/** One GitHub App/edition per service instance. No network or credential access lives here. */
export type GithubEdition = "github" | "ghe_cloud" | "ghes";

export interface GithubHostInput {
  edition?: GithubEdition;
  gheSubdomain?: string | null;
  /** GHES web origin; the legacy origin/api/v3 form is also accepted. */
  gheBaseUrl?: string | null;
  /** Existing environment/stored API base URL, for compatible edition inference. */
  apiBaseUrl?: string | null;
}

export interface GithubHosts {
  edition: GithubEdition;
  apiBaseUrl: string;
  webOrigin: string;
  oauthAuthorizeUrl: string;
  oauthAccessTokenUrl: string;
}

function plainUrl(value: string, name: string, allowHttp = false): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an absolute URL`); }
  if ((url.protocol !== "https:" && !(allowHttp && url.protocol === "http:"))
    || url.username || url.password || url.search || url.hash || /[\u0000-\u0020\u007f\\]/.test(value)
    || !(allowHttp ? /^https?:\/\//i : /^https:\/\//i).test(value))
    throw new Error(`${name} must be a plain ${allowHttp ? "HTTP(S)" : "HTTPS"} URL without credentials, query or fragment`);
  return url;
}

// Context7 /websites/nodejs_latest-v24_x_api: WHATWG hostname excludes the port.
const isLoopback = (hostname: string): boolean => ["127.0.0.1", "[::1]", "localhost"].includes(hostname);

function githubUrl(value: string, name: string): URL {
  const url = plainUrl(value, name, true);
  if (url.protocol === "http:" && !isLoopback(url.hostname))
    throw new Error(`${name} must use HTTPS except for loopback hosts (127.0.0.1, ::1, localhost)`);
  return url;
}

function cloudSubdomain(value: string): string {
  const subdomain = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain))
    throw new Error("gheSubdomain must be a single DNS label, at most 63 characters");
  return subdomain;
}

function legacyHosts(value: string): { edition: GithubEdition; apiBaseUrl: string; webOrigin: string; subdomain?: string } {
  const url = githubUrl(value, "apiBaseUrl");
  const path = url.pathname.replace(/\/+$/, "");
  // A loopback API origin is the local GitHub.com stand-in used by wiring checks.
  if ((url.origin === "https://api.github.com" || isLoopback(url.hostname)) && path === "")
    return { edition: "github", apiBaseUrl: url.origin, webOrigin: "https://github.com" };
  const cloud = /^api\.([a-z0-9-]+)\.ghe\.com$/.exec(url.hostname);
  if (cloud && !url.port && path === "") {
    const subdomain = cloudSubdomain(cloud[1]!);
    return { edition: "ghe_cloud", apiBaseUrl: url.origin, webOrigin: `https://${subdomain}.ghe.com`, subdomain };
  }
  if (path !== "/api/v3") throw new Error("apiBaseUrl must be the GitHub.com/ghe.com API origin or a GHES origin/api/v3");
  return { edition: "ghes", apiBaseUrl: `${url.origin}/api/v3`, webOrigin: url.origin };
}

/** Context7 /websites/github_en: ghe.com data residency and GHES App URL requirements. */
export function deriveGithubHosts(input: GithubHostInput = {}): GithubHosts {
  const subdomainInput = input.gheSubdomain?.trim() || undefined;
  const serverInput = input.gheBaseUrl?.trim() || undefined;
  const legacy = input.apiBaseUrl?.trim() ? legacyHosts(input.apiBaseUrl.trim()) : undefined;
  const edition = input.edition ?? (subdomainInput ? "ghe_cloud" : serverInput ? "ghes" : legacy?.edition ?? "github");
  if (!["github", "ghe_cloud", "ghes"].includes(edition)) throw new Error("edition must be github, ghe_cloud or ghes");
  if (subdomainInput && edition !== "ghe_cloud") throw new Error("gheSubdomain requires the ghe_cloud edition");
  if (serverInput && edition !== "ghes") throw new Error("gheBaseUrl requires the ghes edition");

  let apiBaseUrl: string, webOrigin: string;
  if (edition === "github") {
    apiBaseUrl = legacy?.edition === "github" ? legacy.apiBaseUrl : "https://api.github.com";
    webOrigin = "https://github.com";
  } else if (edition === "ghe_cloud") {
    const candidate = subdomainInput ?? (legacy?.edition === "ghe_cloud" ? legacy.subdomain : undefined);
    if (!candidate) throw new Error("ghe_cloud requires gheSubdomain");
    const subdomain = cloudSubdomain(candidate);
    apiBaseUrl = `https://api.${subdomain}.ghe.com`;
    webOrigin = `https://${subdomain}.ghe.com`;
  } else {
    const candidate = serverInput ?? (legacy?.edition === "ghes" ? legacy.webOrigin : undefined);
    if (!candidate) throw new Error("ghes requires gheBaseUrl");
    const url = githubUrl(candidate, "gheBaseUrl");
    const path = url.pathname.replace(/\/+$/, "");
    if (path !== "" && path !== "/api/v3") throw new Error("gheBaseUrl must be a GHES web origin or origin/api/v3");
    if (["github.com", "api.github.com", "ghe.com"].includes(url.hostname) || url.hostname.endsWith(".ghe.com"))
      throw new Error("gheBaseUrl must identify a GitHub Enterprise Server, not a GitHub Cloud host");
    webOrigin = url.origin;
    apiBaseUrl = `${webOrigin}/api/v3`;
  }
  if (legacy && (legacy.edition !== edition || legacy.apiBaseUrl !== apiBaseUrl))
    throw new Error("apiBaseUrl conflicts with the selected GitHub edition/host");
  return { edition, apiBaseUrl, webOrigin,
    oauthAuthorizeUrl: `${webOrigin}/login/oauth/authorize`,
    oauthAccessTokenUrl: `${webOrigin}/login/oauth/access_token`,
  };
}

/** State is supplied by the install flow; this pure builder neither signs nor verifies it. */
export function githubAppInstallUrl(hosts: Pick<GithubHosts, "webOrigin">, appSlug: string, state?: string): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(appSlug)) throw new Error("appSlug must be a single GitHub App slug");
  const url = new URL(`/apps/${appSlug}/installations/new`, hosts.webOrigin);
  if (state !== undefined) url.searchParams.set("state", state);
  return url.toString();
}

/** These callbacks belong to the sync service, independently of the selected GitHub edition. */
export function githubServiceUrls(publicOrigin: string): { oauthCallbackUrl: string; installCallbackUrl: string; webhookUrl: string } {
  const url = plainUrl(publicOrigin.trim(), "PUBLIC_ORIGIN", true);
  if (url.pathname.replace(/\/+$/, "") !== "") throw new Error("PUBLIC_ORIGIN must be an origin without a path");
  return {
    oauthCallbackUrl: `${url.origin}/git-sync/oauth/github/callback`,
    installCallbackUrl: `${url.origin}/git-sync/install/github/callback`,
    webhookUrl: `${url.origin}/git-sync/webhooks/github`,
  };
}
