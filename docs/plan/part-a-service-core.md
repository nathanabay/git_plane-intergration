# Part A: Sync Service Core Implementation Plan

### A1 Setup deployment and container
**Files:** docker-compose.override.yaml, deploy/caddy/Caddyfile, src/index.ts
**Depends:** none
**Acceptance:** The service container starts, listens on port 3100, and Caddy proxies traffic to it successfully.

Implement the core deployment structure as defined in the spec (§3). Configure a new `git-sync` container joining the `default` and `gateway` networks. Expose port 3100 and establish a single Caddy route for `/git-sync/*`. Define the incoming webhook URLs for Plane and GitHub.

### A2 Build service internals and queues
**Files:** src/queue/index.ts, src/api/handler.ts, package.json
**Depends:** A1
**Acceptance:** Incoming requests are signature-verified and placed onto BullMQ queues without synchronous processing.

Construct the TypeScript service foundation (§4). Integrate `@octokit/webhooks` for GitHub signature validation and explicitly implement HMAC-SHA256 verification of `X-Plane-Signature` for Plane webhooks. Implement `@octokit/app` for installation-token minting and refresh. Establish four separate BullMQ queues on the existing Valkey instance: `inbound:github`, `inbound:plane`, `outbound:plane`, and `outbound:github`. Ensure the HTTP request handler strictly validates signatures, enqueues the payload, and immediately responds with a 200 OK.

### A3 Implement database schemas for echo prevention
**Files:** src/db/schema.ts, src/db/migrations/001-init.sql
**Depends:** A1
**Acceptance:** The PostgreSQL migrations apply cleanly, establishing the mapping, ledger, audit, and config tables.

Design the tables required for echo-loop prevention and mapping (§5, §8). Create the `sync_links` table with `tier` and `created_by` columns to track identity. Create the `applied_ops` table to track a field-granular `op_hash` (whole-object hashing must not be used, as Plane emits webhooks per changed field). Define separate tables for delivery IDs and processed commit SHAs (§5), an orphaned status column (§1.3), the audit log (inbound deliveries, rule matches, outbound calls and results with replay) (§7.6), and the configuration tables (repo↔project mappings, state mappings, rule sets, conflict policy, per-repo toggles, and user map §9).

