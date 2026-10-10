#!/usr/bin/env node
// Proves a dispatched agent genuinely ran the unlazy discipline on its own work:
// a parsable ledger, real gates, every box checked, and machine-written evidence
// that only gate-check.mjs produces. Prose evidence fails.
import { readFileSync, existsSync } from "node:fs";

const ledger = process.argv[2];
const fail = (m) => { console.error("FAIL: " + m); process.exit(1); };
if (!ledger) fail("usage: verify-agent-unlazy.mjs <ledger-path>");
if (!existsSync(ledger)) fail(`agent produced no unlazy ledger at ${ledger}`);

const t = readFileSync(ledger, "utf8");
// Strip fenced code blocks so documentation examples are not parsed as gates.
const body = t.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, "");

const gates = [...body.matchAll(/^- \[([ xX])\]\s+([A-Za-z0-9._-]+):\s*(.+)$/gm)];
if (gates.length < 2) fail(`ledger has ${gates.length} gate(s); an agent ledger needs at least 2 real outcomes`);

const ids = gates.map((g) => g[2]);
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
if (dupes.length) fail(`duplicate gate ids: ${[...new Set(dupes)].join(", ")}`);

const unchecked = gates.filter((g) => g[1] === " ").map((g) => g[2]);
if (unchecked.length) fail(`agent returned with unmet gates: ${unchecked.join(", ")}`);

if (/^ABANDON:/m.test(body)) {
  const r = body.match(/^ABANDON:\s*(\S+)\s+(.+)$/m);
  fail(`agent abandoned gate ${r?.[1] ?? "?"} - handoff required, not completion`);
}

// Per-gate attributes, scoped to each gate's own block
const blocks = body.split(/^- \[[ xX]\]\s+/m).slice(1);
let runnable = 0;
for (const b of blocks) {
  const id = b.match(/^([A-Za-z0-9._-]+):/)?.[1] ?? "?";
  const hasCheck = /^\s+CHECK:/m.test(b);
  const hasExpect = /^\s+EXPECT:/m.test(b);
  if (hasCheck !== hasExpect) fail(`gate ${id} is a partial runnable gate (CHECK/EXPECT mismatch)`);
  const ev = b.match(/^\s+EVIDENCE:\s*(.+)$/m)?.[1]?.trim() ?? "";
  if (!ev || /^pending$/i.test(ev)) fail(`gate ${id} has no evidence`);
  if (hasCheck) {
    runnable++;
    if (!ev.startsWith("automatic-evidence=v1")) {
      fail(`gate ${id} is runnable but its evidence is not machine-written by gate-check (got: ${ev.slice(0, 40)})`);
    }
    if (!/exit=0/.test(ev) || !/EXPECT=matched/.test(ev)) fail(`gate ${id} evidence does not record a passing run`);
    if (!/definition-sha256=[0-9a-f]{64}/.test(ev)) fail(`gate ${id} evidence lacks a valid definition digest`);
  }
}
if (runnable < 1) fail("agent ledger has no runnable gate; prose with checkboxes is not unlazy");

console.log(`agent unlazy verification passed (${gates.length} gates, ${runnable} runnable, all met)`);
