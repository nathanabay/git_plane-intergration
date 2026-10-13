// The GitHub App as the composed service uses it: installation clients for writes, and the installation
// lookup a mapped repository needs before anything can be written to it. Credentials come from a source
// (database first, environment as fallback, see credentials.ts) and the App is rebuilt when they change.
import type { Db } from "../db/migrate.ts";
import { withGithubRateLimits } from "../github/errors.ts";
import { App } from "@octokit/app";
import { Octokit } from "@octokit/core";
import type { CredentialSource, GithubCredentials } from "./credentials.ts";
import { deriveGithubHosts } from "../github/hosts.ts";
import type { GithubHosts } from "../github/hosts.ts";

export interface GithubClient {
  installationOctokit(installationId: number): Promise<any>;
  /** The installation serving a repository, found through the App's own (JWT) identity. */
  installationIdFor(owner: string, repo: string): Promise<number>;
  /** Public profile reads without App JWT/installation authentication, on the configured API host. */
  publicRequest?(route: string, params: Record<string, unknown>): Promise<{ data: any }>;
  /** Discard cached installation tokens after installation/permission lifecycle changes. */
  invalidateInstallation?(installationId: number): void;
  /** A request made as the App itself (JWT), only for App endpoints. */
  appRequest?(route: string, params: Record<string, unknown>): Promise<{ data: any }>;
  /** The browser/OAuth host follows the same active credential authority as every API request. */
  hosts?(): Promise<GithubHosts>;
}

const apiBase = (c: GithubCredentials) => c.hosts?.apiBaseUrl ?? c.baseUrl ?? "https://api.github.com";
const fingerprint = (c: GithubCredentials) => `${c.appId}\n${apiBase(c)}\n${c.hosts?.edition ?? ""}\n${c.hosts?.webOrigin ?? ""}\n${c.privateKey}`;

/** The private key is read on first use, so a service with no GitHub installation still starts. */
export function createGithubClient(credentials: CredentialSource, db?: Db, opts: { fetch?: typeof fetch } = {}): GithubClient {
  let current: { key: string; app: App } | undefined;
  const load = async (): Promise<App> => {
    const creds = await credentials.load();
    const key = fingerprint(creds);
    if (current?.key === key) return current.app;
    const appOpts: ConstructorParameters<typeof App>[0] = { appId: creds.appId, privateKey: creds.privateKey };
    (appOpts as { Octokit?: unknown }).Octokit = Octokit.defaults({ baseUrl: apiBase(creds),
      ...(opts.fetch ? { request: { fetch: opts.fetch } } : {}) });
    current = { key, app: new App(appOpts) };
    return current.app;
  };
  return {
    async hosts() {
      const creds = await credentials.load();
      return creds.hosts ?? deriveGithubHosts({ apiBaseUrl: creds.baseUrl });
    },
    invalidateInstallation() { current = undefined; },
    async publicRequest(route: string, params: Record<string, unknown>) {
      const creds = await credentials.load();
      const client = withGithubRateLimits(new Octokit({ baseUrl: apiBase(creds),
        ...(opts.fetch ? { request: { fetch: opts.fetch } } : {}) }),
        { key: `public:${apiBase(creds)}`, db });
      return client.request(route, params) as Promise<{ data: any }>;
    },
    async installationOctokit(installationId: number) {
      return withGithubRateLimits(await (await load()).getInstallationOctokit(installationId),
        { key: `installation:${installationId}`, db });
    },
    async appRequest(route: string, params: Record<string, unknown>): Promise<{ data: any }> {
      return withGithubRateLimits((await load()).octokit, { key: "app", db }).request(route, params) as Promise<{ data: any }>;
    },
    async installationIdFor(owner: string, repo: string) {
      const res = await withGithubRateLimits((await load()).octokit, { key: "app", db }).request("GET /repos/{owner}/{repo}/installation", { owner, repo });
      if ((res as { data?: { suspended_at?: unknown } }).data?.suspended_at)
        throw Object.assign(new Error(`GitHub installation for ${owner}/${repo} is suspended`), { status: 403 });
      const id = Number((res as { data?: { id?: unknown } }).data?.id);
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`GitHub reported no installation for ${owner}/${repo}`);
      return id;
    },
  };
}
