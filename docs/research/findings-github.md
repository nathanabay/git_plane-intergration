# GitHub App surface + competitor gap sweep

## Part 1 — GitHub App configuration

### 1. Minimal permission set

*Note: Any time an existing GitHub App's permissions are upgraded (e.g., changing from read-only to read/write, or adding a new permission), it triggers an email notification and forces **re-consent** from the installation owner before taking effect.*

**Repository permissions:**
*   **Pull requests:** Read & Write (for reading PRs and writing PR comments) [CONFIRMED]
*   **Issues:** Read & Write (for reading issues, writing issue comments, and managing labels) [CONFIRMED]
*   **Contents:** Read & Write (for reading commits/branches and creating branches via git refs) [CONFIRMED]
*   **Checks:** Read-only (for reading check runs and check suites) [CONFIRMED]
*   **Deployments:** Read-only (for reading deployments and deployment statuses) [CONFIRMED]
*   **Administration:** Write (for creating autolink references) [CONFIRMED]
    *   *Note: This is a high-privilege permission and forces extra scrutiny.*

**Organization permissions:**
*   **Members:** Read-only (for reading organization members) [CONFIRMED]

### 2. Webhook event list

For each event, `sender.login` identifies the actor triggering the webhook.

*   `pull_request` (Affected entity: `pull_request`): `opened`, `closed`, `reopened`, `edited`, `assigned`, `unassigned`, `review_requested`, `review_request_removed`, `labeled`, `unlabeled`, `synchronize`, `ready_for_review`, `converted_to_draft`, `locked`, `unlocked`, `auto_merge_enabled`, `auto_merge_disabled`. [CONFIRMED]
*   `pull_request_review` (Affected entities: `pull_request`, `review`): `submitted`, `edited`, `dismissed`. [CONFIRMED]
*   `pull_request_review_comment` (Affected entities: `pull_request`, `comment`): `created`, `edited`, `deleted`. [CONFIRMED]
*   `push` (Affected entities: `ref`, `commits`): *No actions.* [CONFIRMED]
*   `issues` (Affected entity: `issue`): `opened`, `edited`, `deleted`, `transferred`, `pinned`, `unpinned`, `closed`, `reopened`, `assigned`, `unassigned`, `labeled`, `unlabeled`, `locked`, `unlocked`, `milestoned`, `demilestoned`. [CONFIRMED]
*   `issue_comment` (Affected entities: `issue`, `comment`): `created`, `edited`, `deleted`. [CONFIRMED]
*   `check_suite` (Affected entity: `check_suite`): `completed`, `requested`, `rerequested`. [CONFIRMED]
*   `check_run` (Affected entity: `check_run`): `created`, `completed`, `rerequested`, `requested_action`. [CONFIRMED]
*   `deployment_status` (Affected entities: `deployment_status`, `deployment`): `created`. [CONFIRMED]
*   `status` (Affected entities: `sha`, `state`, `branches`): *No actions.* [CONFIRMED]
*   `create` (Affected entities: `ref`, `ref_type`): *No actions.* [CONFIRMED]
*   `delete` (Affected entities: `ref`, `ref_type`): *No actions.* [CONFIRMED]
*   `installation` (Affected entity: `installation`): `created`, `deleted`, `suspend`, `unsuspend`, `new_permissions_accepted`. [CONFIRMED]
*   `installation_repositories` (Affected entities: `installation`, `repositories_added`, `repositories_removed`): `added`, `removed`. [CONFIRMED]

### 3. Actor identity on push

*   **Trustworthy identity:** `sender.login` carries the trustworthy identity, as it is the authenticated GitHub account that performed the API request or push. `pusher.name` and `pusher.email` are extracted directly from the unverified local Git configuration and can be easily spoofed. [CONFIRMED]
*   **Signature verification:** Commit signature verification surfaces in the `verification` object of the commit resource. This object includes `verified` (boolean), `reason` (e.g., `valid`, `bad_email`), `signature` (string), and `payload` (the signed text). [CONFIRMED]

### 4. Installation token flow

*   **Flow:** The app signs a JWT using its private key, then requests `POST /app/installations/{installation_id}/access_tokens`.
*   **Lifetime:** Installation access tokens expire exactly 1 hour (60 minutes) after creation. [CONFIRMED]
*   **Listing installations:** `GET /app/installations` authenticated with the app's JWT. [CONFIRMED]
*   **Scoping:** The token can be restricted to specific repositories by passing a `repositories` or `repository_ids` array in the creation request. [CONFIRMED]
*   **`@octokit/app` capability:** The library handles JWT signing, API requests, token generation, caching, and background regeneration automatically before the 1-hour expiration occurs. [CONFIRMED]

### 5. Rate limits

*   **Primary limits:** 5,000 requests per hour for a GitHub App installation. This scales with the installation size: for installations with more than 20 repositories, it scales by 50 requests per repository, up to a maximum of 12,500 requests per hour (15,000 for Enterprise Cloud). [CONFIRMED]
*   **Secondary limits:** GitHub enforces secondary (abuse) rate limits to prevent excess concurrent requests or high CPU operations. Exceeding this returns a `403` or `429`. [CONFIRMED]
*   **Backoff:** You must implement exponential backoff by monitoring the `x-ratelimit-reset` or `retry-after` response headers. [CONFIRMED]
*   **ETags:** Using the `ETag` in an `If-None-Match` header returns `304 Not Modified` if data is unchanged, which does **not** consume rate limit quota. [CONFIRMED]

### 6. Autolink references API

*   **Endpoint:** `POST /repos/{owner}/{repo}/autolinks` [CONFIRMED]
*   **Permission:** Requires the repository `Administration` permission (Write). [CONFIRMED]
*   **GHES availability:** Available on GitHub Enterprise Server, as well as GitHub Pro, Team, and Enterprise Cloud. [CONFIRMED]

### 7. Branch creation

*   **Endpoint:** `POST /repos/{owner}/{repo}/git/refs` [CONFIRMED]
*   **Permission:** `Contents` (Write). [CONFIRMED]
*   **When branch exists:** The API returns a `422 Unprocessable Entity` ("Reference already exists"). [CONFIRMED]

### 8. GitHub Enterprise Server differences

*   **App Auth:** The App JWT/installation token flow is identical, but pointed at the GHES API host. [CONFIRMED]
*   **API Base URL:** Shifts from `https://api.github.com` to `https://[hostname]/api/v3/`. [CONFIRMED]
*   **Webhook delivery:** Payloads include Enterprise-specific headers (e.g., `X-GitHub-Enterprise-Host`). The receiver webhook URL must be reachable from within the private network of the GHES instance. [CONFIRMED]

## Features missing from our spec

*(Note: Advanced closing keywords and DevOps data rollups were evaluated during the gap sweep but are omitted here since they are already covered in Sections 6 and 7.4 of the spec).*

### 1. Categorized Remote Links API (from Jira)
*   **What it is:** A structured way to link external artifacts to an issue using specific categorical types (e.g., `security_vulnerability`, `test_coverage`, `alert`, `feature_flag`) rather than just raw URLs or PR links.
*   **What it would take:** Expanding the Plane links schema to include a `type` enum and building a dedicated UI widget to render them clearly with identifying icons.
*   **Verdict:** **Build.** It's a low-effort, high-impact feature. Even without native deep integrations for security or feature flags, developers can manually or programmatically attach Dependabot alerts, Sentry errors, or external CI logs as categorized, first-class links.

### 2. Native Sub-issue Synchronization (from GitHub Projects v2)
*   **What it is:** GitHub is shifting away from Markdown task lists to native sub-issues (supporting deep hierarchical nesting). This would map GitHub's native sub-issues to Plane's parent-child issue structure.
*   **What it would take:** Consuming GitHub's newer GraphQL APIs for sub-issues and recursively syncing them to Plane's sub-issue schema, while handling edge cases like nesting limits.
*   **Verdict:** **Build.** Since GitHub is actively pushing native sub-issues for structural breakdown, ignoring them will cause Plane's project hierarchy to rapidly drift from GitHub's.

### 3. AI Agent Coding Sessions (from Linear)
*   **What it is:** Assigning an issue directly to an AI agent (e.g., GitHub Copilot Workspace) that spawns a cloud environment, writes code, and opens a draft PR, with progress reported into the issue timeline.
*   **What it would take:** Deep integration with Copilot/GitHub Actions APIs, establishing an "AI User" identity in Plane, and handling real-time stream updates from the agent back to Plane.
*   **Verdict:** **Cut.** High complexity and well outside the scope of a foundational GitHub sync service. Plane must focus on syncing standard developer workflows before functioning as an AI orchestrator.

### 4. Bi-directional UI Embedding (from GitLab)
*   **What it is:** The ability to view, search, and manage Plane issues directly from within the GitHub UI (e.g., embedded inside a PR view), similar to GitLab's deep Jira integration.
*   **What it would take:** Developing a GitHub Browser Extension or a GitHub App that injects custom Plane UI components into GitHub's DOM.
*   **Verdict:** **Cut.** Extremely high effort to build and maintain a UI inside a third-party DOM. The focus should be entirely on pulling GitHub data into Plane as the central source of truth.
