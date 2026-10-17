# 22 · Register the GitHub App

git-sync talks to GitHub as a **GitHub App**: a named integration with an explicit list of permissions and events. You register it *once per instance* on the GitHub account or organization that will own it. Then you install it on the repositories you want to sync. This chapter covers registration and the six values you copy into God mode. Installation and connection to a workspace are in chapter 24.

> **Note:** No GitHub session was available when this manual was produced, so GitHub's own forms are shown as *Illustrations* plus placeholders for real screenshots. The values and choices below come from the code (`src/ui/setup-check.ts`, `src/github/hosts.ts`) and the runbook.

## Three different things on GitHub

| Thing | What it is | Where you do it |
|---|---|---|
| **Register** the App | Create the App definition: name, URLs, permissions, events, keys | GitHub **Settings → Developer settings → GitHub Apps → New GitHub App** (for an organization: the organization's settings) |
| **Install** the App | Give the App access to an account's repositories | From git-sync's **Connect GitHub** button (chapter 24) or the App's public page |
| **Authorize** your personal account | Let git-sync know who you are on GitHub | **Connect personal account** in git-sync (chapter 8) |

## Before you start

- Your Plane public address, for example `https://plane.example.com`. Use the address people actually visit, with no trailing path and no invented port.
- Permission to create a GitHub App on the owning account or organization.
- A private shell where you can create a random secret:

```bash
openssl rand -hex 32
```

Keep the output private. It is the **webhook secret**, and you will enter it on GitHub and in God mode.

## Register the App

### Goal: a GitHub App with git-sync's URLs, permissions and events

[[SCREENSHOT NEEDED: gh-01-new-app-form — GitHub's New GitHub App form (organization settings → Developer settings → GitHub Apps → New GitHub App), filled with the values below, not submitted, Client ID/slug masked. Capture later with npm run manual:capture -- --only gh-01-new-app-form]]

![Illustration: the three public endpoints on GitHub's App form — OAuth callback, setup URL and webhook URL.](../diagrams/github-app-urls.svg)

**Steps**

1. Open **New GitHub App** on the owning account or organization.
2. Fill in **General**:

| Field | Value | Why |
|---|---|---|
| GitHub App name | A unique, recognizable name, e.g. `Acme Plane Sync` | Shown on installations and on comments the App posts (`<slug>[bot]`) |
| Homepage URL | `https://plane.example.com` | Where the integration is used |
| **Callback URL** | `https://plane.example.com/git-sync/oauth/github/callback` | Returns people after **Connect personal account** |
| Expire user authorization tokens | Leave on (GitHub's default) | git-sync stores expiry and refreshes tokens; a failed refresh asks the member to **Reconnect** |
| Request user authorization (OAuth) during installation | **Off** | When on, GitHub hides the Setup URL and sends installers to the OAuth callback instead |
| Enable Device Flow | Off | Not used |
| **Setup URL** | `https://plane.example.com/git-sync/install/github/callback` | Returns an App installation to the right Plane workspace |
| **Redirect on update** | **On** | Returns to git-sync after someone changes the installation's repository selection |

3. Fill in **Webhook**:

| Field | Value |
|---|---|
| Active | On |
| **Webhook URL** | `https://plane.example.com/git-sync/webhooks/github` |
| Webhook secret | The value from `openssl rand -hex 32` |
| SSL verification | Enabled |

4. Set **Permissions** exactly as below. git-sync's setup check compares the App registration against this list (`REQUIRED_APP_PERMISSIONS`):

| Scope | Permission | Access | Why git-sync needs it |
|---|---|---|---|
| Repository | **Pull requests** | Read and write | Read PR lifecycle; post link-back comments on PRs |
| Repository | **Issues** | Read and write | Mirror issues: fields, labels, assignees, comments |
| Repository | **Contents** | Read and write | Read commits and branches; **Create branch** from the Development panel |
| Repository | **Checks** | Read | Build results (check suites and runs) |
| Repository | **Commit statuses** | Read | Combined status (ready for merge) and the `status` event |
| Repository | **Deployments** | Read | Deployment results and preview URLs |
| Repository | **Metadata** | Read | Repository identity and installation checks (always required by GitHub) |
| Organization | **Members** | Read | Prove an organization owner/admin when connecting an organization installation |

   **Checks** and **Commit statuses** are separate permissions; choosing one does not grant the other. Leave everything else at *No access*.

   > **Note:** The runbook also lists *Administration: Read and write* for GitHub autolink references. The mapping form shows **GitHub autolink references (unavailable)** in this release, so do not grant it.

5. Under **Subscribe to events**, tick these nine events (`REQUIRED_APP_EVENTS`):

| Event on GitHub's form | git-sync uses it for |
|---|---|
| **Pull request** | Linking, lifecycle rules, Development panel |
| **Pull request review** | Review badges, approved / changes requested, ready for merge |
| **Push** | Smart Commits, branch created, branch links |
| **Issues** | Issue mirroring |
| **Issue comment** | Mirrored comments |
| **Check suite** | Build status, ready for merge |
| **Check run** | Build status |
| **Status** | Commit status (legacy CI) |
| **Deployment status** | Deployments and previews |

   `installation` and `installation_repositories` events arrive automatically; you cannot and need not tick them.

![Illustration: the required permissions and nine event subscriptions.](../diagrams/github-app-permissions.svg)

6. *Where can this GitHub App be installed?*
   - Choose *Only on this account* if all repositories belong to the App's owner.
   - Choose *Any account* if other accounts or organizations will install it.
   - This choice does not grant access to any repository by itself.

7. Select **Create GitHub App**.

[[SCREENSHOT NEEDED: gh-02-app-permissions — the created App's "Permissions & events" page showing the eight permissions and nine events, secrets/IDs masked. Capture later with npm run manual:capture -- --only gh-02-app-permissions]]

**Result:** GitHub shows the App's settings page.

## Collect the six values

On the App's settings page:

| Value | Where on GitHub | Looks like | Goes to God mode field |
|---|---|---|---|
| **App ID** | "About" section | A number, e.g. `1234567` | **App ID** |
| **Client ID** | "About" section | Text starting with `Iv` on GitHub.com (an OAuth App's `Ov…` ID is the wrong kind of registration) | **OAuth client ID** |
| **App slug** | The last part of the App's public link `https://github.com/apps/<slug>` | e.g. `acme-plane-sync` | **App slug** |
| **Client secret** | *Generate a new client secret* | Shown once | **OAuth client secret** |
| **Private key** | *Generate a private key* — a `.pem` file downloads | `-----BEGIN RSA PRIVATE KEY-----…` | **Private key (PEM)** (paste the file's contents) |
| **Webhook secret** | You generated it | 64 hex characters | **Webhook secret** |

The App ID and the Client ID are different values and cannot be swapped. The slug is a URL name, not the numeric ID.

| Secret | Authenticates |
|---|---|
| Private key | The App itself (JWT and installation tokens) |
| Client secret | Personal account authorization (OAuth code exchange) |
| Webhook secret | Incoming GitHub events |

Keep all three private. If GitHub no longer shows a secret, generate a new one rather than trying to recover it.

Next: enter the values in God mode (chapter 23, "Enter the GitHub App").

## GitHub Enterprise

The same three git-sync URLs are used with GitHub Enterprise. Register the App *on that GitHub host*: a GitHub.com App cannot be installed on an unrelated Enterprise Server.

| Edition (God mode **GitHub edition**) | Extra field | API base | Web/OAuth/install origin |
|---|---|---|---|
| **GitHub.com** | — | `https://api.github.com` | `https://github.com` |
| **Enterprise Cloud with data residency** | **Enterprise Cloud subdomain**, e.g. `octocorp` ("The enterprise name before .ghe.com.") | `https://api.octocorp.ghe.com` | `https://octocorp.ghe.com` |
| **Enterprise Server** | **Enterprise Server URL**, e.g. `https://ghe.example.com` | `https://ghe.example.com/api/v3` | `https://ghe.example.com` |

## Changing the App later

- **Permissions or events changed on GitHub:** existing installations must accept the new permissions (GitHub asks the owner). God mode's **App permissions** check reads the *registration*, not the installation's acceptance. Ask owners to approve, then press **Refresh connection** in the workspace.
- **A new private key, client secret or webhook secret:** save it in God mode with the other secret fields left empty. For the webhook secret, change GitHub and God mode close together, then redeliver any failed deliveries from **Advanced → Recent deliveries** (chapter 29).
- *A different App* (new App ID): personal tokens issued for the old App no longer work. Every member must **Reconnect**, and installations must be connected again.

## If it went wrong

| Symptom | Cause | Fix |
|---|---|---|
| GitHub: `redirect_uri is not associated with this application` | Callback URL differs from `<PUBLIC_ORIGIN>/git-sync/oauth/github/callback`, or wrong Client ID | Compare character by character; use the App's Client ID |
| The Setup URL field is greyed out | **Request user authorization (OAuth) during installation** is on | Turn it off, then enter the Setup URL and **Redirect on update** |
| God mode **App permissions: Needs attention** — "The App registration is missing required permission levels…" | A permission missing or too low | Fix the permissions table, then owners approve |
| God mode **App webhook events: Needs attention** — "Subscribe the App to the missing webhook events." | An event not ticked | Tick all nine |
| **Signed GitHub deliveries: Not verified** | No GitHub event received yet, or wrong webhook URL/secret | Make a PR change; check **Advanced → Recent deliveries** on GitHub for 401/404 |
| Deliveries show `401` on GitHub | Webhook secret differs between GitHub and God mode | Save the same secret in both; redeliver |
| Deliveries show `503` | git-sync cannot decrypt its stored secret | See chapter 30, "Credentials cannot be decrypted" |

## What you learned

- Register once, install per account, authorize per person — three separate GitHub steps.
- The three URLs: `/git-sync/oauth/github/callback`, `/git-sync/install/github/callback` (with **Redirect on update**), `/git-sync/webhooks/github`.
- Eight permissions (PRs, Issues, Contents read/write; Checks, Commit statuses, Deployments, Metadata read; Organization Members read) and nine events.
- Six values go to God mode: App ID, Client ID, slug, client secret, private key, webhook secret.

## Source files

- `src/ui/setup-check.ts` — `REQUIRED_APP_PERMISSIONS`, `REQUIRED_APP_EVENTS`
- `src/github/hosts.ts` — editions and derived URLs
- `src/ui/oauth-flow.ts`, `src/ui/install-flow.ts` — callback handlers
- `deploy/APPLY.md` — "GitHub App registration"
