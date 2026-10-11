# Gates: Claude review, round 3

OWNS: docs/impl/review-3.md, docs/impl/agent-gates/review-3.GATES.md

Scope: an adversarial review of all seventeen implemented tasks against the spec, with every finding located, cited and given a fix

- [x] G0: this ledger passes unlazy lint
  CHECK: node "$HOME"/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/impl/gates/leaf-1.6.3.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=868cca7f9d889a8e6a936ab7348df381c921cd1ea09bbc4777d2227d2d05e0b6; exit=0; EXPECT=matched; output-sha256=bdcb1191ef4ee27833ed653344fa9cfa9ba67bfd064878bc693cadbae3fe98d4; output-bytes=174; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G1: the review is decidable and grounded: every task has a verdict, every round-2 finding is adjudicated with a quoted line, every finding has an existing file:line, a real spec section, evidence and a fix
  CHECK: node scripts/verify-impl-review.mjs docs/impl/review-3.md docs/impl/review-2.md
  EXPECT: implementation review verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=6d4754e09a8fc6de3ade0a910dfcfea865333f5d20084a9d32d45e54db2c1a02; exit=0; EXPECT=matched; output-sha256=ff2040f11784b2782c73057e15f197b19dc861878165aafaa35ae60d75076bbf; output-bytes=104; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G2: the reviewer ran unlazy and left a fully met, checker-evidenced ledger
  CHECK: node scripts/verify-agent-unlazy.mjs docs/impl/agent-gates/review-3.GATES.md
  EXPECT: agent unlazy verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=33a99c4a1a8904c65586def5ec1c5b3f9cd6e11d3c2ead391c81c5863ff66fbe; exit=0; EXPECT=matched; output-sha256=c89c32aa56c046b3834c1838ec81dbd550a7c7d37a1d501636aef1c51267e672; output-bytes=64; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G3: the driver confirmed at least one finding by reading the code and attempted to refute at least one, recording the outcome of each
  EVIDENCE: driver confirmed F1: src/operations/outbox.ts:156-166 polls up to 30 s for each outbound write's completion inside the reducer, QueuedWritePendingError is caught nowhere in src/ (only re-exported by src/app/writers.ts), and inbound workers run with concurrency 1 (src/queue/workers.ts:254) — a Plane outage stalls and then fails GitHub deliveries. Refutation attempted on F4 and failed: src/ui/mapping-check.ts:43 accepts any repository the App can reach; nothing scopes installations to workspaces, so on a multi-workspace instance a workspace admin gains write access to every reachable repo. Review 3: 14/17 round-2 findings CLOSED, 3 STILL OPEN (F1 scope, F12 lookup unwired, F13); 18 new (4 BLOCKING, 6 MAJOR, 8 MINOR); verdict BLOCKING.
