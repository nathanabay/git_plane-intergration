# Fix round 1 for leaf-1.1.1 (driver re-verification found defects)

Same contract, same OWNS, same rules as `.unlazy/impl/briefs/COMMON.md` and
`.unlazy/impl/briefs/leaf-1.1.1.md`. The driver re-ran your gates and reviewed the code. Your
runnable gates passed, but the review found the defects below. The driver strengthened
`scripts/verify-a1-deploy.mjs` and `scripts/verify-rules-contract.mjs` so each defect now fails a
gate. Read both scripts again, fix every item, add tests for each fix, then re-run your ledger with
`gate-check --approve` until ALL MET. Do not edit the scripts.

1. **Stray file outside your OWNS:** `test-main.ts` at the repo root. Delete it. Never write
   outside OWNS — use your scratch directory or /tmp for experiments.
2. **Hard-coded database password.** `000-create-database.sql` creates role `gitsync` with
   password `gitsync`, and the env example repeats it in `DATABASE_URL`. Read the password from a
   psql variable (`psql -v gitsync_password=...`, used via `format('... PASSWORD %L', :'gitsync_password')`
   with `\gexec`). In APPLY.md generate it (e.g. `openssl rand -base64 32`) and carry it into
   `git-sync.env`. The env example must show a placeholder, not a usable password.
3. **Wrong Postgres superuser in APPLY.md.** Plane's database superuser is
   `${POSTGRES_USER:-plane}` (see the `x-db-env` anchor in `scripts/fixtures/plane-compose.v1.4.2.yml`),
   not `postgres`. Use the value from `/root/plane/plane.env`, defaulting to `plane`.
4. **The GitHub App private key never reaches the container.** `GITHUB_PRIVATE_KEY_PATH` points at
   a file nothing mounts. Add a read-only bind mount to the `git-sync` service (for example host
   `./git-sync/github-app.pem` → container `/run/secrets/github-app.pem`, `read_only: true`), set
   `GITHUB_PRIVATE_KEY_PATH` to the container path in the env example, and add an APPLY.md step
   that places the key with permissions readable by the container's `node` user (uid 1000) and by
   nobody else.
5. **APPLY.md ordering.** It never builds the fork images, yet `docker compose up -d` applies the
   `admin`/`web` overrides that need them. Add an explicit step running
   `apps/admin/build-fork-image.sh` and `apps/web/build-fork-image.sh` (Part B owns those
   scripts) **before** the compose step, and say how to verify both tags exist
   (`docker image inspect`).
6. **Caddy reload** assumes a compose service named `caddy` in `/root/caddy`. That is not a verified
   fact. Write `caddy validate` before reload and show the reload for the two common shapes
   (containerised and systemd), telling the operator to use whichever matches the host.
7. **Rule engine: unknown top-level rule keys are silently ignored.** A typo such as `iff:` turns a
   conditional rule into one that matches every event — the opposite of the loud failure §7.2/§7.5
   require. Reject any key other than `name`, `when`, `if`, `then`; `name` must be a string.
8. **Rule engine: family members are not validated.** `issue.` and `issue.Opened Now` are accepted.
   A concrete family member must be `<family>.<word>` with word matching `^[a-z_]+$`.
9. Compile each condition regex once at parse time instead of on every evaluation (keep the
   returned rules JSON-identical, e.g. a non-enumerable cache or a WeakMap).
