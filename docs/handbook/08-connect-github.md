# 08 · Connect your personal GitHub account

Your Plane account tells the team who owns work. Your GitHub account tells the team who changes code. Connecting them lets git-sync recognize the same person on both sides. You still sign in to Plane and GitHub separately. The connection is an authorization for the integration to use your GitHub identity where the repository and App permissions allow it.

Before you start, an administrator should already have installed the GitHub App, connected its installation to your Plane workspace, mapped a repository to a project, and chosen the team's automation rules. Those are shared settings. Their installation and configuration instructions are in the [administrator user guide](../manual/user-guide.md). This chapter covers your personal connection after that setup is complete.

## Three connections that are easy to confuse

A **workspace** is the place containing your team's Plane projects. A **repository** is a GitHub code project. A **GitHub App installation** gives git-sync access to a selected GitHub account's repositories. Your **personal account link** identifies you within that arrangement. None of these names mean that all repositories on your GitHub account automatically become connected.

| Connection | Who manages it | What it provides |
|---|---|---|
| GitHub App installed on an organization or personal account | GitHub organization owner or account owner | Repository access for the App |
| Installation connected to a Plane workspace | Workspace administrator, sometimes with an owner's handoff | Approval for that workspace to use the installation |
| Repository mapped to a Plane project | Workspace administrator | The location and policies for sync |
| Your Plane user linked to your GitHub account | You, as a workspace member | Your identity for attribution and user mapping |

The last row is your day-one task. You do not need to create a GitHub App or copy an App private key. If someone asks you to paste the organization's webhook secret into a work item, stop and ask your administrator for the intended setup procedure. Those credentials belong in administrator configuration, not in task descriptions or screenshots.

## Find the member account screen

The actual screen is called **My GitHub account**. Its card heading repeats that name. The source is `src/ui/client/Connect.tsx`, and its member route is registered in `src/ui/client/router.ts` and `src/ui/api.ts`.

There is a navigation wrinkle in this fork of Plane: **GitHub Sync** under workspace settings is restricted to workspace administrators. The personal account page itself allows ordinary workspace members. The current fork does not add a separate member account item to Plane's native profile settings. An administrator can therefore give you the direct member-page link. For the fictional workspace in this handbook it is:

```text
https://plane.example.com/git-sync/ui/workspaces/acme/account
```

Replace `plane.example.com` with your team's Plane hostname and `acme` with the workspace slug supplied by your team. A slug is the short workspace name used in URLs. This direct link uses your existing Plane session; it is not a separate registration site.

If you are an administrator already inside GitHub Sync, the integration's own tabs include **Repositories**, **User links**, **My GitHub account**, and **Audit log**. Choose **My GitHub account**. Ordinary members can see that account page even though the other management pages require an administrator.

> **Tip:** Bookmark your member account page. It is useful later if a token expires or you change which GitHub account you use for work.

![Personal GitHub account: (1) member account tab; (2) current connection status; (3) Connect personal account.](images/53-personal-github.png)

## Connect for the first time

Start while signed in to the intended Plane workspace and to the GitHub account your team expects. Some developers have both personal and employer accounts. The username shown by GitHub during authorization is the useful check; your local git author email does not choose the linked account.

1. Open your team's **My GitHub account** link.
2. Read the connection status above the button.
3. Select **Connect personal account**.
4. Check the account shown on GitHub's authorization page.
5. Approve the GitHub App authorization.
6. Read the result on the returned Plane integration page.
7. Confirm that **GitHub account:** shows your expected username.

The successful return message is **Your personal GitHub account is connected.** If the page says **No personal GitHub account connected**, the flow has not finished. The application leaves its embedded frame for authorization, so a full-page navigation to GitHub is expected.

GitHub may show organization approval requirements according to your organization's policies. A personal link cannot grant App access to a repository that the organization's installation does not cover. If authorization completes but your repository is still unavailable, give the administrator the repository name and the exact visible error. Repeating the same authorization cannot add a missing repository to an installation.

The service stores the GitHub account's stable numeric ID as well as its current login. That distinction matters when a username changes: the link represents the account, rather than simply trusting whoever later owns an old username. You do not need to know or enter that number.

## What your connection changes

For supported changes originating in Plane, git-sync can use your GitHub user authorization to attribute activity to you and the App. Automated creation and cross-link steps can still appear under the App or service identity. If your token is absent, expired beyond recovery, or refused for the repository, the supported GitHub write path falls back to the installation identity. A bot name on a synced comment is therefore not proof that synchronization failed.

Your connection also helps the integration translate assigned people and mentions. For example, a mapped GitHub mention of `@alex-dev` can become a Plane user mention for Alex. An unmapped GitHub login becomes a profile link instead. Linking does not give Alex membership in a private Plane project or make an inaccessible GitHub repository readable in the browser.

There is a second credential on the Plane side: a personal access token, often shortened to **PAT**. A GitHub OAuth connection does not create a Plane PAT. GitHub-to-Plane automation can write as your Plane user when the integration has a stored Plane token. With no stored Plane PAT, it uses the service identity. If a stored PAT is present but Plane rejects it, the write is not automatically retried with higher service privileges. Follow your team's administrator procedure if they support personal Plane attribution; the member connection screen described here does not contain a Plane PAT entry field.

> **Warning:** A Plane PAT carries its owner's Plane permissions. Do not paste one into a commit, comment, chat screenshot, or this handbook's example commands. You never need a real token to write `WEB-42 #comment ...`.

A practical way to read attribution is to separate **who caused the event** from **which credential performed the write**. A push caused by your authenticated GitHub account can be recognized as yours, while the resulting Plane comment uses the service credential. Smart Commit comments include commit provenance so readers can still understand the source.

## Reconnect when authorization needs attention

The service attempts to refresh expiring GitHub authorization. When it cannot obtain a usable token, the account screen can show **Needs re-authorization. Reconnect your GitHub account to author changes as yourself.** It also explains that changes use the service account until you connect.

1. Open **My GitHub account**.
2. Select **Reconnect**.
3. Check the account on GitHub's authorization page.
4. Approve the authorization.
5. Confirm your username on the returned account card.

Reconnect is also the button shown for an already linked account. A stored identity row and a usable token are separate things; seeing your username alone does not guarantee the token is currently usable. Read the alert as well as the username.

## Disconnect your personal account

Disconnecting your account is a personal action. The workspace's separate **Disconnect** button on an organization card disables that installation's mappings; that is an administrator action with a different effect.

1. Open **My GitHub account**.
2. Select **Disconnect personal account**.
3. Read the confirmation about service-account writes.
4. Confirm the disconnect.
5. Check that the personal account card is no longer connected.

The service attempts to revoke the GitHub authorization and removes its locally stored GitHub token even if remote revocation fails. It removes your user link in this workspace and records your choice so automatic email matching does not immediately link you again. The current implementation stores GitHub tokens per Plane user, so removing that token also stops personal GitHub attribution in other workspaces until you authorize again. Your stored Plane PAT, if your team configured one, is separate and is retained by this personal GitHub disconnect.

Existing branches, commits, pull requests, and comments are not deleted. Repository mappings also remain. Subsequent supported writes can use the service account. If your intention is to stop the team's entire repository integration, ask a workspace administrator; disconnecting your personal account does not accomplish that.

## Read connection errors without guessing

| Message or symptom | Meaning and next step |
|---|---|
| Button disabled; App OAuth credentials are missing | An instance administrator must configure the App client ID and secret |
| Connection link expired, already used, or belongs to another Plane account | Start from **Connect personal account** again in the intended Plane session |
| GitHub authorization was declined | Start again when ready to approve |
| GitHub account already linked to another member | Ask an administrator to investigate the existing identity link |
| Authorization exchange could not complete | Restart once; report repeated failures with the visible message |
| Workspace membership required | Sign in to the intended workspace or ask for membership |
| Personal link succeeds but repository access fails | Ask the administrator to check installation coverage and mapping health |

An administrator's **User links** page can also hold manually configured identity links. That is not a reason to try random accounts until one works. Give the administrator your intended GitHub username and workspace name. They can verify the mapping without receiving your GitHub password.

## A first connection example

Alex joins the `acme` workspace and receives the member account URL. The card initially says no personal account is connected. Alex selects **Connect personal account**, checks that GitHub is authorizing `alex-dev`, and approves. Back in Plane, the card displays `alex-dev`. Later, Sam reviews Alex's PR. Sam needs their own link; Alex's connection does not map the entire team.

Alex then writes a new comment on a mirrored Plane work item. If the repository and authorization allow it, the GitHub copy can be attributed through Alex's user authorization. A separately generated linkback comment may still come from the App. This is expected. The daily check is whether the correct work item, repository, and content are connected, with attribution interpreted according to the available credentials.

Implementation references for this chapter: `src/ui/client/Connect.tsx`, `src/ui/client/Workspace.tsx`, `src/ui/oauth-flow.ts`, `src/ui/install-flow.ts`, `src/auth/identity.ts`, `src/ui/api.ts`, and `apps/web/git-sync.patch`.


The member route, disconnected card and connection controls were verified in the running interface. Successful interactive GitHub OAuth authorization and subsequent disconnect were not exercised during capture; their steps above follow the current client and server implementation.
