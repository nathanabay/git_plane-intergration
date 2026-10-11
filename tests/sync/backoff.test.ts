import test from "node:test";
import { strictEqual } from "node:assert/strict";
import { backoffMs, retryDelayMs } from "../../src/sync/backoff.ts";

const h = (o: Record<string, string>) => (n: string) => o[n];

test("backoff: doubles from 1s and caps at 60s", () => {
  strictEqual(backoffMs(0), 1000);
  strictEqual(backoffMs(2), 4000);
  strictEqual(backoffMs(20), 60000);
});
test("retryDelay: Retry-After seconds win over everything", () => {
  strictEqual(retryDelayMs(h({ "retry-after": "3", "x-ratelimit-reset": "9999999999" }), 0), 3000);
});
test("retryDelay: Retry-After accepts an HTTP date", () => {
  const now = Date.UTC(2026, 0, 1);
  strictEqual(retryDelayMs(h({ "retry-after": new Date(now + 7000).toUTCString() }), 0, { now }), 7000);
});
test("retryDelay: X-RateLimit-Reset is used when present, and GitHub needs remaining 0", () => {
  const now = 1_000_000_000_000;
  const reset = String(now / 1000 + 10);
  strictEqual(retryDelayMs(h({ "x-ratelimit-reset": reset }), 0, { now }), 10000);
  strictEqual(retryDelayMs(h({ "x-ratelimit-reset": reset }), 1, { now, resetNeedsExhausted: true }), 2000);
  strictEqual(retryDelayMs(h({ "x-ratelimit-reset": reset, "x-ratelimit-remaining": "0" }), 1, { now, resetNeedsExhausted: true }), 10000);
});
test("retryDelay: a reset in the past waits zero, not negative", () => {
  strictEqual(retryDelayMs(h({ "x-ratelimit-reset": "1" }), 0, { now: 5_000_000 }), 0);
});
