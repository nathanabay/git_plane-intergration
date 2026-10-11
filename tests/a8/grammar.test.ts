// Spec §7.2 grammar: `<ignored> KEY… <ignored> #command args`, one line per command.
import test from "node:test";
import { strictEqual, deepStrictEqual, throws } from "node:assert/strict";
import { durationToMinutes, parseSmartCommits, resolveTransition } from "../../src/github/smart-commits.ts";
import { STATES } from "./harness.ts";

test("one key, one comment command", () => {
  const [c] = parseSmartCommits("QLL-34 #comment corrected indent issue");
  deepStrictEqual(c!.keys, ["QLL-34"]);
  strictEqual(c!.comment, "corrected indent issue");
});

test("text before the key is ignored", () => {
  const [c] = parseSmartCommits("fix the thing, see QLL-34 for background #done");
  deepStrictEqual(c!.keys, ["QLL-34"]);
  deepStrictEqual(c!.transitions, ["done"]);
});

test("several keys on a line all receive the line's commands", () => {
  const [c] = parseSmartCommits("QLL-1 QLL-2 API-3 #done #time 2d 5h #comment shipped");
  deepStrictEqual(c!.keys, ["QLL-1", "QLL-2", "API-3"]);
  deepStrictEqual(c!.transitions, ["done"]);
  strictEqual(c!.time?.minutes, 2 * 480 + 5 * 60);
  strictEqual(c!.comment, "shipped");
});

test("several commands: a transition, time and comment combine", () => {
  const [c] = parseSmartCommits("QLL-90 #in-review #time 1w 2d 4h 30m logged #comment fixed today");
  deepStrictEqual(c!.transitions, ["in-review"]);
  strictEqual(c!.time?.minutes, 5 * 480 + 2 * 480 + 4 * 60 + 30);
  strictEqual(c!.comment, "fixed today");
});

test("a command never spans lines: each line needs its own key", () => {
  const out = parseSmartCommits("QLL-1 #done\n#comment orphaned line\nQLL-2 #comment second");
  deepStrictEqual(out.map((c) => c.keys), [["QLL-1"], ["QLL-2"]]);
  strictEqual(out[0]!.comment, undefined);
});

test("a key or #tag inside a comment stays text", () => {
  const [c] = parseSmartCommits("QLL-1 #comment follows QLL-2 and #done later");
  deepStrictEqual(c!.keys, ["QLL-1"]);
  deepStrictEqual(c!.transitions, []);
  strictEqual(c!.comment, "follows QLL-2 and #done later");
});

test("decimals are allowed in durations and the units follow Jira (1w = 5d, 1d = 8h)", () => {
  strictEqual(durationToMinutes("1.5h"), 90);
  strictEqual(durationToMinutes("1w"), 2400);
  strictEqual(durationToMinutes("1d 1h 1m"), 541);
});

test("malformed durations are rejected, never guessed", () => {
  throws(() => durationToMinutes(""));
  throws(() => durationToMinutes("soon"));
  throws(() => durationToMinutes("2d banana"));
});

test("malformed commands are reported on the entry and nothing is invented", () => {
  const [a] = parseSmartCommits("QLL-1 #time lots");
  strictEqual(a!.time, undefined);
  strictEqual(a!.errors?.length, 1);
  const [b] = parseSmartCommits("QLL-1 #comment");
  strictEqual(b!.comment, undefined);
  strictEqual(b!.errors?.[0], "#comment has no text");
});

test("lines without a key or without a command produce nothing", () => {
  deepStrictEqual(parseSmartCommits("no key here #done"), []);
  deepStrictEqual(parseSmartCommits("QLL-1 just a mention"), []);
  deepStrictEqual(parseSmartCommits(""), []);
  deepStrictEqual(parseSmartCommits("# heading QLL-1"), []);
});

test("CRLF messages parse like LF ones", () => {
  deepStrictEqual(parseSmartCommits("QLL-1 #done\r\nQLL-2 #comment hi").map((c) => c.keys), [["QLL-1"], ["QLL-2"]]);
});

test("transitions: spaces become hyphens, matching is exact before it is fuzzy", () => {
  deepStrictEqual(resolveTransition(STATES, "in-progress"), { ok: true, stateId: "s-prog" });
  deepStrictEqual(resolveTransition(STATES, "In-Review"), { ok: true, stateId: "s-review" });
  deepStrictEqual(resolveTransition(STATES, "done"), { ok: true, stateId: "s-done" });
});

test("transitions: an unknown token and an ambiguous prefix both fail loudly", () => {
  deepStrictEqual(resolveTransition(STATES, "shipped"), { ok: false, reason: "not_found" });
  deepStrictEqual(resolveTransition([{ id: "a", name: "In Review", group: "started" }, { id: "b", name: "In Progress", group: "started" }], "in"), { ok: false, reason: "ambiguous" });
});
