// §9 email matching (F12). A GitHub sender with no user-map row is matched to a Plane user by email: the
// GitHub account's public email (GitHub only lets a verified address be public) against the workspace's
// members. Exactly one match links the account; none or several is a loud audit failure and the service
// identity stays in charge. Nothing is ever guessed.
import { matchPlaneUserByEmail } from "../auth/identity.ts";
import type { GithubSender, PlaneMemberLite } from "../auth/identity.ts";
import { appendAudit } from "../db/ledgers.ts";
import { installationFor, usersByGithubId } from "./context.ts";
import type { AppContext } from "./context.ts";
import type { Mapping } from "./mappings.ts";

const RETRY_AFTER_MS = 10 * 60_000;
const attempted = new Map<string, number>();
/** For tests. */
export function resetEmailLinkAttempts(): void { attempted.clear(); }

const isAutomation = (s: GithubSender) => s.login.toLowerCase() === "ghost" || s.id === 10137 || s.type === "Bot" || s.login.toLowerCase().endsWith("[bot]");

async function members(ctx: AppContext, mapping: Mapping): Promise<PlaneMemberLite[]> {
  const rows = await ctx.planeClient.listAll<any>(`/workspaces/${mapping.workspaceSlug}/members/`);
  return rows.map((m) => {
    const u = m?.member && typeof m.member === "object" ? m.member : m;
    return { id: String(u?.id ?? m?.member ?? ""), email: typeof u?.email === "string" ? u.email : null };
  }).filter((m) => m.id);
}

/**
 * Links `sender` to a Plane user when exactly one member shares its public email. Returns the Plane user id
 * when the sender is (now) linked. Failures are audited and never thrown: attribution then falls back to the
 * service identity, which is audited as well.
 */
export async function ensureLinkedByEmail(ctx: AppContext, mapping: Mapping, sender: GithubSender | null | undefined, payload?: unknown): Promise<string | null> {
  if (!sender || typeof sender.login !== "string" || !sender.login.trim() || isAutomation(sender)) return null;
  const users = usersByGithubId(ctx.db, mapping.workspaceSlug, sender); // F12: by gh_id, not login
  const existing = await users.planeUserIdForGithubLogin(sender.login);
  if (existing) return existing;

  const key = `${mapping.workspaceSlug}/${sender.login.toLowerCase()}`;
  const last = attempted.get(key);
  if (last !== undefined && Date.now() - last < RETRY_AFTER_MS) return null;
  attempted.set(key, Date.now());

  const audit = (outcome: string, detail: Record<string, unknown>, error?: string) =>
    appendAudit(ctx.db, { kind: "identity_email_match", source: "github", workspaceSlug: mapping.workspaceSlug, detail: { githubLogin: sender.login, ...detail }, outcome, ...(error ? { error } : {}) });
  try {
    const octokit = await ctx.ghClient.installationOctokit(await installationFor(ctx, mapping, payload));
    const profile = await octokit.request("GET /users/{username}", { username: sender.login });
    const email = typeof profile.data?.email === "string" ? profile.data.email : "";
    if (!email) { await audit("failed", { reason: "no_public_email" }, `GitHub user ${sender.login} has no public email to match`); return null; }
    if (profile.data?.id !== undefined && Number(profile.data.id) !== Number(sender.id)) { await audit("failed", { reason: "id_mismatch" }, `GitHub user ${sender.login} does not have the id the event reported`); return null; }
    const match = matchPlaneUserByEmail(email, await members(ctx, mapping));
    if (!match.ok) {
      await audit("failed", { reason: match.reason, candidates: match.candidates }, `email match for ${sender.login}: ${match.reason === "multiple" ? "several Plane members share the email" : match.reason === "none" ? "no Plane member has the email" : "the email is not valid"}`);
      return null;
    }
    const inserted = await ctx.db.query(
      "INSERT INTO user_map (workspace_slug, plane_user_id, gh_login, gh_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id",
      [mapping.workspaceSlug, match.planeUserId, sender.login, sender.id]);
    if (inserted.rows.length === 0) { await audit("failed", { reason: "conflict", planeUserId: match.planeUserId }, "that Plane user or GitHub account is already linked to another"); return null; }
    await audit("linked", { planeUserId: match.planeUserId });
    return match.planeUserId;
  } catch (err) {
    attempted.delete(key); // a lookup that could not run should be tried again on the next event
    await audit("failed", { reason: "lookup_failed" }, err instanceof Error ? err.message.slice(0, 300) : "unknown error").catch(() => undefined);
    return null;
  }
}
