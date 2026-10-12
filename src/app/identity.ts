// §9 email matching (F12). A GitHub sender with no user-map row is matched to a Plane user by email: the
// GitHub account's public email (GitHub only lets a verified address be public) against the workspace's
// members. Exactly one match links the account; none or several is a loud audit failure and the service
// identity stays in charge. Nothing is ever guessed.
import { matchPlaneUserByEmail } from "../auth/identity.ts";
import type { GithubSender, PlaneMemberLite } from "../auth/identity.ts";
import { appendAudit, isUserLinkTombstoned, withUserLinkTransaction } from "../db/ledgers.ts";
import { installationFor, usersByGithubId } from "./context.ts";
import type { AppContext } from "./context.ts";
import type { Mapping } from "./mappings.ts";
import type { Db } from "../db/migrate.ts";

const RETRY_AFTER_MS = 10 * 60_000;
const attempted = new Map<string, number>();
/** For tests. */
export function resetEmailLinkAttempts(): void { attempted.clear(); }

const isAutomation = (s: GithubSender) => s.login.toLowerCase() === "ghost" || s.id === 10137 || s.type === "Bot" || s.login.toLowerCase().endsWith("[bot]");
class UserLinkAuthorityError extends Error {}

async function members(ctx: AppContext, mapping: Mapping): Promise<PlaneMemberLite[]> {
  const rows = await ctx.planeClient.listAll<any>(`/workspaces/${mapping.workspaceSlug}/members/`);
  return rows.map((m) => {
    const u = m?.member && typeof m.member === "object" ? m.member : m;
    return { id: String(u?.id ?? m?.member ?? ""), email: typeof u?.email === "string" ? u.email : null };
  }).filter((m) => m.id);
}

/**
 * Links `sender` to a Plane user when exactly one member shares its public email. Returns the Plane user id
 * when the sender is (now) linked. Network lookup failures are audited and use the service identity.
 * Unavailable database authority throws: callers must not read an unchecked existing mapping afterward.
 */
export async function ensureLinkedByEmail(ctx: AppContext, mapping: Mapping, sender: GithubSender | null | undefined, payload?: unknown): Promise<string | null> {
  if (!sender || !Number.isSafeInteger(sender.id) || sender.id <= 0 || typeof sender.login !== "string" || !sender.login.trim() || isAutomation(sender)) return null;
  const key = `${mapping.workspaceSlug}/${sender.id}`;
  const audit = (outcome: string, detail: Record<string, unknown>, error?: string) =>
    appendAudit(ctx.db, { kind: "identity_email_match", source: "github", workspaceSlug: mapping.workspaceSlug, detail: { githubLogin: sender.login, ...detail }, outcome, ...(error ? { error } : {}) });
  const decide = async <T>(fn: (conn: Db) => Promise<T>): Promise<T> => {
    try { return await withUserLinkTransaction(ctx.db, mapping.workspaceSlug, fn); }
    catch (err) { throw new UserLinkAuthorityError("User-link authority unavailable", { cause: err }); }
  };
  const suppressed = async (conn: Db) => {
    if (!await isUserLinkTombstoned(conn, mapping.workspaceSlug, sender.id)) return false;
    // Heal rows resurrected by older versions. Downstream actor/assignee lookups must not see
    // a map that contradicts the admin's tombstone, even when it existed before this upgrade.
    await conn.query("DELETE FROM user_tokens WHERE plane_user_id IN (SELECT plane_user_id FROM user_map WHERE workspace_slug = $1 AND gh_id = $2)", [mapping.workspaceSlug, sender.id]);
    await conn.query("DELETE FROM user_map WHERE workspace_slug = $1 AND gh_id = $2", [mapping.workspaceSlug, sender.id]);
    return true;
  };
  try {
    const state = await decide(async (conn) => {
      // Tombstones are authoritative even if a legacy race left a map row behind. Errors must
      // never authorize a lookup or an insert, and existing mappings are checked before use.
      if (await suppressed(conn)) return { suppressed: true, existing: null };
      return { suppressed: false, existing: await usersByGithubId(conn, mapping.workspaceSlug, sender).planeUserIdForGithubLogin(sender.login) };
    });
    if (state.suppressed) {
      await audit("skipped", { reason: "unlinked_by_admin", githubId: sender.id }, `GitHub user ${sender.login} was unlinked by an admin; acting as the service identity`);
      return null;
    }
    if (state.existing) return state.existing;
    const last = attempted.get(key);
    if (last !== undefined && Date.now() - last < RETRY_AFTER_MS) return null;
    attempted.set(key, Date.now());
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
    const decision = await decide(async (conn) => {
      if (await suppressed(conn)) return { reason: "unlinked_by_admin" };
      const existing = await usersByGithubId(conn, mapping.workspaceSlug, sender).planeUserIdForGithubLogin(sender.login);
      if (existing) return { userId: existing };
      const inserted = await conn.query(
        "INSERT INTO user_map (workspace_slug, plane_user_id, gh_login, gh_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id",
        [mapping.workspaceSlug, match.planeUserId, sender.login, sender.id]);
      return inserted.rows.length ? { userId: match.planeUserId } : { reason: "conflict" };
    });
    if (!decision.userId) {
      await audit(decision.reason === "unlinked_by_admin" ? "skipped" : "failed", { reason: decision.reason, planeUserId: match.planeUserId });
      return null;
    }
    await audit("linked", { planeUserId: match.planeUserId });
    return decision.userId;
  } catch (err) {
    attempted.delete(key); // a lookup that could not run should be tried again on the next event
    await audit("failed", { reason: "lookup_failed" }, err instanceof Error ? err.message.slice(0, 300) : "unknown error").catch(() => undefined);
    if (err instanceof UserLinkAuthorityError) throw err;
    return null;
  }
}
