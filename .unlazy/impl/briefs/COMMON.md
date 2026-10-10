# Rules for every implementation leaf (scope `impl`)

You are an execution leaf in an orchestrated unlazy pipeline. A driver dispatched you and will
re-execute every gate you claim. Work only inside your contract.

## Repository

Shared working tree (other agents write here concurrently, in files you do not own):

    /home/claudeuser/orca/workspaces/git_plane-intergration/seal

`cd` there first and run every command from it.

## Read before writing code

1. `docs/superpowers/specs/2026-10-10-plane-github-sync-design.md` — the source of truth. Read
   the sections your brief names in full. Implement it; do not redesign it. If you believe the
   spec is wrong, write that in your report and stop that part — do not silently diverge.
2. `docs/plan/IMPLEMENTATION_PLAN.md` and your tasks in `docs/plan/part-a-service-core.md` or
   `docs/plan/part-b-github-ui.md`. Where your brief and the plan disagree, the brief wins: the
   driver verified the brief's paths against the real upstream code.
3. `HANDOFF.md`, section "The four things most likely to be got wrong".

## Toolchain (already installed — do not change it)

- Node 24 runs `.ts` directly (type stripping). Use **erasable TypeScript only**: no `enum`, no
  `namespace`, no constructor parameter properties, no decorators. Import with explicit `.ts`
  extensions (`import { x } from "./y.ts"`), `import type` for type-only imports.
- `tsc` 7 typechecks with the strict `tsconfig.json` (`noUncheckedIndexedAccess` is on).
- Tests use `node:test` + `node:assert/strict`, files named `*.test.ts`.
- Run your typecheck with `node scripts/typecheck.mjs "<your globs>"`, tests with
  `node scripts/run-tests.mjs <min> <your test dirs>`.
- Available dependencies: `yaml` (runtime), `typescript`, `@types/node`. **Do not edit
  `package.json` or `package-lock.json` and do not run `npm install`.** If you truly need a
  dependency, stop and say so in your report.

## Ownership — hard rule

Write only the paths in your brief's OWNS list. Reading anything is fine. Do not touch
`scripts/**`, `.unlazy/**` (except reading), `package.json`, `tsconfig.json`, `.gitignore`, or
another leaf's files. The driver-owned `scripts/verify-*.mjs` oracles are the acceptance tests;
make your code pass them, never edit them.

## Git — hard rule

**Do not commit, do not stage, do not push.** Commits happen in a later wave, after the Claude
review. Never `git add -A`, never `git add -f`, never edit `.gitignore`, never `git stash`,
never `git checkout`/`reset` files you do not own.

## Unlazy — mandatory

If you are a Claude Code session, load it with the Skill tool (`unlazy`); otherwise read it
from `$HOME/.claude/skills/unlazy`. Read its `SKILL.md` and
`references/gates.md` first.

1. **Before writing code**, create your own ledger at the path your brief gives
   (`docs/impl/agent-gates/<leaf>.GATES.md`). Start it with an `OWNS:` line equal to your OWNS
   list. Include at least these runnable gates, copied exactly from your brief's "Driver gates"
   section, plus any gates of your own that sharpen your work (one observable outcome each):

       - [ ] G1: ...
         CHECK: <command>
         EXPECT: <token>
         EVIDENCE: pending

2. Lint it: `node "$HOME"/.claude/skills/unlazy/scripts/gate-lint.mjs <your ledger>` → fix
   every error.
3. Work the four passes: implement fully; reread as a domain expert and replace the cheap version
   of each part; hunt correctness, integration and security defects and fix them; polish. No
   placeholders, no TODOs, no "not implemented", no deferred remainder.
4. Verify with the real checker — hand-written evidence is detected and rejected:

       node "$HOME"/.claude/skills/unlazy/scripts/gate-check.mjs --root . --cwd . --approve <your ledger>

   Re-run until it prints `ALL MET`. For any manual gate, write concrete evidence (file:line)
   and tick its box yourself.

## Finish

Stop only when your ledger is ALL MET. Then reply with a short report: files written, gate
results, any spec disagreement, anything you could not do. Do not claim more than the gates show.
