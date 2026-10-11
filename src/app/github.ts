// The GitHub App as the composed service uses it: installation clients for writes, and the installation
// lookup a mapped repository needs before anything can be written to it. Credentials come from a source
// (database first, environment as fallback, see credentials.ts) and the App is rebuilt when they change.
import { App } from "@octokit/app";
import { Octokit } from "@octokit/core";
import type { CredentialSource, GithubCredentials } from "./credentials.ts";

export interface GithubClient {
  installationOctokit(installationId: number): Promise<any>;
  /** The installation serving a repository, found through the App's own (JWT) identity. */
  installationIdFor(owner: string, repo: string): Promise<number>;
  /** A request made as the App itself (JWT): for public data such as `GET /users/{username}`. */
  appRequest?(route: string, params: Record<string, unknown>): Promise<{ data: any }>;
}

const fingerprint = (c: GithubCredentials) => `${c.appId}\n${c.baseUrl ?? ""}\n${c.privateKey}`;

/** The private key is read on first use, so a service with no GitHub installation still starts. */
export function createGithubClient(credentials: CredentialSource): GithubClient {
  let current: { key: string; app: App } | undefined;
  const load = async (): Promise<App> => {
    const creds = await credentials.load();
    const key = fingerprint(creds);
    if (current?.key === key) return current.app;
    const appOpts: ConstructorParameters<typeof App>[0] = { appId: creds.appId, privateKey: creds.privateKey };
    if (creds.baseUrl) (appOpts as { Octokit?: unknown }).Octokit = Octokit.defaults({ baseUrl: creds.baseUrl });
    current = { key, app: new App(appOpts) };
    return current.app;
  };
  return {
    async installationOctokit(installationId: number) {
      return (await load()).getInstallationOctokit(installationId);
    },
    async appRequest(route: string, params: Record<string, unknown>): Promise<{ data: any }> {
      return (await load()).octokit.request(route, params) as Promise<{ data: any }>;
    },
    async installationIdFor(owner: string, repo: string) {
      const res = await (await load()).octokit.request("GET /repos/{owner}/{repo}/installation", { owner, repo });
      const id = Number((res as { data?: { id?: unknown } }).data?.id);
      if (!Number.isSafeInteger(id)) throw new Error(`GitHub reported no installation for ${owner}/${repo}`);
      return id;
    },
  };
}
