// Lookups go through the authenticated service, which uses the configured GitHub API host.
import { api } from "./http.ts";
import { isValidGithubLogin, isValidRepoFullName } from "../validate.ts";

export async function lookupRepo(slug: string, fullName: string): Promise<{ id: number; fullName: string }> {
  if (!isValidRepoFullName(fullName)) throw new Error("Enter the repository as owner/repo");
  return api("GET", `/workspaces/${encodeURIComponent(slug)}/github/repository?name=${encodeURIComponent(fullName)}`);
}

export async function lookupUser(slug: string, login: string): Promise<{ id: number; login: string }> {
  if (!isValidGithubLogin(login)) throw new Error("Enter a valid GitHub username");
  return api("GET", `/workspaces/${encodeURIComponent(slug)}/github/user?login=${encodeURIComponent(login)}`);
}
