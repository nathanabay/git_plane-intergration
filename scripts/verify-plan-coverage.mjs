#!/usr/bin/env node
// Branch oracle: proves the joined plan actually covers the spec.
// Required sections are DERIVED from the spec headings, never hardcoded,
// so adding a spec section makes this gate fail until the plan catches up.
import { readFileSync, existsSync } from "node:fs";

const SPEC = "docs/superpowers/specs/2026-10-10-plane-github-sync-design.md";
const PARTS = ["docs/plan/part-a-service-core.md", "docs/plan/part-b-github-ui.md"];
const FINAL = "docs/plan/IMPLEMENTATION_PLAN.md";
const fail = (m) => { console.error("FAIL: " + m); process.exit(1); };

for (const f of [SPEC, ...PARTS, FINAL]) if (!existsSync(f)) fail(`missing required file: ${f}`);

const spec = readFileSync(SPEC, "utf8");
const parts = PARTS.map((f) => readFileSync(f, "utf8"));
const final = readFileSync(FINAL, "utf8");

// Derive the implementable spec sections from the spec's own headings.
const all = [...spec.matchAll(/^#{2,3}\s+(\d+(?:\.\d+)?)\./gm)].map((m) => m[1]);
if (all.length < 10) fail(`spec heading parse looks wrong (${all.length} headings)`);
const CONTEXT = new Set(["1", "1.1", "1.2", "1.3", "2", "11"]); // context/research/risks, not buildable
const required = [...new Set(all)].filter((h) => !CONTEXT.has(h) && !/^7$/.test(h));
if (!required.length) fail("derived zero required sections; check derivation");

// Union of spec refs across both parts
const refs = new Set();
for (const p of parts) for (const m of p.matchAll(/§(\d+(?:\.\d+)?)/g)) refs.add(m[1]);

const uncovered = required.filter((r) => !refs.has(r));
if (uncovered.length) fail(`spec sections with no planned task: ${uncovered.join(", ")}`);

// Task ids must be globally unique across parts
const ids = [];
for (const p of parts) for (const m of p.matchAll(/^###\s+([A-Z]\d+)\b/gm)) ids.push(m[1]);
if (!ids.length) fail("no task ids found across parts");
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
if (dupes.length) fail(`duplicate task ids across parts: ${[...new Set(dupes)].join(", ")}`);

// The integrated plan must account for every authored task
const missing = ids.filter((id) => !new RegExp(`\\b${id}\\b`).test(final));
if (missing.length) fail(`integrated plan omits tasks: ${missing.join(", ")}`);

// The integrated plan must impose an order
if (!/##\s*(Sequencing|Order|Phases|Milestones)/i.test(final)) fail("integrated plan has no sequencing section");

console.log(`plan coverage verification passed (${required.length} spec sections, ${ids.length} tasks)`);
