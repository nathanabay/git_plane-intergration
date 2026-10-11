import test from "node:test";
import { strictEqual, deepStrictEqual, ok, rejects } from "node:assert/strict";
import { allLinkedPrsMerged, parseReferences, resolveReferences } from "../../src/parse/references.ts";
import type { IssueRef } from "../../src/parse/references.ts";
import { DEFAULT_MAGIC_WORDS } from "../../src/parse/magicWords.ts";
import { PlaneApiError } from "../../src/sync/plane.ts";

const ids = (r: ReturnType<typeof parseReferences>) => r.refs.map((x) => `${x.identifier}:${x.tier}`);

test("defaults: exactly the §6 table", () => {
  strictEqual(DEFAULT_MAGIC_WORDS.closing.length, 20);
  deepStrictEqual(DEFAULT_MAGIC_WORDS.non_closing, ["ref", "refs", "references", "part of", "contributes to", "toward", "towards"]);
  deepStrictEqual(DEFAULT_MAGIC_WORDS.relation, ["relates to", "related to"]);
});
test("every closing word closes, whatever its case", () => {
  for (const w of DEFAULT_MAGIC_WORDS.closing) {
    deepStrictEqual(ids(parseReferences({ body: `${w} WEB-1` })), ["WEB-1:closing"], w);
    deepStrictEqual(ids(parseReferences({ body: `${w.toUpperCase()} WEB-1` })), ["WEB-1:closing"], w);
  }
});
test("multi-word phrases need the whole phrase", () => {
  deepStrictEqual(ids(parseReferences({ body: "Part of WEB-1. Contributes   to WEB-2. Related to WEB-3" })), ["WEB-1:non_closing", "WEB-2:non_closing", "WEB-3:relation"]);
  deepStrictEqual(ids(parseReferences({ body: "of WEB-1" })), ["WEB-1:relation"]);
});
test("lists: commas, spaces, 'and', ampersand and a colon after the word", () => {
  deepStrictEqual(ids(parseReferences({ body: "Fixes: WEB-1,WEB-2, WEB-3 and WEB-4 & WEB-5 WEB-6" })).map((x) => x.split(":")[1]), Array(6).fill("closing"));
});
test("a list stops at punctuation, so the next sentence's key is not swept in", () => {
  deepStrictEqual(ids(parseReferences({ body: "Fixes WEB-1. See WEB-2" })), ["WEB-1:closing", "WEB-2:relation"]);
});
test("a magic word inside another word does not count", () => {
  deepStrictEqual(ids(parseReferences({ body: "prefix WEB-1 and suffixes WEB-2 unfixes WEB-3" })), ["WEB-1:relation", "WEB-2:relation", "WEB-3:relation"]);
});
test("branch keys are case-insensitive and closing; the identifier is upper-cased", () => {
  const r = parseReferences({ branch: "nathan/web-344-fix-login" });
  deepStrictEqual(r.refs, [{ identifier: "WEB-344", project: "WEB", sequence: 344, tier: "closing", source: "branch" }]);
});
test("branch with two keys and a prefix segment", () => {
  deepStrictEqual(ids(parseReferences({ branch: "feature/api-12-and-web-9" })), ["API-12:closing", "WEB-9:closing"]);
});
test("title keys close; body keys are relations; the strongest tier across sources wins with its source", () => {
  const r = parseReferences({ title: "Ship it (WEB-1)", body: "WEB-1 WEB-2 and refs WEB-1", commits: ["fixes WEB-2"] });
  const by = Object.fromEntries(r.refs.map((x: IssueRef) => [x.identifier, x]));
  strictEqual(by["WEB-1"]!.tier, "closing"); strictEqual(by["WEB-1"]!.source, "title");
  strictEqual(by["WEB-2"]!.tier, "closing"); strictEqual(by["WEB-2"]!.source, "commit");
  strictEqual(r.refs.length, 2);
});
test("bare lowercase keys in free text are prose, not references", () => {
  deepStrictEqual(parseReferences({ body: "step-2 of web-5", commits: ["wip web-1"] }).refs, []);
});
test("the deny-list and short projects are not keys", () => {
  deepStrictEqual(parseReferences({ body: "UTF-8 SHA-256 X-1 CVE-2024 ISO-8601 RFC-7231 A1-2" }).refs.map((x) => x.identifier), ["A1-2"]);
  deepStrictEqual(parseReferences({ branch: "fix-utf-8-bug" }).refs, []);
});
test("identifier limits: 12-character projects pass, 13 do not; sequences are plain integers", () => {
  deepStrictEqual(parseReferences({ body: "ABCDEFGHIJKL-3" }).refs.map((x) => x.identifier), ["ABCDEFGHIJKL-3"]);
  deepStrictEqual(parseReferences({ body: "ABCDEFGHIJKLM-3 WEB-1a WEB-x" }).refs.map((x) => x.identifier), []);
});
test("a key glued into a longer alphanumeric token is ignored; punctuation after a key is fine", () => {
  deepStrictEqual(parseReferences({ body: "xWEB-2 WEB-3." }).refs.map((x) => x.identifier), ["WEB-3"]);
});
test("skip and ignore remove the key from every source and list it", () => {
  const r = parseReferences({ branch: "web-7-x", title: "WEB-7 thing", body: "Skip WEB-7\nIGNORE web-8 fixes WEB-8", commits: ["closes WEB-7"] });
  deepStrictEqual(r.refs, []);
  deepStrictEqual(r.skipped, ["WEB-7", "WEB-8"]);
});
test("skip only applies in the body", () => {
  deepStrictEqual(parseReferences({ title: "skip WEB-1", body: "fixes WEB-1" }).skipped, []);
});
test("-NEW requests creation (body or title), de-duplicated, and never becomes a ref", () => {
  const r = parseReferences({ title: "QLL-NEW: feature", body: "QLL-NEW and WEB-NEW, fixes QLL-3" });
  deepStrictEqual(r.createRequests, ["QLL", "WEB"]);
  deepStrictEqual(ids(r), ["QLL-3:closing"]);
});
test("configured lists replace the defaults, including empty ones", () => {
  deepStrictEqual(ids(parseReferences({ body: "fixes WEB-1" }, { closing: [], non_closing: [], relation: [] })), ["WEB-1:relation"]);
  deepStrictEqual(ids(parseReferences({ body: "Squash and merge: WEB-1" }, { closing: ["squash and merge"], non_closing: [], relation: [] })), ["WEB-1:closing"]);
});
test("a configured word with regex characters is matched literally", () => {
  deepStrictEqual(ids(parseReferences({ body: "c++ WEB-1" }, { closing: ["c++"], non_closing: [], relation: [] })), ["WEB-1:closing"]);
});
test("a word configured in two tiers resolves to the stronger", () => {
  deepStrictEqual(ids(parseReferences({ body: "both WEB-1" }, { closing: ["both"], non_closing: ["both"], relation: [] })), ["WEB-1:closing"]);
});
test("empty input parses to nothing", () => {
  deepStrictEqual(parseReferences({}), { refs: [], skipped: [], createRequests: [] });
});
test("allLinkedPrsMerged follows §6", () => {
  strictEqual(allLinkedPrsMerged([{ state: "merged" }, { state: "open" }]), false);
  strictEqual(allLinkedPrsMerged([{ state: "merged" }, { state: "closed_unmerged" }]), true);
  strictEqual(allLinkedPrsMerged([{ state: "closed_unmerged" }]), false);
  strictEqual(allLinkedPrsMerged([]), false);
});
test("resolveReferences: found, unknown on 404, one lookup per identifier, other errors propagate", async () => {
  const asked: string[] = [];
  const client = { getIssueByIdentifier: async (_s: string, id: string) => {
    asked.push(id);
    if (id === "WEB-2") throw new PlaneApiError(404, { error: "Not found" }, "nf");
    if (id === "WEB-3") throw new PlaneApiError(500, {}, "boom");
    return { id };
  } } as any;
  const mk = (identifier: string, tier: IssueRef["tier"], source: IssueRef["source"]): IssueRef => ({ identifier, project: "WEB", sequence: 1, tier, source });
  const out = await resolveReferences(client, "ws", [mk("WEB-1", "closing", "title"), mk("WEB-1", "relation", "body"), mk("WEB-2", "closing", "title")]);
  deepStrictEqual(out.found.map((f) => f.issue.id), ["WEB-1", "WEB-1"]);
  deepStrictEqual(out.unknown.map((u) => u.identifier), ["WEB-2"]);
  deepStrictEqual(asked, ["WEB-1", "WEB-2"]);
  await rejects(resolveReferences(client, "ws", [mk("WEB-3", "closing", "title")]), /boom/);
  ok(true);
});

test("F1: resolveReferences treats 403 like 404; one ref answers 403 and the other still links", async () => {
  const asked: string[] = [];
  const client = { getIssueByIdentifier: async (_s: string, id: string) => {
    asked.push(id);
    if (id === "ZZZZ-1") throw new PlaneApiError(403, { detail: "You do not have permission" }, "forbidden");
    if (id === "WEB-2") throw new PlaneApiError(404, { error: "Not found" }, "nf");
    return { id };
  } } as any;
  const mk = (identifier: string, tier: IssueRef["tier"], source: IssueRef["source"]): IssueRef => ({
    identifier,
    project: identifier.split("-")[0]!,
    sequence: 1,
    tier,
    source,
  });
  const out = await resolveReferences(client, "ws", [
    mk("WEB-1", "closing", "title"),
    mk("ZZZZ-1", "closing", "body"),
    mk("WEB-2", "relation", "body"),
  ]);
  deepStrictEqual(out.found.map((f) => f.issue.id), ["WEB-1"]);
  deepStrictEqual(out.unknown.map((u) => u.identifier), ["ZZZZ-1", "WEB-2"]);
  strictEqual(out.statuses["ZZZZ-1"], 403);
  strictEqual(out.statuses["WEB-2"], 404);
  deepStrictEqual(asked, ["WEB-1", "ZZZZ-1", "WEB-2"]);
});

