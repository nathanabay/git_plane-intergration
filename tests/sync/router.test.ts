import test from "node:test";
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { EventRouter } from "../../src/sync/router.ts";
import type { InboundJob } from "../../src/queue/index.ts";

const job = (source: "plane" | "github", event: string): InboundJob => ({ source, event, deliveryId: "d", receivedAt: "", payload: {} });

test("router: exact event wins over wildcard and does not run both", async () => {
  const r = new EventRouter(); const seen: string[] = [];
  r.on("plane", "*", async () => { seen.push("star"); });
  r.on("plane", "issue", async () => { seen.push("issue"); });
  strictEqual(await r.dispatch(job("plane", "issue")), "routed");
  strictEqual(await r.dispatch(job("plane", "cycle")), "routed");
  deepStrictEqual(seen, ["issue", "star"]);
});
test("router: sources are separate namespaces and unmatched is unhandled", async () => {
  const r = new EventRouter();
  r.on("github", "push", async () => {});
  strictEqual(await r.dispatch(job("plane", "push")), "unhandled");
});
test("router: several reducers for one event run in order, and a failure propagates", async () => {
  const r = new EventRouter(); const seen: number[] = [];
  r.on("github", "issues", async () => { seen.push(1); });
  r.on("github", "issues", async () => { seen.push(2); throw new Error("boom"); });
  r.on("github", "issues", async () => { seen.push(3); });
  await r.dispatch(job("github", "issues")).then(() => { throw new Error("expected rejection"); }, (e) => strictEqual(e.message, "boom"));
  deepStrictEqual(seen, [1, 2]);
});
