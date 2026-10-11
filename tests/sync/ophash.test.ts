import test from "node:test";
import { strictEqual, notStrictEqual, ok } from "node:assert/strict";
import { normalizeValue, opHash } from "../../src/sync/ophash.ts";

test("normalizeValue: object keys are sorted recursively", () => {
  strictEqual(normalizeValue({ b: { d: 1, c: 2 }, a: 1 }), normalizeValue({ a: 1, b: { c: 2, d: 1 } }));
});
test("normalizeValue: scalar arrays are sets, object arrays keep order", () => {
  strictEqual(normalizeValue(["b", "a"]), normalizeValue(["a", "b"]));
  notStrictEqual(normalizeValue([{ a: 1 }, { a: 2 }]), normalizeValue([{ a: 2 }, { a: 1 }]));
});
test("normalizeValue: undefined is null and strings are exact", () => {
  strictEqual(normalizeValue(undefined), normalizeValue(null));
  notStrictEqual(normalizeValue("Done"), normalizeValue("done"));
  notStrictEqual(normalizeValue("x "), normalizeValue("x"));
});
test("opHash: field, target, side and value all change the hash", () => {
  const h = opHash("plane", "t", "f", "v");
  ok(/^[0-9a-f]{64}$/.test(h));
  for (const other of [opHash("github", "t", "f", "v"), opHash("plane", "u", "f", "v"), opHash("plane", "t", "g", "v"), opHash("plane", "t", "f", "w")]) notStrictEqual(h, other);
  strictEqual(h, opHash("plane", "t", "f", "v"));
});
