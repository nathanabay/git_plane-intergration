# Leaf brief: leaf-1.4.1 — A5 reference parsing + A7 reconciliation + storage for Part B (implementer A, wave 4)

Read `.unlazy/impl/briefs/COMMON.md` first. Your ledger: `docs/impl/agent-gates/leaf-1.4.1.GATES.md`.

## OWNS

    src/parse/**, src/sync/reconcile.ts, src/queue/**, src/db/**, tests/parse/**, tests/reconcile/**,
    tests/queue/**, tests/db/**, docs/impl/agent-gates/leaf-1.4.1.GATES.md

Implementer B works concurrently on `src/github/**`, `src/sync/mirror.ts`, `src/sync/dev-info.ts`,
`src/operations/**`, `src/ui/**` and consumes the interfaces below. Do **not** touch
`src/index.ts` this wave (wiring every reducer happens in wave 5).

## Driver gates (copy into your ledger exactly)

    - [ ] G1: A5, A7 and the storage additions pass the driver oracle
      CHECK: node scripts/verify-a5-a7.mjs
      EXPECT: A5/A7 verification passed
      EVIDENCE: pending

    - [ ] G2: earlier Part A oracles did not regress
      CHECK: sh -c 'for o in verify-a3-schema verify-a2-ingress verify-a4-writepath; do node scripts/$o.mjs >/dev/null 2>&1 || { echo "FAIL $o"; exit 1; }; done; echo "part A regressions passed"'
      EXPECT: part A regressions passed
      EVIDENCE: pending

    - [ ] G3: own tests run, at least 40 passing, none skipped
      CHECK: node scripts/run-tests.mjs 40 tests/parse tests/reconcile tests/queue tests/db
      EXPECT: tests passed
      EVIDENCE: pending

    - [ ] G4: typecheck clean
      CHECK: node scripts/typecheck.mjs "src/parse/**/*.ts" "src/sync/reconcile.ts" "src/queue/**/*.ts" "src/db/**/*.ts" "tests/parse/**/*.ts" "tests/queue/**/*.ts" "tests/db/**/*.ts"
      EXPECT: typecheck passed
      EVIDENCE: pending

    - [ ] G5: no stubs or placeholders
      CHECK: node scripts/verify-no-stubs.mjs src/parse src/sync/reconcile.ts src/queue src/db tests/parse
      EXPECT: stub scan passed
      EVIDENCE: pending

Read `scripts/verify-a5-a7.mjs` in full first.

## A5 — reference parsing (spec §6) — `src/parse/references.ts`, `src/parse/magicWords.ts`

```ts
// magicWords.ts
export type Tier = "closing" | "non_closing" | "relation";
export interface MagicWords { closing: string[]; non_closing: string[]; relation: string[] }
export const DEFAULT_MAGIC_WORDS: MagicWords;          // exactly the §6 table (multi-word phrases included)
// references.ts
export interface IssueRef { identifier: string; project: string; sequence: number; tier: Tier;
  source: "branch" | "title" | "body" | "commit" }
export interface ParseResult { refs: IssueRef[]; skipped: string[]; createRequests: string[] }
export function parseReferences(input: { branch?: string; title?: string; body?: string; commits?: string[] },
  words?: MagicWords): ParseResult;
export function allLinkedPrsMerged(prs: { state: "open" | "merged" | "closed_unmerged" }[]): boolean;
export function resolveReferences(client: PlaneClient, slug: string, refs: IssueRef[]):
  Promise<{ found: { ref: IssueRef; issue: any }[]; unknown: IssueRef[] }>;   // identifier endpoint §1.2; 404 → unknown
```
Rules: identifiers are `{PROJECT}-{SEQUENCE}`, project = a letter followed by up to 11 letters/digits
(Plane's identifier limit), upper-cased; branch names are matched case-insensitively
(`nathan/web-344-x` → `WEB-344`). A magic word (case-insensitive, whole word/phrase) immediately
before a key — or before a list of keys separated by commas, whitespace or `and` — gives each key
that tier. A key in the **branch name or PR title** with no magic word is `closing` (Linear links
and closes via branch/title); a bare key in the body or a commit is `relation`. The same key from
several places collapses to one ref with the strongest tier (closing > non_closing > relation).
`skip KEY` / `ignore KEY` in the body removes KEY entirely and lists it in `skipped`.
`{IDENTIFIER}-NEW` goes to `createRequests` (§6 create-issue-from-PR), never to `refs`.
Do not treat tokens such as `UTF-8`, `SHA-256`, `X-1` as references (require the project part to be
2+ characters and a sequence that is a plain integer; keep a small deny-list for common
technical tokens and say so in a comment). `allLinkedPrsMerged`: true only if at least one PR is
merged and none is still open; `closed_unmerged` PRs neither block nor count (§6: all linked PRs
must merge before the item advances).

## A7 — reconciliation sweep (spec §1.3) — `src/sync/reconcile.ts`, `src/queue/cron.ts`

```ts
export function reconcileOnce(deps: { db: Db; plane: PlaneClient; batchSize?: number;
  onOrphan?(link: SyncLinkRow): Promise<void> }): Promise<{ checked: number; orphaned: number; errors: number }>;
export function pruneExpiredOps(deps: { db: Db; ttlMinutes: number }): Promise<number>;
// src/queue/cron.ts
export function startMaintenance(opts: { connectionUrl: string; prefix: string; db: Db; plane: PlaneClient }): { close(): Promise<void> };
```
Page through **active** links (`listActiveSyncLinks` with `afterId`); `GET` each linked Plane issue;
404 → `markLinkOrphaned`, an audit row (kind containing `orphan`), then `onOrphan` (the caller may
comment on GitHub); success → stamp `last_checked_at`; any other error → count it, leave the link
active. **Never** change a state, close anything, or write to Plane — an unreachable issue is
`orphaned`, not closed (HANDOFF pitfall 4). `startMaintenance` runs both jobs on a BullMQ job
scheduler on a new `maintenance` queue (add it to `QUEUE_NAMES`), with the interval and TTL read
from `instance_settings` (`reconciliation_interval_minutes`, `op_ttl_minutes`) on each run.

## Storage the other leaves need (add `src/db/migrations/002-*.sql`; 001 is now in use by B3)

1. `audit_log.workspace_slug TEXT` + index; `appendAudit` accepts `workspaceSlug`. (B3 found the
   workspace audit view had nothing to filter on.)
2. **Every inbound delivery is audited** by `processInbound`: kind `inbound_delivery`, source,
   delivery id, workspace slug when derivable, `detail: { event, payload }`, and the outcome
   (`duplicate` | `echo` | `handled` | `failed` with the error message). B8 replays from these rows.
   Payloads may contain user content — never secrets, because signatures were checked and dropped
   at ingress; do not store request headers.
3. Dev-info links (B7 updates rollup links in place): table `dev_info_links (plane_issue_id, key,
   plane_link_id, updated_at, PRIMARY KEY (plane_issue_id, key))` with
   `upsertDevInfoLink(db, { planeIssueId, key, planeLinkId })` and
   `getDevInfoLink(db, planeIssueId, key): Promise<string | null>` in `ledgers.ts`.
