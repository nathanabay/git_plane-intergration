# Security audit: backend

SUMMARY: 0 Critical, 0 High, 0 Medium, 0 Low

**5 Unconfirmed; 1 candidate rejected.**

Deep, backend-scoped source review of the dirty working tree at commit `325519c13d031c77242b3dc176ff59e2ce37d998`, including uncommitted fixes/parity work. This is partial security coverage: browser authentication/CSRF, OAuth/install callbacks, React/static rendering and host SSRF belong to the web-side auditor. UI rule-preview source was read only to establish the backend evaluator’s accepted input and administrator prerequisite. No compatible completed prior backend run was available; the concurrent web run was not reused as backend coverage.

User-required source review only: no target code, builds, tests, typecheck, fixture processing, live or external probing. No source edits, staging, commits or pushes. One expressly permitted `npm audit --omit=dev --json` advisory lookup completed with zero reported production vulnerabilities. That result covers the registry’s known dependency advisories, not all runtime, image or application security. Context7 `/npm/cli`: “asks for a report of known vulnerabilities.” [npm audit documentation](https://github.com/npm/cli/blob/latest/docs/lib/content/commands/npm-audit.md). No safe target-execution sandbox was established or used, and no target-controlled artifact was promoted.

All five retained records are **Unconfirmed / needs_validation**, with no severity. Each has an independent Phase3 source validation and a separate fresh Phase5 record verification. The old overlapping-backslash Markdown candidate was rejected against the concurrently updated converter. An unchanged source path does not prove a deployment prerequisite or a runtime result; zero confirmed findings is not an assurance that the service has no vulnerabilities.

### U1 [Unconfirmed] An accepted Plane webhook key is not bound to its owning workspace

File: `src/api/handler.ts:92`, `src/queue/workers.ts:157`, `src/app/issues.ts:266`, `src/app/context.ts:269`, `src/sync/mirror.ts:612`, `src/operations/outbox.ts:558`, `src/sync/github.ts:103`, `src/app/main.ts:68`, `src/app/mappings.ts:173`, `deploy/APPLY.md:308`

Attacker: A workspace A webhook creator/administrator who legitimately retained an A signing key accepted by this instance, but has no authority in B. The attacker also needs a known B project/work-item pair with an active mirror link.

Exploit: A workspace A webhook creator or administrator who legitimately retains A's configured signing key may submit a signed issue_comment payload claiming workspace B and a known B project/work-item pair. The source authenticates against an instance-wide current/previous key list, then selects B's mapping from payload claims. If B has a permitted installation, a bidirectional mapping, an active label_sync issue link and an allowing comments policy, this path may register and execute an attacker-supplied GitHub comment in B's mapped repository. Supplying a linked B actor may additionally select that actor's usable GitHub user token. Neither cross-workspace mutation nor victim-user attribution was independently demonstrated.

Impact: Conditional cross-workspace GitHub comment creation. Optional victim-user attribution additionally needs a B identity link and usable user token. Neither result was observed.

Evidence: Plane ingress preserves only whether any accepted key verified the body, without trusted key-to-workspace/webhook ownership. Mapping admission consequently compares signed but key-holder-controlled workspace claims rather than the authenticated key's permitted workspace.

Source `src/api/handler.ts:87`:

```ts
    const secrets = (typeof deps.planeSecret === "string" ? [deps.planeSecret] : deps.planeSecret).filter((s) => s);
    const signedBy = (secret: string) => {
      const expectedSig = createHmac("sha256", secret).update(body).digest("hex");
      return signature.length === expectedSig.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig));
    };
    if (!secrets.some(signedBy)) {
      res.writeHead(401, { "Content-Type": "application/json" });
```

Source `src/app/context.ts:269`:

```ts
  if (typeof payload?.workspace_slug === "string") return payload.workspace_slug === mapping.workspaceSlug;
  const claimed = typeof payload?.workspace_id === "string" ? payload.workspace_id : typeof payload?.data?.workspace === "string" ? payload.data.workspace : null;
  if (!claimed) return false;
```

Context7 `/websites/developers_plane_so`, [Plane webhook introduction](https://developers.plane.so/dev-tools/intro-webhooks): “Plane downloads the secret key as a CSV file to your computer” The key creator receiving the secret is an explicit prerequisite; pinned v1.4.2 creation/regeneration source was also reviewed.

Context7 `/websites/github_en`, [GitHub App authentication guidance](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app): “attribute activity to both a user and your app” This supports only the optional user-token attribution variant.

Fix: If validated, associate every current/previous accepted signing key with trusted workspace/webhook ownership, preserve the matched ownership in queued/spooled/replayed jobs, and compare it at mapping admission and execution. A caller-supplied workspace slug cannot supply that provenance.

Validation: The user prohibits target execution. No bounded offline dummy-workspace test independently observed B intent registration or execution, and no execution/promotion evidence is available. Deployment applicability requires an admitted A key legitimately known to a principal lacking B authority, a distinct active B mapping with allowed installation, bidirectional direction, allowing comments policy, and a known B project/work-item pair with an active label_sync issue link. These conditions were not inferred from the deployment. The optional victim-user attribution variant additionally requires a known B actor with a B user_map row and a usable GitHub user client; the basic installation-comment variant does not establish or require victim-user attribution.

Detailed ordered trace, controls and bounded future validation plan: [NEEDS-VALIDATION.md](/home/claudeuser/security-audit-skill/git_plane-intergration/run-1-backend/NEEDS-VALIDATION.md), fingerprint `src/app/context.ts:plane-signing-key-workspace-binding`. No proposed validation was executed.

### U2 [Unconfirmed] Reclaimed repository names may redirect writes authorized for a different repository ID

File: `src/app/github.ts:56`, `src/app/context.ts:167`, `src/sync/mirror.ts:305`, `src/app/issues.ts:28`, `src/operations/outbox.ts:668`, `src/app/mappings.ts:38`, `src/sync/github.ts:116`, `src/ui/mapping-check.ts:69`, `src/app/reducers.ts:16`

Attacker: A lower-trust organization repository creator who cannot read private mapped repository A, but can reclaim its abandoned historical name after a trusted owner renames A.

Exploit: After a trusted owner renames mapped private repository A, a lower-trust repository creator who cannot read A may reclaim its historical org/name as repository B. If B is accessible through the same allow-listed installation, the unchanged mapping or queued intent still authorizes A's stable repository ID while the GitHub REST request addresses B by name. A genuine Plane comment on an active label-sync partner could then disclose its mirrored content to B when B has the matching issue number and the comments policy permits mirroring. No mocked or live write outcome was observed.

Impact: Conditional disclosure of a genuine protected Plane comment to replacement repository B. B must have the matching issue number and be writable through the same approved installation; a full refresh or revocation prevents the path.

Evidence: Admission verifies the installation currently serving a persisted repository name, and execution rechecks the exact frozen mapping, repository ID and installation ID. Neither check binds the final owner/repo REST locator to the authorized stable repository ID. The production installation client is requested by installation ID without a repository restriction.

Source `src/app/context.ts:129`:

```ts
    id = await ctx.ghClient.installationIdFor(mapping.owner, mapping.repo);
```

Source `src/sync/github.ts:124`:

```ts
    const repo = { owner: write.owner, repo: write.repo };
```

Source `src/app/mappings.ts:178`:

```ts
        if (w.installationId !== a.installationId || w.repoId !== a.repoId) throw denied();
      } else if (w.slug !== workspaceSlug) throw denied();
      return;
```

Context7 `/websites/github_en`, [Renaming a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository): “redirects to the renamed repository will no longer work.” Reusing the original name supports the conditional replacement premise; actual name availability is unobserved.

Context7 `/websites/github_en`, [Installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app): “If these are not provided, the token will have access to all repositories granted to the installation.” Repository restrictions are omitted by the production installation-client request; B still must be in the actual granted set.

Context7 `/octokit/octokit.js`, [Octokit App API](https://github.com/octokit/octokit.js/blob/main/_autodocs/api-reference/app.md): getInstallationOctokit supplies the installation-authenticated client; this alone does not bind the request name to A's numeric ID.

Fix: If validated, resolve the final repository locator at the last write boundary and fail closed unless its current numeric ID equals the frozen authorized ID. Restrict installation tokens to that numeric repository where supported and refresh/invalidate renamed mappings. Keep the existing exact mapping/installation revocation checks.

Validation: The user prohibits target execution and probes, so no bounded offline mocked rename/replacement workflow or remote write result was observed. Applicability requires a historical name that the lower-trust creator can actually reclaim after an independent trusted rename, without read access to private A. Name availability and repository-creation permissions are deployment-specific and unobserved. Replacement B must be accessible and writable through the same allow-listed installation, for example an installation granting the relevant permissions across all repositories in that organization. If B is not installed, the admission lookup fails; if A is invalidated by a full refresh, installation removal, mapping edit or revocation before execution, the proposed path is prevented. The disclosure variant requires an unchanged stale mapping or pending intent, a genuine new Plane comment with protected content, an active label-sync issue link, a direction and comments policy allowing Plane-to-GitHub mirroring, and an existing issue in B with the linked issue number. These application and timing conditions were not demonstrated.

Detailed ordered trace, controls and bounded future validation plan: [NEEDS-VALIDATION.md](/home/claudeuser/security-audit-skill/git_plane-intergration/run-1-backend/NEEDS-VALIDATION.md), fingerprint `src/sync/github.ts:repository-name-stable-id-disagreement`. No proposed validation was executed.

### U3 [Unconfirmed] An identical outsider comment may release an attributed mirror echo into author-restricted rules

File: `src/api/handler.ts:174`, `src/sync/github.ts:108`, `src/sync/ophash.ts:29`, `src/db/ledgers.ts:129`, `src/queue/workers.ts:151`, `src/app/issues.ts:209`, `src/app/rule-events.ts:14`, `src/rules/engine.ts:269`, `src/app/rules.ts:107`, `src/github/pr-automation.ts:512`, `src/operations/outbox.ts:558`, `src/sync/plane.ts:446`, `src/sync/mirror.ts:645`, `src/app/context.ts:111`, `src/app/mappings.ts:173`, `docs/superpowers/specs/2026-10-10-plane-github-sync-design.md:238`

Attacker: An ordinary GitHub commenter who can copy the exact body of the service's attributed mirror comment on the same linked issue; the attacker cannot forge the trusted sender.

Exploit: An ordinary GitHub commenter can copy the exact body of a service-mirrored comment on the same mapped issue. If that comment's authentic delivery is processed while the mirror reservation exists and before the actual mirror echo, it can consume the reservation. The subsequent genuine echo may then enter comment.created rules with the trusted linked author's sender identity. The claimed protected-state effect requires an explicitly configured author-restricted state-update rule that rejects the outsider's own event but accepts the escaped trusted echo. A lost outsider comment or a genuine human-authored comment triggering its intended rule is not the claimed security result. No decisive producer/consumer schedule or deployment consequence was observed.

Impact: Conditional bypass of service-echo suppression lets an author-restricted comment.created rule perform a Plane state action under a genuine trusted user's echo. A lost outsider comment alone is not the claimed security consequence.

Evidence: GitHub comment echo reservations identify side, repository/issue, field and exact body, but omit the expected sender and remote comment object identity. A distinct identical comment can consume the one-use suppression reservation intended for a service-caused comment. Authentic signatures, distinct delivery deduplication, stable sender lookup, active-link targeting and frozen mapping authorization preserve event identity and resource scope; they do not establish which comment caused the reserved outbound operation.

Source `src/sync/github.ts:42`:

```ts
  if (event === "issue_comment") return ["created", "edited"].includes(action ?? "") && typeof payload.comment?.body === "string" ? one("comment", payload.comment.body) : [];
```

Source `src/db/ledgers.ts:124`:

```ts
export async function consumeRecentOp(db: Db, opHash: string, ttlMinutes: number): Promise<boolean> {
  const res = await db.query(`
    DELETE FROM applied_ops
    WHERE ctid = (
      SELECT ctid FROM applied_ops
      WHERE op_hash = $1 AND created_at >= NOW() - INTERVAL '1 minute' * $2
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
```

Source `src/rules/engine.ts:269`:

```ts
      } else if (k === "author") {
        if (!checkConditionEqualOrInArray(v as string | string[], event.author)) {
          matchConditions = false; break;
        }
```

Context7 `/websites/github_en`, [issue_comment payload](https://docs.github.com/en/webhooks/webhook-events-and-payloads#issue_comment): The payload exposes separate comment identity and sender fields; the source hash does not retain them.

Context7 `/websites/github_en`, [Webhook troubleshooting](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks): “GitHub may deliver webhooks in a different order than the order in which the events took place.” Reordering is possible; the required actual producer/consumer schedule remains unobserved.

Context7 `/websites/github_en`, [GitHub App authentication guidance](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app): “attribute activity to both a user and your app” The lead requires a successful attributed user-token write, not an App-bot echo.

Fix: If validated, bind echo reservations to the expected stable sender and returned remote comment identity, preserving the pending-response window. Suppression must identify the service-caused operation without allowing an unrelated equal-body comment to spend its reservation.

Validation: The user prohibits target execution and fixture processing. No bounded dummy reservation-consumption, reducer-dispatch and protected-state-write schedule was independently reproduced. Documentation supports user-token attribution and potentially reordered GitHub deliveries, but the actual mirrored comment's trusted sender field and outsider-before-echo processing schedule have not been owner-observed. The claimed protected-state consequence requires a usable linked trusted author's GitHub user token, a currently authorized mapping with an active state-changing issue link, and an explicit comment.created/set_state rule whose author condition rejects the outsider while accepting that trusted author. The actual deployment configuration and write permissions are unobserved.

Detailed ordered trace, controls and bounded future validation plan: [NEEDS-VALIDATION.md](/home/claudeuser/security-audit-skill/git_plane-intergration/run-1-backend/NEEDS-VALIDATION.md), fingerprint `github-echo-content-only-reservation`. No proposed validation was executed.

### U4 [Unconfirmed] Cached state groups may let queued branch automation reopen newly terminal work

File: `src/api/handler.ts:135`, `src/queue/workers.ts:250`, `src/app/reducers.ts:20`, `src/app/push.ts:33`, `src/app/rule-events.ts:77`, `src/app/rules.ts:146`, `src/github/pr-automation.ts:520`, `src/operations/outbox.ts:558`, `src/sync/plane.ts:424`, `src/app/main.ts:152`, `src/app/context.ts:120`, `src/app/mappings.ts:173`, `tests/a8/fixes-r3.test.ts:68`

Attacker: A repository contributor who can make an eligible first nondefault branch push referencing a mapped Plane item, but has no direct Plane write permission. A legitimate administrator's separate same-ID group change is an additional prerequisite.

Exploit: A contributor with permission to push to a mapped GitHub repository, but without direct Plane write permission, can initiate configured branch.created automation for an active Plane item. If the shared Plane writer has cached the item's current state S as nonterminal, and a legitimate Plane administrator changes that same state's group to completed or cancelled before the queued update executes, the execution guard can retain the former classification and PATCH the item into distinct nonterminal target state T. This requires a valid mapping, an applicable branch rule and reference, an authorized service identity, a warm cache containing S and T, execution before cache expiry, and an administrative group change that preserves the item's current state ID. No runtime outcome was observed; this is a conditional source-grounded lead, not a demonstrated contributor-controlled reopening.

Impact: Conditional reopening of newly completed/cancelled work contrary to the explicit branch-created terminal-state guard. The contributor does not gain the ability to recategorize a Plane state; no reopening was observed.

Evidence: The execution-time skipTerminalState guard reads the current issue but classifies its state using a five-minute project-state cache. It refreshes when an ID is absent, not when an existing state's group changes. Source-visible mapping authorization and target-state validation do not refresh that current-state classification.

Source `src/sync/plane.ts:384`:

```ts
  async #statesFor(slug: string, projectId: string, refresh = false): Promise<PlaneState[]> {
    const key = `${slug}/${projectId}`;
    const hit = this.#states.get(key);
    if (hit && !refresh && Date.now() - hit.at < this.#stateCacheMs) return hit.states;
    const states = await this.#client.listStates(slug, projectId);
    this.#states.set(key, { at: Date.now(), states });
```

Source `src/sync/plane.ts:424`:

```ts
          let st = (await this.#statesFor(write.slug, write.projectId)).find((s) => s.id === stateId);
          if (!st) {
            st = (await this.#statesFor(write.slug, write.projectId, true)).find((s) => s.id === stateId);
          }
          if (!st) {
            throw unknownOrTriage(stateId, write.projectId);
          }
          if (st.group === "completed" || st.group === "cancelled") {
            await appendAudit(this.#db, {
              kind: "skipped_terminal_state",
              outcome: "skipped_terminal_state",
              workspaceSlug: write.slug,
              detail: { issueId: write.issueId, state: stateId, group: st.group },
```

Context7 `/websites/developers_plane_so`, [Update state detail](https://developers.plane.so/api-reference/state/update-state-detail): State PATCH includes group with completed/cancelled values. Pinned v1.4.2 API/app serializers permit those groups but reject triage; this lead does not rely on triage.

Fix: If validated, refresh current-state group classification when executing skipTerminalState writes, or use a trustworthy invalidation/version mechanism that guarantees fresh policy classification. Cover same-ID completed/cancelled changes as well as the existing new-ID and expiry cases.

Validation: The user's source-review-only restriction prohibits executing even a bounded offline dummy harness. No queued same-ID recategorization, resulting PATCH, skipped audit outcome, or affected dummy item has been observed. The actual deployment must permit the relevant administrator to change S into completed or cancelled while preserving the affected item's current state ID, retain the same warmed writer instance, and execute the queued intent before cache expiry without an intervening forced refresh. Documentation and retrieved pinned source support the group-update premise but do not establish that deployment schedule. The contributor needs an authentic eligible first nondefault branch push referencing the item and an enabled applicable set_state rule. The administrative recategorization is an independent prerequisite, not a capability granted to the contributor by this source path.

Detailed ordered trace, controls and bounded future validation plan: [NEEDS-VALIDATION.md](/home/claudeuser/security-audit-skill/git_plane-intergration/run-1-backend/NEEDS-VALIDATION.md), fingerprint `plane-terminal-guard-stale-state-group`. No proposed validation was executed.

### U5 [Unconfirmed] Administrator-supplied rule regexes may delay shared synchronous processing

File: `src/ui/api.ts:160`, `src/ui/validate.ts:318`, `src/ui/dry-run.ts:24`, `src/rules/engine.ts:237`, `src/ui/http.ts:35`, `src/app/rules.ts:120`, `src/github/pr-automation.ts:394`, `src/sync/dev-info.ts:174`, `src/app/main.ts:189`, `src/queue/workers.ts:312`

Attacker: An authenticated workspace administrator controlling rule-preview YAML and payload.head_branch. Separate repository push capability is needed only for the alternate stored-rule webhook path.

Exploit: A workspace administrator can supply both a branch-condition regex and its nonmatching input through the authorized rule-preview endpoint. That endpoint invokes the same synchronous evaluator used by GitHub push processing. Repository push capability and provider preservation of a branch fixture are prerequisites for the webhook variant, but are unnecessary for the preview path. Regex growth and delay to unrelated work remain unobserved.

Impact: Conditional shared-process availability delay affecting unrelated routes/workers. No timing growth, dummy callback delay, outage, or deployed containment failure was observed.

Evidence: The rules engine accepts native branch RegExp source after syntactic compilation and synchronously tests supplied branch strings without a source-visible complexity restriction, interruptible matching budget or separate processor. Authorized workspace input therefore reaches shared computational work; whether the proposed nested-quantifier fixture produces meaningful shared delay requires bounded runtime validation.

Source `src/ui/dry-run.ts:24`:

```ts
    const result = evaluate(rules, { ...(mapping ? { repo: mapping.repo, project: mapping.project } : {}), ...event });
    return { trigger: event.trigger, matched: result.matched ? { index: result.matched.index, name: result.matched.rule.name ?? null } : null, actions: result.actions };
  });
```

Source `src/rules/engine.ts:73`:

```ts
        if (key === "base_branch" || key === "head_branch") {
          if (typeof value !== "string") throw new Error(`Rule at index ${i}: ${key} must be a string`);
          try {
            cache[key] = new RegExp(value);
          } catch (err) {
            throw new Error(`Rule at index ${i}: invalid regex for ${key}`);
          }
```

Source `src/rules/engine.ts:255`:

```ts
        const regex = cache.head_branch || new RegExp(v as string);
        if (!regex.test(event.head_branch)) {
          matchConditions = false; break;
```

Context7 `/nodejs/node`, [Node technical priorities](https://github.com/nodejs/node/blob/main/doc/contributing/technical-priorities.md): “blocking the event loop will interfere with other supporting work” This explains the potential shared boundary; it does not establish growth of the proposed regex.

Context7 `/websites/bullmq_io`, [BullMQ sandboxed processors](https://docs.bullmq.io/guide/workers/sandboxed-processors): “Define a sandboxed processor in a separate file.” Reviewed workers receive function processors; the preview directly invokes the evaluator in its HTTP handler.

Context7 `/eemeli/yaml`, [YAML options](https://github.com/eemeli/yaml/blob/main/docs/03_options.md): “Prevent exponential entity expansion attacks” The YAML alias-expansion guard does not restrict administrator-supplied rule regexes.

Fix: If bounded validation establishes the effect, restrict accepted branch patterns to a safe linear matching language or evaluate them in an isolated processor with an interruptible work deadline. Bound both pattern and input sizes; request-body limits and queue concurrency do not establish a matching-time budget.

Validation: The user prohibits target execution. No bounded previewRules/evaluate timing, accepted fixture result or dummy unrelated-callback delay was observed, so superlinear growth and meaningful shared availability impact are unconfirmed. The deployed Node/V8 version, regex mitigation flags, process or tenant isolation, gateway limits and recovery behavior are unavailable. The reviewed startup shows shared processing, but actual deployment containment must be owner-observed. Safe target execution and trusted artifact promotion were not established or authorized. Source inspection alone cannot replace the resource-exhaustion skill's bounded local proof requirement.

Detailed ordered trace, controls and bounded future validation plan: [NEEDS-VALIDATION.md](/home/claudeuser/security-audit-skill/git_plane-intergration/run-1-backend/NEEDS-VALIDATION.md), fingerprint `src/rules/engine.ts:configured-branch-regexp-shared-process`. No proposed validation was executed.

## Checked and sound

These are source-reviewed controls, not executed test results.

- Raw-body signatures: `src/api/handler.ts:87` and `:174` verify unparsed payload bytes/string before JSON admission; unknown keys are refused. Plane key ownership is separately Unconfirmed above. Context7 `/websites/developers_plane_so` [Plane webhooks](https://developers.plane.so/dev-tools/intro-webhooks), `/websites/github_en` [GitHub signature guidance](https://docs.github.com/en/webhooks/using-webhooks/securing-your-webhooks), `/octokit/octokit.js` [webhook verification interface](https://github.com/octokit/octokit.js/blob/main/_autodocs/api-reference/webhooks.md).
- Ingress sizes: `src/api/handler.ts:23` caps declared and streamed bodies at 25 MiB by default, clears accumulated chunks on overflow, pauses input, responds 413 and destroys the connection after flushing. Aggregate admission remains a hardening item.
- Plane persistence: `src/api/handler.ts:117` returns a successful spool acknowledgement only after persistence; spool failure returns 503. `src/db/parity.ts`/cron replay retains original delivery IDs rather than inventing another inbound identity.
- Delivery/replay identities: `src/queue/workers.ts`, `src/db/ledgers.ts` and `src/operations/outbox.ts` combine retained delivery claims, stable Plane comment identities, immutable operation IDs and completed-result checkpoints within their retention rules. BullMQ IDs alone are insufficient once jobs are removed: Context7 `/websites/bullmq_io` [job IDs](https://docs.bullmq.io/guide/jobs/job-ids).
- Frozen local authority: `src/app/mappings.ts:173` and outbox execution/recovery recheck the exact mapping/workspace/repository/installation and current allow-list; malformed explicit authority does not fall through to legacy inference. Signing-key ownership and remote name/ID binding remain separate leads.
- Attribution: `src/auth/identity.ts` and `src/app/context.ts` resolve the authenticated sender’s stable ID, reject bot/ghost/invalid identities and do not select actor credentials from pusher or commit-author prose. Public-email ownership assurance is excluded from this positive check.
- Unlink lifecycle: workspace-qualified identity transactions, uniqueness checks and tombstones prevent routine automatic relinking or conflicting identity overwrite; retained writes use the recorded token-owner ID.
- SQL construction: the reviewed in-scope db.query census uses bound values. Variable columns/fragments come from fixed code maps and generated placeholders, not request-controlled identifiers. Migration SQL is operator-controlled. Context7 `/websites/node-postgres` [parameterized queries and identifier limitation](https://node-postgres.com/features/queries).
- Content encoding: `src/github/html.ts`, `src/sync/text.ts` and Smart Commit formatting escape emitted HTML text/attributes and restrict enriched destinations with safeUrl. Code spans and destinations remain opaque to prose enrichment. Native author-authored Markdown/mentions were not treated as privilege gains.
- Current converter bounds: `src/sync/text.ts:14`/`:120` has source/output/work/depth limits, a per-conversion lookup cap and disjoint escaped/ordinary link-label branches. The specific old overlap fingerprint is rejected; no general timing or upstream browser-sanitizer guarantee is claimed.
- Problem-comment ownership: `src/github/problems.ts` requires the expected authenticated App bot and service-derived marker before updating a report; diagnostics/count/body are bounded and emitted as code literals or escaped HTML. Smart Commit public notices do not copy raw API error bodies.
- Authenticated encryption: `src/auth/identity.ts:54` uses AES-256-GCM, random 12-byte IVs, explicit 16-byte tags, strict 32-byte key validation and authenticated finalization. Context7 `/websites/nodejs_latest-v24_x_api` [crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html): “Generates cryptographically strong pseudorandom data.” The same reference documents authenticated GCM finalization and failure on tampered ciphertext.
- Secret representations and retries: SecretString string/JSON/inspect views are redacted. The outbox stores actorUserId rather than plaintext PAT, reloads current credentials and redacts the known loaded actor from stored errors. Installed Octokit RequestError authorization redaction agrees with Context7 `/octokit/octokit.js` [error documentation](https://github.com/octokit/octokit.js/blob/main/_autodocs/errors.md); this is not a blanket guarantee for every log field.
- Credential retirement: `src/app/credentials.ts` and migration 008 persist bootstrap retirement in database/filesystem state; missing durable state fails closed rather than resurrecting retired environment credentials. User refresh credentials are encrypted and serialized by per-user locking.
- Rate-limit deadlines: GitHub primary/secondary headers feed durable cooldowns and deferred errors; maximum deadlines survive concurrency, and requestMade=false waits do not consume attempts. Context7 `/websites/github_en` [integrator guidance](https://docs.github.com/en/rest/guides/best-practices-for-integrators) supports honoring Retry-After/reset and secondary backoff. Plane header/config behavior was checked using Context7 `/websites/developers_plane_so` [API introduction](https://developers.plane.so/api-reference/introduction) plus pinned v1.4.2 rate_limit.py.
- Collection bounds: GitHub collections, Plane pagination, commit-range processing and backfill have explicit limits/completeness flags. Operations requiring a complete collection refuse incomplete reads rather than assuming absence. This does not imply aggregate fairness under every deployment load.
- Import/lifecycle isolation: migrations use transactions/advisory locking before worker startup; orphan linkback requires retained origin provenance. Live backfill’s conflict guard preserves label_sync ownership, and mirror readers require it before reference imports can become mirror partners. Context7 `/websites/postgresql_15` [advisory locks](https://www.postgresql.org/docs/15/explicit-locking.html#ADVISORY-LOCKS) documents transaction-scoped release.
- Container fragment: Dockerfile selects USER node, the PEM mount is read-only, and the reviewed compose fragment has no privileged mode, runtime socket or host-port declaration. Actual merged deployment/image/network permissions remain unverified. Context7 `/docker/docs` [Dockerfile USER](https://docs.docker.com/reference/dockerfile/#user).

## Hardening observations

These observations have no assigned severity and are not confirmed findings.

- Add cheap header rejection before body collection and explicit aggregate in-flight byte/admission limits; improve aborted-request listener cleanup. Per-request limits do not establish aggregate deployment availability.
- Validate an exact ASCII hexadecimal Plane signature before converting buffers and comparing byte lengths. Current character-length validation can reach timingSafeEqual with unequal byte lengths; the surrounding server error handling prevents an established authentication bypass. Context7 `/websites/nodejs_latest-v24_x_api` [timingSafeEqual](https://nodejs.org/docs/latest-v24.x/api/crypto.html).
- Give malformed retained Plane spool rows an explicit quarantine path. No lower-trust actor able to create the necessary persisted poison row was established.
- Qualify persisted cooldowns by App/host credential generation, and assess aggregate Plane API-key budgets when replicas share a key. Source-local limiting does not establish the unknown deployment’s global budget.
- Use explicit restrictive environment-file modes/ignore rules and reviewed container image digests. No actual checked-in credential or demonstrated lower-trust secret reader was found.
- When backfill revives a non-mirror reference, clear missing_since consistently with ordinary upserts and distinguish protected label_sync conflicts from successful linked counts. No unauthorized mutation from these bookkeeping differences was established.

## Coverage and unresolved assurance

The ledger has **20 units: 13 covered, 4 candidate units containing 5 Unconfirmed records, 1 blocked, 2 out of scope; 0 deferred or planned**. Four baseline reconnaissance roles, eight hunters across four waves, six coverage critics, six candidate verifiers and five fresh final-record verifiers ran (29 delegated invocations; no strict budget was set). Every post-wave critic ran, and a distinct final-clean critic returned no missing/reassigned units and stop=true. The known email-assurance blocker remains explicit. No prior same-source confirmations or changed-source prior findings were carried.

Automatic email bootstrap remains a **blocked assurance unit, not a vulnerability finding**. `src/app/identity.ts` links an installation-authenticated public GitHub profile email to one normalized workspace-member email, after stable sender/profile ID checks, bot rejection, uniqueness, tombstone and transactional no-overwrite controls. Retrieved documentation does not establish verified ownership of that public profile address for every eligible signed-webhook account state. No attacker account satisfying the necessary unowned-email plus eligible-webhook conjunction was demonstrated, so no takeover is claimed. Context7 `/websites/github_en`: [Get a user](https://docs.github.com/en/rest/users/users#get-a-user), [authenticated email endpoints with verified field](https://docs.github.com/en/rest/users/emails). Resolve this through documented provider assurance or owner-observed existing benign account evidence; if assurance cannot be established, require explicit identity linking with ownership proof.

Pinned Plane state-group evidence: [v1.4.2 API serializer](https://raw.githubusercontent.com/makeplane/plane/v1.4.2/apps/api/plane/api/serializers/state.py), [app serializer](https://raw.githubusercontent.com/makeplane/plane/v1.4.2/apps/api/plane/app/serializers/state.py), [state view](https://raw.githubusercontent.com/makeplane/plane/v1.4.2/apps/api/plane/api/views/state.py), checked alongside Context7 `/websites/developers_plane_so`. Current generic documentation enumerates triage, but the pinned serializers reject it; no triage-recategorization finding is retained.

## Audit artifacts and validation

Cloudflare [security-audit skill](/home/claudeuser/.claude/skills/security-audit/SKILL.md), full audit mode. External run directory: `/home/claudeuser/security-audit-skill/git_plane-intergration/run-1-backend`. It contains metadata, architecture, deterministic coverage ledger, Context7 evidence, source hashes, independent decisions and final `findings.json`, `REPORT.md`, `FINDINGS-DETAIL.md`, `NEEDS-VALIDATION.md`.

Both trusted skill validators passed: **6 findings valid; 20 coverage units valid**. Format validation is not runtime security proof. Current changed sources (`src/sync/text.ts`, `src/github/problems.ts`, `src/github/smart-commits.ts`) received fresh coverage review; candidate traces were reread against current source.

## Validation

Read-only follow-up against the current dirty tree at commit `325519c13d031c77242b3dc176ff59e2ce37d998`. The five items received fresh independent source reviews. Source files have changed since the original audit; the locations below supersede its older line numbers. The 97 reviewed-path hashes stayed unchanged during this follow-up. Only this report was edited inside the repository; no source/test edits, target-code execution, tests, typecheck, builds or probes were performed. No result from the driver’s running suite was supplied or inferred.

**RESULT: 0 CONFIRMED, 0 REFUTED, 5 STILL UNCONFIRMED.** Each source-grounded mechanism remains present; the complete protected consequence and its necessary runtime/deployment conditions have not been observed. Cloudflare’s [VALIDATION-AND-REPORTING.md](/home/claudeuser/.claude/skills/security-audit/VALIDATION-AND-REPORTING.md) allows promotion only after “independently establishing the complete path and bounded observed result.” These are distinct source observations and exploit verdicts; no severity is assigned to an unresolved item.

| Item | Verdict | Evidence still required |
|---|---|---|
| U1 — Plane signing-key ownership | STILL UNCONFIRMED | An A-owned accepted key available to a principal without B authority, plus one observed B write under the required mapping/link/policy. |
| U2 — Repository name versus stable ID | STILL UNCONFIRMED | A reclaimable historical name and same writable installation, plus one observed request into dummy replacement B while A remains authorized. |
| U3 — Content-only echo reservation | STILL UNCONFIRMED | The full outsider-consumption → genuine trusted echo → author-restricted protected action sequence. |
| U4 — Cached terminal-state group | STILL UNCONFIRMED | Same-ID group recategorization with a stale copied cache, followed by one queued dummy write or an observed preventing control. |
| U5 — Administrator-supplied regex | STILL UNCONFIRMED | Bounded matching growth and unrelated-callback delay on the relevant runtime, with shared-process applicability. |

### Validation U1 — STILL UNCONFIRMED

**Current source path:** `src/app/main.ts:68` → `src/api/handler.ts:87`/`:113` → `src/app/issues.ts:253` → `src/app/context.ts:269` → `src/sync/mirror.ts:639`/`:645` → `src/operations/outbox.ts:558` → `src/app/mappings.ts:194` → `src/sync/github.ts:199`/`:208`.

Current source `src/api/handler.ts:87`:

```ts
    const secrets = (typeof deps.planeSecret === "string" ? [deps.planeSecret] : deps.planeSecret).filter((s) => s);
    const signedBy = (secret: string) => {
      const expectedSig = createHmac("sha256", secret).update(body).digest("hex");
      return signature.length === expectedSig.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig));
    };
    if (!secrets.some(signedBy)) {
```

Current source `src/app/context.ts:269`:

```ts
  if (typeof payload?.workspace_slug === "string") return payload.workspace_slug === mapping.workspaceSlug;
```

The boolean verification still discards the matching key’s owner. A signed body claiming B supplies the project/work-item and comment content used by B’s selected mirror. The fresh project-authorization control starts with `if (side !== "plane" || !PROJECT_ADDRESSED.has(w.kind)) return;` at `src/app/mappings.ts:175`; it constrains project-addressed Plane writes and does not block this GitHub-comment sink. Active `label_sync` ownership, allowed installation, mirror direction and comments policy remain real prerequisites. Missing claims, unknown secrets, unlinked items and revoked mappings fail; those controls do not bind an accepted A key to A.

Context7 `/websites/developers_plane_so`, [Plane webhooks](https://developers.plane.so/dev-tools/intro-webhooks), documents an “HMAC-SHA256 hex digest of the raw request body, keyed with your webhook secret” and delivery of the creator’s secret as a CSV. This establishes the signing mechanism and possible legitimate key-holder prerequisite, not actual key ownership in this deployment.

**What would settle it:** after explicit execution authorization, one offline dummy A/B fixture using an A-owned admitted key and B’s allowed installation, bidirectional mapping, active label-sync issue link and permitting comments policy. Send a small create-comment body claiming B with fresh dummy IDs and an A-key signature; observe both B intent registration and one mocked B GitHub comment request. Unknown-key, mismatched-workspace and disabled-comments controls must produce no write. An independently captured equivalent artifact could supply that observation without another run. The owner must also establish who legitimately knows the accepted keys; if all holders are instance operators trusted across every served workspace, the stated lower-trust attacker is absent for that deployment. Optional victim-user attribution needs a separate linked-user fixture. Neither owner evidence nor a bounded result is presently available.

### Validation U2 — STILL UNCONFIRMED

**Current source path:** `src/app/github.ts:63` → `src/app/context.ts:129` → `src/sync/mirror.ts:645` → `src/app/issues.ts:28` → `src/operations/outbox.ts:558` → `src/app/mappings.ts:194`/`:199` → `src/sync/github.ts:124`/`:199`/`:208`.

Current source `src/app/context.ts:129`:

```ts
    id = await ctx.ghClient.installationIdFor(mapping.owner, mapping.repo);
```

Current source `src/app/mappings.ts:199`:

```ts
        if (w.installationId !== a.installationId || w.repoId !== a.repoId) throw denied();
```

Current source `src/sync/github.ts:124`:

```ts
    const repo = { owner: write.owner, repo: write.repo };
```

The final request still addresses the stored name, while authorization compares local stable IDs. Initial mapping validation at `src/ui/mapping-check.ts:70` and selected full lifecycle refresh at `src/app/context.ts:182` compare remote repository identity and can prevent the scenario. However, installation-repositories addition at `src/app/reducers.ts:43` refreshes the added IDs: replacement B’s ID does not select stale mapping A. No current final-write remote-ID comparison was found.

Context7 `/websites/github_en`, [repository renaming](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository), states that reusing the old name means “redirects to the renamed repository will no longer work.” Its [installation-token documentation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app) states that omitted repository restrictions give access to all repositories granted to the installation. Production requests `getInstallationOctokit(installationId)` at `src/app/github.ts:56`; the installation-client contract was retrieved through Context7 `/octokit/octokit.js` [App API](https://github.com/octokit/octokit.js/blob/main/_autodocs/api-reference/app.md). None of these facts establishes actual name availability, organization role or B’s grants.

**What would settle it:** an authorized offline fixture with dummy A (ID 101, historical `org/old`, installation 7), replacement B (ID 202, same name/installation), one active mirror link and a harmless genuine Plane comment. Observe the single final request while A’s mapping remains unchanged. Added-B-only refresh should retain the stale mapping for the candidate; full refresh, revocation, mismatched frozen ID and B outside the installation must prevent the request. Separately, existing owner records must establish a lower-trust creator without A read access who can reclaim the name within the same writable installation, the matching issue number and permitting mirror policy. No real rename, repository creation or comment is needed or authorized by this report.

### Validation U3 — STILL UNCONFIRMED

**Current source path:** attributed producer `src/sync/mirror.ts:645`/`:647` and `src/sync/github.ts:103`/`:206`; then distinct authentic deliveries → `src/sync/github.ts:42` → `src/sync/ophash.ts:29` → `src/db/ledgers.ts:124` → `src/queue/workers.ts:243`/`:250` → `src/app/issues.ts:209` → `src/app/rules.ts:109` → `src/rules/engine.ts:285` → `src/github/pr-automation.ts:512`/`:522` → `src/sync/plane.ts:461`.

Current source `src/sync/github.ts:42`:

```ts
  if (event === "issue_comment") return ["created", "edited"].includes(action ?? "") && typeof payload.comment?.body === "string" ? one("comment", payload.comment.body) : [];
```

Current source `src/db/ledgers.ts:129`:

```ts
      WHERE op_hash = $1 AND created_at >= NOW() - INTERVAL '1 minute' * $2
      ORDER BY created_at
      LIMIT 1
```

Current source `src/app/rules.ts:109`:

```ts
  return uniqueIssues(rows.map((r) => ({ slug: r.plane_workspace_slug, projectId: r.plane_project_id, issueId: r.plane_issue_id, tier: r.created_by === "label_sync" ? "closing" : r.tier })));
```

The hash/one-row consumer still omits sender and remote comment ID. The outsider must copy the complete generated body, including `commented in Plane`; that prefix does not block rule admission. A possible refutation was checked explicitly: mirror producers store `label_sync` links as `relation`, and `src/github/pr-automation.ts:494` rejects relation-tier state actions. The actual issue-comment route calls `linkedIssuesFor`, which converts those links to `closing` before evaluation, so this guard does not refute U3. A normal installation-bot echo fails the assumed trusted-human author condition, and a lost outsider comment alone does not prove a protected action.

Context7 `/websites/github_en`, [App token attribution](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app), says user access tokens “attribute activity to both a user and your app.” [Webhook troubleshooting](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks) says deliveries may arrive in a different order from events. Both were retrieved again; neither supplies this comment’s exact sender or the required processing schedule.

**What would settle it:** after authorization, invoke the real mirror producer with dummy linked trusted-user credentials, obtain its exact complete body and observe one reservation. Process two authentic-shaped created-comment deliveries with different comment/delivery IDs: outsider’s exact-body copy first, then the actual trusted-user mirror echo. Configure a `comment.created` rule whose author condition rejects the outsider and accepts the trusted sender, and whose action selects a distinct valid Plane state on the linked item. Confirmation needs outsider suppression followed by the matched rule and exactly one mocked protected-state PATCH. Outsider-alone, genuine-echo-first, different-body and installation-bot controls must not produce that consequence. Existing signed-delivery/audit evidence showing this complete sequence plus the actual rule/token/link grants could also settle it. No such observation was supplied.

### Validation U4 — STILL UNCONFIRMED

**Current source path:** authentic first branch push → `src/app/rules.ts:143`/`:147` → `src/github/pr-automation.ts:520`/`:522` → `src/operations/outbox.ts:306`/`:558` → shared writer `src/app/main.ts:152`/`:162` → `src/sync/plane.ts:402`/`:434`/`:439`/`:461`.

Current source `src/sync/plane.ts:402`:

```ts
    if (hit && !refresh && Date.now() - hit.at < this.#stateCacheMs) return hit.states;
```

Current source `src/sync/plane.ts:439`:

```ts
          let st = (await this.#statesFor(write.slug, write.projectId)).find((s) => s.id === stateId);
          if (!st) {
            st = (await this.#statesFor(write.slug, write.projectId, true)).find((s) => s.id === stateId);
          }
```

Fresh admission still excludes terminal groups, the immutable write preserves `skipTerminalState`, project/mapping authority is rechecked, and unknown states fail. The execution guard at `src/sync/plane.ts:446` returns without a PATCH when its selected state’s group is completed/cancelled. These controls block known terminal groups, absent-ID refresh cases and expired caches; the matching existing ID still prevents a refresh after same-ID recategorization. The existing source tests at `tests/a8/fixes-r3.test.ts:37` and `:68` cover another terminal ID and a newly added terminal ID, respectively. They were only read, and neither is the required stale same-ID fixture.

Context7 `/websites/developers_plane_so`, [state PATCH](https://developers.plane.so/api-reference/state/update-state-detail), lists completed/cancelled group updates. Pinned v1.4.2 [API serializer](https://raw.githubusercontent.com/makeplane/plane/v1.4.2/apps/api/plane/api/serializers/state.py), [app serializer](https://raw.githubusercontent.com/makeplane/plane/v1.4.2/apps/api/plane/app/serializers/state.py) and [state view](https://raw.githubusercontent.com/makeplane/plane/v1.4.2/apps/api/plane/api/views/state.py) were checked in the audit: triage is rejected. Fresh Context7 also returned v2 documentation about items staying in an edited state; that v2 statement is not substituted for this deployment’s v1.4.2 behavior.

**What would settle it:** one authorized offline dummy writer/outbox fixture. Warm the writer with fresh objects S=backlog and distinct T=started; admit/retain the guarded branch intent while the item points to S. Replace the fake upstream state list with fresh objects assigning the same S ID to completed, then separately cancelled, keeping the item’s state ID S. Execute before cache expiry and capture a PATCH to T or the skipped audit. Do not mutate the object already held by the cache, which would hide the stale-copy case. Compare expired/forced refresh, a new terminal ID, already-terminal admission, unknown state and revoked mapping. Owner evidence must establish the same-ID administrative update and shared warm-writer schedule; that administrator action is an independent prerequisite, not a contributor capability. Neither a suite pass lacking this case nor source reachability alone settles the result.

### Validation U5 — STILL UNCONFIRMED

**Current source path:** `src/ui/api.ts:734`/`:759` → `src/ui/validate.ts:316` → `src/ui/dry-run.ts:10`/`:19`/`:24` → `src/rules/engine.ts:85`/`:272` (base-branch match: `:264`).

Current source `src/rules/engine.ts:82`:

```ts
        if (key === "base_branch" || key === "head_branch") {
          if (typeof value !== "string") throw new Error(`Rule at index ${i}: ${key} must be a string`);
          try {
            cache[key] = new RegExp(value);
          } catch (err) {
            throw new Error(`Rule at index ${i}: invalid regex for ${key}`);
```

Current source `src/rules/engine.ts:271`:

```ts
        const regex = cache.head_branch || new RegExp(v as string);
        if (!regex.test(event.head_branch)) {
          matchConditions = false; break;
```

The endpoint still requires workspace-administrator authentication, matching Origin, JSON content and body/YAML size caps. The new `create_issue.project` validation at `src/rules/engine.ts:158` does not reject a rule whose action is `set_state`. Preview avoids action execution but invokes condition evaluation directly; no matching deadline or separate preview processor was found. The reviewed startup composes HTTP routes and starts workers in `src/app/main.ts:191`/`:221`; deployed process/tenant isolation and runtime regex flags remain unknown.

Context7 `/nodejs/node`, [technical priorities](https://github.com/nodejs/node/blob/main/doc/contributing/technical-priorities.md), retrieved again, states that “blocking the event loop will interfere with other supporting work.” Context7 `/websites/bullmq_io` [sandboxed processors](https://docs.bullmq.io/guide/workers/sandboxed-processors) documents separate-file processors; current workers instead receive functions at `src/queue/workers.ts:312`. These support the potential shared boundary; they do not measure this regex’s growth or prove an outage. Context7 `/eemeli/yaml` [alias protection](https://github.com/eemeli/yaml/blob/main/docs/03_options.md) does not address the proposed scalar regex, which uses no aliases.

**What would settle it:** after explicit execution authorization, an offline OS-enforced sandbox with empty allowlisted environment, read-only target/tools, scratch-only writes, 128 MiB memory, one CPU, explicit low process/file/disk bounds and a one-second wall limit. Call `previewRules` with `trigger: push`, one `head_branch: '^(a+)+$'` condition and `set_state: started`; use 8, 12, 16, 20 and 24 `a` characters followed by `!`, plus a linear-pattern control. Record acceptance, matching time and delay to a dummy unrelated callback; stop at 100 ms or the deadline and never enlarge the inputs. Do not execute an action. Owner records must establish runtime/flags, shared processing and admission/recovery limits. If those observations do not show meaningful cross-principal delay, the claimed availability consequence must be narrowed or rejected; it is not presently confirmed.

No item reached CONFIRMED, so there is no confirmed-fix patch/test prescription in this follow-up. The earlier conditional fix suggestions remain conditional. No source or test change was applied.

## Triage

The driver authorized edits and the capped named tests after the full run finished. Fixed the startup compatibility bug in `src/github/hosts.ts`: GitHub URLs permit HTTP only when the parsed hostname is `127.0.0.1`, `[::1]` or `localhost`; other GitHub hosts still require HTTPS. A loopback API origin without `/api/v3` now works as the local GitHub.com API override while browser/OAuth URLs retain their GitHub.com origin. Local GHES URLs preserve their API prefix. Existing credentials/query/fragment, malformed-path and edition-conflict checks remain enforced.

Regression cases in `tests/github/parity-g1.test.ts` cover all three loopback hosts, real environment bootstrap, local GHES inference, non-loopback/lookalike rejection, malformed URL rejection and conflicting editions. No existing assertion was removed or weakened. Context7 `/websites/nodejs_latest-v24_x_api`, [WHATWG URL documentation](https://nodejs.org/docs/latest-v24.x/api/url.html), verifies hostname versus port separation and URL canonicalization; the capped regression also checks the IPv6 result.

Verification performed:

- `NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/github/parity-g1.test.ts`: exit 0, **14 passed, 0 failed**.
- `sh scripts/heavy.sh node scripts/verify-wiring.mjs`: run exactly once, exit 0, **6 checks passed**: startup/migrations/UI/authentication, PR automation and rollup link, echo suppression, Smart Commit sender attribution, delivery deduplication and graceful shutdown.

No check failed, so no failure required code-versus-obsolete-test triage. The loopback startup issue was a code compatibility bug, fixed without changing `scripts/verify-wiring.mjs`. Validation recorded **0 confirmed backend items**, so there are no confirmed security fixes to apply; U1–U5 remain Unconfirmed. This edit/run step does not establish their missing exploit observations. No staging, commits or pushes occurred.
