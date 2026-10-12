// Smart Commits (spec §7.2): `<ignored> KEY… <ignored> #command args`, Jira grammar.
// Attribution comes from the push's `sender` only. `pusher` and commit author/committer are
// git-supplied and forgeable, so nothing here reads them.
import type { SecretString, TokenVault, UserMapLookup } from "../auth/identity.ts";
import { resolveActor } from "../auth/identity.ts";
import type { Db } from "../db/migrate.ts";
import { appendAudit, claimCommit } from "../db/ledgers.ts";
import { parseReferences } from "../parse/references.ts";
import { PlaneApiError, TriageWriteRejected } from "../sync/plane.ts";
import type { PlaneWrite, PlaneWriteResult } from "../sync/plane.ts";
import { deliveryScope } from "../app/writers.ts";
import type { WriteAuthority } from "../operations/plans.ts";
import { escapeHtml, safeUrl } from "./html.ts";

export interface SmartCommand {
  keys: string[];
  transitions: string[];
  time?: { raw: string; minutes: number };
  comment?: string;
  /** Commands that could not be parsed (for example a `#time` with no duration); reported, never guessed. */
  errors?: string[];
}

const MINUTES = { w: 5 * 8 * 60, d: 8 * 60, h: 60, m: 1 } as const;
const DURATION_PART = /(\d+(?:\.\d+)?)\s*([wdhm])\b/gi;

/** Jira defaults: 1w = 5d, 1d = 8h. Decimals allowed. Anything that is not only duration parts throws. */
export function durationToMinutes(raw: string): number {
  const text = raw.trim();
  if (!text) throw new Error("empty duration");
  let total = 0;
  let consumed = 0;
  for (const m of text.matchAll(DURATION_PART)) {
    total += Number(m[1]) * MINUTES[m[2]!.toLowerCase() as keyof typeof MINUTES];
    consumed += m[0].length;
  }
  if (consumed === 0 || text.replace(DURATION_PART, "").replace(/\s+/g, "") !== "") throw new Error(`invalid duration "${raw}"`);
  return Math.round(total);
}

const COMMAND = /(?:^|\s)#([A-Za-z][\w'-]*)/g;

function keysIn(text: string): string[] {
  const found = parseReferences({ body: text }).refs.map((r) => r.identifier);
  const pos = (id: string) => text.search(new RegExp(`(?<![A-Za-z0-9])${id}(?![A-Za-z0-9_])`, "i"));
  return [...new Set(found)].sort((a, b) => pos(a) - pos(b));
}

/** One entry per line that has at least one key and one command. A command never spans lines. */
export function parseSmartCommits(message: string): SmartCommand[] {
  const out: SmartCommand[] = [];
  for (const line of message.split(/\r?\n/)) {
    const cmds = [...line.matchAll(COMMAND)];
    if (cmds.length === 0) continue;
    const first = cmds[0]!;
    // Keys count only before the first command; a key quoted inside a comment is text.
    const keys = keysIn(line.slice(0, first.index));
    if (keys.length === 0) continue;

    const entry: SmartCommand = { keys, transitions: [] };
    const errors: string[] = [];
    for (let i = 0; i < cmds.length; i++) {
      const c = cmds[i]!;
      const name = c[1]!;
      const argStart = c.index + c[0].length;
      const lower = name.toLowerCase();
      if (lower === "comment") {
        // The comment is the rest of the line, so a `#123` or `#done` inside it stays text.
        const text = line.slice(argStart).trim();
        if (text) entry.comment = text; else errors.push("#comment has no text");
        break;
      }
      const args = line.slice(argStart, cmds[i + 1]?.index ?? line.length).trim();
      if (lower === "time") {
        const lead = /^(?:\d+(?:\.\d+)?\s*[wdhm]\b\s*)+/i.exec(args)?.[0].trim();
        if (!lead) { errors.push(`#time needs a duration such as 1w 2d 4h 30m, got "${args.slice(0, 40)}"`); continue; }
        const minutes = durationToMinutes(lead);
        entry.time = entry.time ? { raw: `${entry.time.raw} ${lead}`, minutes: entry.time.minutes + minutes } : { raw: lead, minutes };
      } else {
        entry.transitions.push(name);
      }
    }
    if (errors.length) entry.errors = errors;
    out.push(entry);
  }
  return out;
}

export interface WorkflowState { id: string; name: string; group: string }
export type TransitionResolution = { ok: true; stateId: string } | { ok: false; reason: "not_found" | "ambiguous" };

const hyphenate = (s: string) => s.trim().toLowerCase().replace(/\s+/g, "-");
const squash = (s: string) => hyphenate(s).replace(/[-']/g, "");

/**
 * Resolves `#in-review` against one project's states. Tiers, first with any hit decides: the full
 * hyphenated name, the name ignoring hyphens and apostrophes, then a word-boundary prefix. Two hits
 * in a tier are ambiguous, never a guess.
 */
export function resolveTransition(states: WorkflowState[], token: string): TransitionResolution {
  const key = hyphenate(token);
  if (!key) return { ok: false, reason: "not_found" };
  const tiers: ((s: WorkflowState) => boolean)[] = [
    (s) => hyphenate(s.name) === key,
    (s) => squash(s.name) === squash(key),
    (s) => hyphenate(s.name).startsWith(key + "-"),
  ];
  for (const hit of tiers) {
    const matches = states.filter(hit);
    if (matches.length === 1) return { ok: true, stateId: matches[0]!.id };
    if (matches.length > 1) return { ok: false, reason: "ambiguous" };
  }
  return { ok: false, reason: "not_found" };
}

export interface PushCommit { id: string; message: string; url?: string }

export interface SmartCommitDeps {
  db: Db;
  writer: {
    apply(write: PlaneWrite, opts?: { actorToken?: SecretString }): Promise<PlaneWriteResult>;
    reviveSmartCommit?(sha: string, workspaceSlug: string, deliveryId: string): Promise<void>;
  };
  users: UserMapLookup;
  vault: Pick<TokenVault, "load">;
  requireVerified: boolean;
  mapping: { workspaceSlug: string; smartCommitsEnabled: boolean };
  authority?: WriteAuthority;
  listStates(projectId: string): Promise<WorkflowState[]>;
  resolveIssue(key: string): Promise<{ projectId: string; issueId: string } | null | undefined>;
  getCommitVerified(sha: string): Promise<boolean>;
  /**
   * Every commit in `before..after` (GitHub's `compare` API). A push payload lists at most 20 commits, so
   * for a bigger push this is what keeps the later commits' commands from being dropped (§7.2).
   */
  listCommitRange?(before: string, after: string): Promise<PushCommit[]>;
  /** How long a delivery waits for another delivery's lock on the same commit before failing retriably (default 30 s). */
  lockTimeoutMs?: number;
}

export interface PushSummary { commits: number; applied: number; failed: number; skipped: number; retry: number }

/** GitHub's `push` webhook lists at most this many commits (20 is the Events API limit, not the webhook's). */
export const PUSH_PAYLOAD_COMMIT_LIMIT = 2048;

/** A transient failure left commands pending: the delivery must be retried; finished commands are not redone. */
export class SmartCommitRetry extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmartCommitRetry";
  }
}

/** The lock for a commit stayed held past the wait limit: the delivery fails and BullMQ retries it later. */
export class SmartCommitLockTimeout extends SmartCommitRetry {
  constructor(key: string, ms: number) {
    super(`Smart Commit lock ${key} still held after ${ms} ms; retry the delivery`);
    this.name = "SmartCommitLockTimeout";
  }
}

/** Upper bound on commits taken from a compare range; a bigger push is processed up to here and audited as truncated. */
export const MAX_RANGE_COMMITS = 10_000;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const LOCK_POLL_MS = 100;

const ZERO_SHA = /^0+$/;

/** Retry network errors, 429 and 5xx; everything Plane answers with another 4xx, and the triage ban, is final. */
function isPermanent(e: unknown): boolean {
  if (e instanceof TriageWriteRejected) return true;
  if (e instanceof PlaneApiError) return e.status < 500 && e.status !== 429 && e.status !== 408;
  return false;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message.slice(0, 300) : "unknown error";
}

const localTails = new WeakMap<object, Map<string, Promise<unknown>>>();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** In-process FIFO per (database, key): a single-connection engine only serialises single queries, not our read-then-write sequences.
 *  Waiting is bounded: a holder that never returns cannot stall the waiters forever. */
async function withLocalLock<T>(db: object, key: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  let tails = localTails.get(db);
  if (!tails) localTails.set(db, (tails = new Map()));
  const prev = tails.get(key) ?? Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), timeoutMs); });
  const myTurn = prev.then(() => "turn" as const);
  let release!: () => void;
  const tail = new Promise<void>((r) => { release = r; });
  const chained = Promise.all([prev, tail]).then(() => undefined);
  tails.set(key, chained);
  try {
    const winner = await Promise.race([myTurn, timedOut]);
    if (winner === "timeout") throw new SmartCommitLockTimeout(key, timeoutMs);
    return await fn();
  } finally {
    clearTimeout(timer);
    release();
    // Forget the key only once the whole chain has settled. A waiter that timed out leaves its link in place (it resolves
    // when its predecessor does), so a later delivery still queues behind the holder that is still running.
    void chained.then(() => { if (tails.get(key) === chained) tails.delete(key); });
  }
}

/** Takes the cross-replica advisory lock without ever blocking the connection: try, sleep, retry until the deadline. */
async function acquireAdvisory(conn: Db, key: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await conn.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok", [key]);
    if (r.rows[0]?.ok) return;
    if (Date.now() >= deadline) throw new SmartCommitLockTimeout(key, timeoutMs);
    await sleep(LOCK_POLL_MS);
  }
}

/** Serialises work on one key in this process and, where the engine has pooled connections, across replicas (session advisory lock; a crash releases it with the connection). */
async function withLock<T>(db: Db, key: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  return withLocalLock(db, key, timeoutMs, async () => {
    if (!db.withConnection) return fn();
    return db.withConnection(async (conn) => {
      await acquireAdvisory(conn, key, timeoutMs);
      try {
        return await fn();
      } finally {
        await conn.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
      }
    });
  });
}

async function commitsOf(payload: any, deps: SmartCommitDeps, audit: (kind: string, outcome: string, detail: unknown, error?: string) => Promise<unknown>): Promise<PushCommit[]> {
  const listed: PushCommit[] = (Array.isArray(payload?.commits) ? payload.commits : [])
    .filter((c: any) => typeof c?.id === "string")
    .map((c: any) => ({ id: c.id, message: typeof c.message === "string" ? c.message : "", ...(typeof c.url === "string" ? { url: c.url } : {}) }));
  const before: unknown = payload?.before, after: unknown = payload?.after;
  if (listed.length < PUSH_PAYLOAD_COMMIT_LIMIT || typeof before !== "string" || typeof after !== "string") return listed;
  if (ZERO_SHA.test(before) || ZERO_SHA.test(after)) {
    await audit("smart_commit_truncated", "partial", { reason: "new branch push has more commits than the payload lists" });
    return listed;
  }
  if (!deps.listCommitRange) {
    await audit("smart_commit_truncated", "partial", { before, after, reason: "no commit-range lookup configured" });
    return listed;
  }
  let raw: PushCommit[];
  try {
    raw = await deps.listCommitRange(before, after);
  } catch (e) {
    // GitHub refusing the range (404: a force-pushed-away base; 422: no common ancestor or too large) will never succeed on retry:
    // keep the payload's own commits and say so. Outages (5xx, network, 429) still fail the delivery so it is retried.
    const status = (e as { status?: number } | null)?.status;
    if (status === 404 || status === 422) {
      await audit("smart_commit_truncated", "partial", { before, after, reason: `compare lookup refused (${status}); only the commits listed in the payload were processed` });
      return listed;
    }
    throw e;
  }
  // The lookup is outside this module: keep only well-formed entries, once each, bounded in number.
  const seen = new Set<string>();
  const full: PushCommit[] = [];
  for (const c of Array.isArray(raw) ? raw : []) {
    if (typeof c?.id !== "string" || seen.has(c.id)) continue;
    seen.add(c.id);
    full.push({ id: c.id, message: typeof c.message === "string" ? c.message : "", ...(typeof c.url === "string" ? { url: c.url } : {}) });
    if (full.length >= MAX_RANGE_COMMITS) {
      await audit("smart_commit_truncated", "partial", { before, after, reason: `range has more than ${MAX_RANGE_COMMITS} commits` });
      break;
    }
  }
  // An empty or short range (a force-push with no common history, an API hiccup that returned nothing) never loses what the payload listed.
  return [...full, ...listed.filter((c) => !seen.has(c.id))];
}

export async function processPush(payload: any, deps: SmartCommitDeps): Promise<PushSummary> {
  const summary: PushSummary = { commits: 0, applied: 0, failed: 0, skipped: 0, retry: 0 };
  if (!deps.mapping.smartCommitsEnabled) return summary;
  const slug = deps.mapping.workspaceSlug;
  const repoId = Number(payload?.repository?.id);
  if (!Number.isSafeInteger(repoId) || !Array.isArray(payload?.commits) || payload.commits.length === 0) return summary;
  const authority = deps.authority ?? deliveryScope.getStore()?.authority;
  if (authority && (authority.workspaceSlug !== slug || authority.repoId !== repoId))
    throw new PlaneApiError(403, {}, "Smart Commit source does not match its verified mapping");
  const admission = authority ? { ...authority } : undefined;

  const audit = (kind: string, outcome: string, detail: unknown, error?: string, deliveryId?: string) =>
    appendAudit(deps.db, { kind, source: "github", workspaceSlug: slug, detail, outcome, ...(error ? { error } : {}), ...(deliveryId ? { deliveryId } : {}) });

  // sender is the authenticated account; ghost, bots and unmapped users act as the service (§7.2, §9).
  const actor = await resolveActor(payload.sender, deps.users);
  let actorToken: SecretString | undefined;
  let fallback: { reason: string; githubLogin: string | null } | null = null;
  if (actor.kind === "user") {
    actorToken = (await deps.vault.load(actor.planeUserId, "plane_pat")) ?? undefined;
    if (!actorToken) fallback = { reason: "no_stored_token", githubLogin: actor.githubLogin };
  } else {
    fallback = { reason: actor.reason, githubLogin: actor.githubLogin };
  }
  const login = actor.githubLogin ?? "unknown";
  const writeOpts = actorToken ? { actorToken } : undefined;

  const stateCache = new Map<string, Promise<WorkflowState[]>>();
  const statesOf = (projectId: string) => {
    let p = stateCache.get(projectId);
    if (!p) { p = deps.listStates(projectId); stateCache.set(projectId, p); }
    return p;
  };

  const retries: string[] = [];
  for (const commit of await commitsOf(payload, deps, audit)) {
    const { id: sha, message } = commit;
    if (!/^[0-9a-f]{7,64}$/i.test(sha)) continue;
    const parsed = parseSmartCommits(message);
    if (parsed.length === 0) continue;
    summary.commits++;

    if (deps.requireVerified) {
      let verified = false;
      try { verified = await deps.getCommitVerified(sha); } catch (e) {
        await audit("smart_commit_rejected", "failed", { sha, repoId }, `could not check the signature of ${sha.slice(0, 7)}: ${errText(e)}`);
        retries.push(`${sha.slice(0, 7)}: signature check failed`);
        summary.retry++;
        continue;
      }
      if (!verified) {
        await audit("smart_commit_rejected", "rejected", { sha, repoId }, `commit ${sha.slice(0, 7)} is not signature-verified; Smart Commit commands ignored`);
        summary.skipped++;
        continue;
      }
    }

    // One commit at a time per workspace, across replicas. Inside the lock each command is its own
    // idempotent step, so a retry after a transient failure (or a crash) repeats only what did not finish.
    const outcome = await withLock(deps.db, `smartcommit:${slug}:${sha}`, deps.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS, () => runCommit(commit, parsed));
    if (outcome === "skipped") summary.skipped++;
    else if (outcome === "retry") summary.retry++;
  }
  if (retries.length) throw new SmartCommitRetry(`Smart Commits left pending, retry the delivery: ${retries.join("; ")}`);
  return summary;

  async function runCommit(commit: PushCommit, parsed: SmartCommand[]): Promise<"done" | "skipped" | "retry"> {
    const sha = commit.id;
    const doneId = `sc:${sha}`;
    const scope = deliveryScope.getStore();
    if (scope?.writeDeliveryId && scope.transportDeliveryId && scope.writeDeliveryId !== scope.transportDeliveryId)
      await deps.writer.reviveSmartCommit?.(sha, slug, scope.deliveryId);
    // Finished earlier: another push, branch, fork or a redelivery. The (SHA, workspace) claim is the ledger
    // record of completion (§5, F16); a claim with no workspace is a pre-F16 row that still counts.
    if (await recorded(doneId) || await claimed(sha)) return "skipped";
    if (fallback) await audit("identity_fallback", "service_identity", { sha, repoId, ...fallback });

    const short = sha.slice(0, 7);
    const url = safeUrl(commit.url);
    const provenance = `<p><small>via ${url ? `<a href="${escapeHtml(url)}">${short}</a>` : short} by ${escapeHtml(login)}</small></p>`;
    let failed = 0;
    let pending = 0;
    let registered = 0;

    /** Runs one step once: a recorded step is skipped; success and permanent failure are recorded; transient failure is not. */
    const step = async (stepId: string, what: string, detail: object, run: () => Promise<PlaneWriteResult>): Promise<void> => {
      const id = `sc:${sha}:${stepId}`;
      if (await recorded(id)) return;
      try {
        // The step id is the write's explicit identity in the outbox (round-3 F1): a retry that skips earlier, already recorded
        // steps cannot shift later steps onto their job ids, and two identical writes from different commands never collide.
        const scope = deliveryScope.getStore();
        const result = await deliveryScope.run({ ...scope, deliveryId: scope?.deliveryId ?? `smartcommit-${sha}`, operationId: id,
          ...(admission ? { authority: admission, workspaceSlug: admission.workspaceSlug } : {}) }, run);
        const receipt = result as PlaneWriteResult & { registered?: boolean; outboxId?: string };
        if (receipt.registered) registered++;
        await audit("smart_commit_step", receipt.registered ? "registered" : "applied",
          { sha, repoId, ...detail, ...(receipt.outboxId ? { outboxId: receipt.outboxId } : {}) }, undefined, id);
        summary.applied++;
      } catch (e) {
        if (isPermanent(e)) {
          failed++;
          summary.failed++;
          await audit("smart_commit_failed", "failed", { sha, repoId, ...detail }, `${what}: ${errText(e)}`, id);
        } else {
          pending++;
          await audit("smart_commit_retry", "retry", { sha, repoId, ...detail }, `${what}: ${errText(e)}`);
        }
      }
    };
    /** A permanent, already-explained failure (unknown item or state) recorded as a finished step. */
    const refuse = async (stepId: string, error: string, detail: object): Promise<void> => {
      const id = `sc:${sha}:${stepId}`;
      if (await recorded(id)) return;
      failed++;
      summary.failed++;
      await audit("smart_commit_failed", "failed", { sha, repoId, ...detail }, error, id);
    };

    for (let ci = 0; ci < parsed.length; ci++) {
      const cmd = parsed[ci]!;
      for (const [n, e] of (cmd.errors ?? []).entries()) await refuse(`${ci}:parse${n}`, `${cmd.keys.join(", ")}: ${e}`, { keys: cmd.keys });
      for (const key of cmd.keys) {
        let issue: { projectId: string; issueId: string } | null | undefined;
        try { issue = await deps.resolveIssue(key); } catch (e) {
          if (isPermanent(e)) await refuse(`${ci}:${key}:lookup`, `could not look up ${key}: ${errText(e)}`, { key });
          else { pending++; await audit("smart_commit_retry", "retry", { sha, repoId, key }, `could not look up ${key}: ${errText(e)}`); }
          continue;
        }
        if (!issue) { await refuse(`${ci}:${key}:unknown`, `unknown work item ${key}`, { key }); continue; }
        const base = { slug, projectId: issue.projectId, issueId: issue.issueId };

        for (let ti = 0; ti < cmd.transitions.length; ti++) {
          const t = cmd.transitions[ti]!;
          let states: WorkflowState[];
          try { states = await statesOf(issue.projectId); } catch (e) {
            if (isPermanent(e)) await refuse(`${ci}:${key}:t${ti}`, `${key} #${t}: could not list states: ${errText(e)}`, { key });
            else { pending++; await audit("smart_commit_retry", "retry", { sha, repoId, key }, `${key} #${t}: could not list states: ${errText(e)}`); }
            continue;
          }
          const r = resolveTransition(states, t);
          if (!r.ok) {
            await refuse(`${ci}:${key}:t${ti}`, `${key}: transition #${t} ${r.reason === "ambiguous" ? "matches several states" : "matches no state"} in project ${issue.projectId}`, { key, transition: t });
            continue;
          }
          await step(`${ci}:${key}:t${ti}`, `${key} #${t}`, { key, transition: t },
            () => deps.writer.apply({ kind: "update_issue", ...base, fields: { state: r.stateId } }, writeOpts));
        }
        if (cmd.time) {
          const time = cmd.time;
          // Plane CE has no worklog API, so the time is recorded as a comment.
          await step(`${ci}:${key}:time`, `${key} #time`, { key },
            () => deps.writer.apply({ kind: "add_comment", ...base, commentHtml: `<p>Time logged: ${escapeHtml(time.raw)} (${time.minutes} minutes)</p>${provenance}` }, writeOpts));
        }
        if (cmd.comment) {
          const text = cmd.comment;
          await step(`${ci}:${key}:comment`, `${key} #comment`, { key },
            () => deps.writer.apply({ kind: "add_comment", ...base, commentHtml: `<p>${escapeHtml(text)}</p>${provenance}` }, writeOpts));
        }
      }
    }

    if (pending > 0) {
      retries.push(`${short}: ${pending} command${pending === 1 ? "" : "s"} pending`);
      return "retry";
    }
    // Durable registrations now own execution/recovery; the SHA claim prevents fresh pushes duplicating them.
    await claimCommit(deps.db, sha, repoId, slug);
    await audit("smart_commit", failed ? "partial" : registered ? "registered" : "applied", { sha, repoId, keys: [...new Set(parsed.flatMap((c) => c.keys))], actor: login }, undefined, doneId);
    return "done";
  }

  async function claimed(sha: string): Promise<boolean> {
    const r = await deps.db.query(`SELECT 1 FROM processed_commits WHERE sha = $1 AND workspace_slug IN ($2, '') LIMIT 1`, [sha, slug]);
    return r.rows.length > 0;
  }

  /** Whether a step or commit marker (an audit row with this delivery id) exists for the workspace. */
  async function recorded(deliveryId: string): Promise<boolean> {
    const r = await deps.db.query(`SELECT 1 FROM audit_log WHERE source = 'github' AND delivery_id = $1 AND workspace_slug = $2 LIMIT 1`, [deliveryId, slug]);
    return r.rows.length > 0;
  }
}
