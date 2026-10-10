# Fix round 2 for leaf-1.2.1 (A2 ingress + A3 schema) — handed to a new implementer

You are taking over leaf-1.2.1 from a previous implementer (a Gemini session that hit its usage
limit). Read, in order: `.unlazy/impl/briefs/COMMON.md`, `.unlazy/impl/briefs/leaf-1.2.1.md`
(the contract), `.unlazy/impl/briefs/leaf-1.2.1-fix1.md` (already done), then this file. The code
under your OWNS is the previous implementer's; every runnable driver gate passed, but the driver's
review found the defects below, and `scripts/verify-a3-schema.mjs` now has checks that run on a
**real Postgres 15.7** (via `scripts/lib/postgres.mjs`, rootless Docker) and fail on exactly these.
Your ledger is `docs/impl/agent-gates/leaf-1.2.1.GATES.md` — keep it, extend it, and re-run it
with gate-check --approve after your final edit until ALL MET.

1. **Migrations are not atomic on a real database.** `migrate` sends `BEGIN;`, the SQL and
   `COMMIT;` as separate calls, and `createDb`'s `exec` goes through `pool.query`, so on a `pg`
   Pool they can run on different connections: a failed migration is half-applied and an idle
   connection can be left inside a transaction. PGlite has one connection, which hid it.
   Fix: give `Db` a way to run a function on one dedicated connection (e.g.
   `withConnection<T>(fn: (conn: Db) => Promise<T>): Promise<T>`; PGlite can implement it by
   calling `fn(this)` or by `transaction`), run each migration file plus its
   `schema_migrations` insert inside one transaction on that connection, and serialise
   concurrent runners with `pg_advisory_xact_lock` (or a session advisory lock held for the
   whole run) so two replicas migrating at once both succeed and each file applies once.
   `migrate(db, opts?: { dir?: string })` must accept an alternative migrations directory —
   the oracle uses it to inject a deliberately failing migration.
2. **`consumeRecentOp` races.** Two workers can pick the same `ctid`; one deletes it, the other
   gets zero rows and reports "not an echo" — exactly the echo loop §5 exists to prevent.
   Lock the candidate row: `... WHERE ctid = (SELECT ctid FROM applied_ops WHERE ... ORDER BY
   created_at LIMIT 1 FOR UPDATE SKIP LOCKED)` (or an `id` primary key with the same pattern).
   With two recorded ops and three concurrent consumers, exactly two must return true.
3. **Schema corrections** (edit `001-init.sql` directly — it has never been applied anywhere):
   - `repo_mappings.autolinks_enabled` defaults to **false** (spec §7.4: autolinks are off by
     default and need a separately consented permission).
   - `github_app_config` gains `ghe_base_url TEXT` (spec §8: optional GHE base URL).
   - `UNIQUE (mapping_id, field)` on `conflict_policies`, `UNIQUE (tier)` on `magic_words`,
     `UNIQUE (mapping_id, version)` on `rule_sets`.
   - `ON DELETE CASCADE` on the `mapping_id` foreign keys (`rule_sets`, `conflict_policies`),
     so deleting a mapping does not fail.
   - `user_map`: keep `gh_login` and `gh_id` (the stable GitHub identity) as you have them.
   Implementer B builds the config API against this final schema in the next wave, so do not
   rename any other column.
4. **Webhook handler, oversized bodies.** On exceeding `maxBodyBytes` the handler stops buffering
   but keeps reading the stream. Respond 413 and stop consuming (`req.destroy()` after the
   response is flushed, or `req.unpipe` + `resume` with a hard cap) so a client cannot stream
   gigabytes at the service. Keep the A2 oracle passing.
5. `@octokit/webhooks-methods` is now a declared dependency (the driver added it); the import
   in `handler.ts` is fine.

Add tests for 1–4 in your own suites. Same OWNS (see `.unlazy/impl/gates/leaf-1.2.1.md`): never
write outside it — the previous implementer was caught overwriting another leaf's file.
