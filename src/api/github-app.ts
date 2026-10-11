import { App } from "@octokit/app";
import { Octokit } from "@octokit/core";

export function createGithubApp(opts: { appId: number | string; privateKey: string; baseUrl?: string }): { installationOctokit(installationId: number): Promise<Octokit> } {
  const appOpts: any = {
    appId: opts.appId,
    privateKey: opts.privateKey,
  };
  
  if (opts.baseUrl) {
    appOpts.Octokit = Octokit.defaults({
      baseUrl: opts.baseUrl,
    });
  }

  const app = new App(appOpts);

  return {
    async installationOctokit(installationId: number): Promise<Octokit> {
      return app.getInstallationOctokit(installationId);
    }
  };
}
