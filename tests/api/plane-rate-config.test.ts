// F11 wiring: the Plane client's request budget is configurable and must match Plane's API_KEY_RATE_LIMIT.
import test from "node:test";
import { strictEqual, throws } from "node:assert/strict";
import { loadConfig } from "../../src/config/env.ts";

const base = {
  DATABASE_URL: "postgres://x", REDIS_URL: "redis://x", PLANE_BASE_URL: "http://plane", PLANE_SERVICE_PAT: "p", PLANE_WEBHOOK_SECRET: "w",
  PLANE_SERVICE_USER_ID: "service-user",
  GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY_PATH: "/k", GITHUB_WEBHOOK_SECRET: "g", GITSYNC_TOKEN_KEY: "k",
};

test("PLANE_API_RATE_PER_MINUTE defaults to 60 and takes a positive whole number", () => {
  strictEqual(loadConfig(base).PLANE_API_RATE_PER_MINUTE, 60);
  strictEqual(loadConfig({ ...base, PLANE_API_RATE_PER_MINUTE: "600" }).PLANE_API_RATE_PER_MINUTE, 600);
});

test("PLANE_API_RATE_PER_MINUTE rejects zero, fractions and text at startup", () => {
  const realExit = process.exit, realError = console.error;
  process.exit = ((code?: number) => { throw new Error(`exit ${code}`); }) as typeof process.exit;
  console.error = () => {};
  try {
    for (const bad of ["0", "1.5", "60/minute", "-3"]) throws(() => loadConfig({ ...base, PLANE_API_RATE_PER_MINUTE: bad }), /exit 1/, bad);
  } finally { process.exit = realExit; console.error = realError; }
});
