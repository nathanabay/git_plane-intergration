# 03 · Finding your way

Plane has two scales of navigation. **Workspace navigation** takes you to places that span the whole team: Home, Your work, Drafts, the inbox and the list of projects. **Project navigation** takes you to the work, plans and documents inside one project. Knowing which scale you are on prevents a common first-day mistake: looking for an item in a view that belongs to another project.

## 3.1 Read the screen from the outside in

- The **workspace switcher** at the top left names the current workspace.
- The **sidebar** holds Home, Drafts, Your work and the workspace's projects. Expanding a project shows its enabled features: Work items, Cycles, Modules, Views, Pages and Intake.
- The **main area** shows the selected page.
- The *top-right controls* include the inbox, help and your avatar.

![Screenshot (test Plane): Home: (1) sidebar Home; (2) Quicklinks; (3) Recents.](../images/handbook/06-home.png)

### Goal: get oriented from Home

**Steps**

1. Check the workspace name at the top left.
2. Select **Home** in the sidebar. ①
3. Look at **Quicklinks** ② and **Recents** ③.
4. Before opening a recent item, check its project and identifier.

**Result:** you can jump back to what you were last working on.

Home is a convenient starting point, but it is not a complete list of your unfinished work, and your widgets can differ from a teammate's. Use **Your work** or a project view when you need a deliberate list.

**Quicklinks** keep useful destinations close at hand. A **sticky** is a personal note. Keep durable task information and acceptance criteria in a shared work item, not in a personal note that nobody else can find.

## 3.2 Switch workspace carefully

### Goal: make sure you are in the right workspace before creating anything

**Steps**

1. Select the workspace switcher. ①
2. Check which workspace is selected.
3. Choose the workspace you need.

![Screenshot (test Plane): Workspace switcher: (1) current workspace control; (2) Settings; (3) Workspace invites.](../images/handbook/09-workspace-switcher.png)

**Result:** the sidebar now shows the projects of the chosen workspace.

The same menu leads to workspace **Settings** ② and **Workspace invites** ③. Creating a new workspace makes a separate team area; it does not fix a missing project invitation. If you are in the wrong workspace, switch back before you create a work item.

> **Note:** An identifier such as `WEB-42` is only meaningful inside its own workspace. git-sync also resolves keys only inside the workspace that a repository is mapped to. The same key typed against a repository mapped to another workspace refers to a different item, or to none.

> **Admin only:** In a workspace's **Settings**, workspace administrators see a **GitHub Sync** entry. Ordinary members do not, so they reach their personal GitHub page through a direct link instead (chapter 8).

## 3.3 Find Your work and the project list

**Your work** is a personal page. It shows work related to you, such as items assigned to you, created by you or that you subscribed to, without scanning every project. Its filters can hide items, so check the selected category and filters before concluding that nothing is assigned to you.

### Goal: see the work assigned to you

**Steps**

1. Select **Your work** in the sidebar.
2. Check the selected category, for example **Assigned**. ①
3. Check the **Display** controls and filters. ③
4. Open the item you want, here `WEB-42`. ②

![Screenshot (test Plane): Your work: (1) Assigned category; (2) matching item WEB-42; (3) Display controls.](../images/handbook/10-your-work.png)

**Result:** you see your assigned items across projects.

### Goal: open a project's work items

**Steps**

1. Select **Projects** under the workspace.
2. Find **Website** and open it.
3. Select **Work items** in its expanded navigation.

**Result:** you see the project's work items in its current layout (chapter 5).

A project administrator can turn off optional features. If **Cycles** or **Intake** is missing from a project's navigation, the team may simply not use it. Ask before assuming the installation is broken. The Community and billing pages are not evidence that a paid feature is included in your edition.

## 3.4 Use the command palette

The **command palette** is a searchable menu of destinations and actions. Use it when you know the name of something but not which menu contains it.

### Goal: find an action from the keyboard

**Steps**

1. Press **Ctrl + K** (Windows, Linux) or **Cmd + K** (macOS).
2. Type part of the action or item you want into the search field. ①
3. Read the highlighted result, for example a creation action. ②
4. Press **Enter** to run it, or **Escape** to close the palette without acting.

![Screenshot (test Plane): Command palette: (1) search field; (2) a creation action in the results.](../images/handbook/11-command-palette.png)

**Result:** Plane goes to the destination or opens the action.

> **Warning:** Some palette results change data, not just navigate. Read the label before you press Enter. If you are typing in a description or code block, leave the editor first; otherwise the editor may treat the keystroke as text or formatting.

## 3.5 Learn the keyboard shortcuts

The shortcuts dialog is the reference for your running version and operating system. Open it from the help control in the top bar, or with **Ctrl + /**.

![Screenshot (test Plane): Keyboard shortcuts: (1) Work item actions category; (2) action labels with their adjacent keys.](../images/handbook/13-keyboard-shortcuts.png)

The tables below were copied from the running CE v1.4.2 dialog on Linux. On macOS, the dialog shows the Command key where appropriate. "Then" means press and release the first key, then press the next. A plus sign means hold the first key while pressing the second. Some combinations appear in more than one context; the page you are on decides which applies.

*Work item, cycle, module and page actions*

| Context | Action | Keys |
| --- | --- | --- |
| Work item | Change state | S |
| Work item | Change priority | P |
| Work item | Assign to | A |
| Work item | Un-assign from me | I |
| Work item | Change estimate | Shift + E |
| Work item | Add to cycle | Shift + C |
| Work item | Add to modules | Shift + M |
| Work item | Add labels | L |
| Work item | Unsubscribe from notifications | Shift + S |
| Work item | Delete | Ctrl + Backspace |
| Work item | Copy ID | Ctrl + . |
| Work item | Copy title | Ctrl + Shift + ' |
| Work item | Copy URL | Ctrl + Shift + , |
| Cycle | Add to favorites | Shift + F |
| Cycle | Copy URL | Ctrl + Shift + , |
| Module | Add/remove members | M |
| Module | Change status | S |
| Module | Add to favorites | Shift + F |
| Module | Copy URL | Ctrl + Shift + , |
| Page | Lock | Shift + L |
| Page | Make public | Shift + A |
| Page | Archive | Shift + R |
| Page | Add to favorites | Shift + F |
| Page | Copy URL | Ctrl + Shift + , |

*Create, open and go to*

| Context | Action | Keys |
| --- | --- | --- |
| Create | New work item | N then I |
| Create | New page | N then D |
| Create | New view | N then V |
| Create | New cycle | N then C |
| Create | New module | N then M |
| Create | New project | N then P |
| Open | A cycle | O then C |
| Open | A module | O then M |
| Open | A project view | O then V |
| Open | A project setting | O then S |
| Open | A project | O then P |
| Open | A workspace setting | O then S |
| Open | A workspace | O then W |
| Go to | Home | G then H |
| Go to | Inbox | G then X |
| Go to | Your work | G then Y |
| Go to | Work items | G then I |
| Go to | Pages | G then D |
| Go to | Cycles | G then C |
| Go to | Modules | G then M |
| Go to | Project views | G then V |
| Go to | Intake | G then K |
| Go to | Project settings | G then S |
| Go to | Project archives | G then R |
| Go to | Workspace analytics | G then A |
| Go to | Workspace settings | G then S |
| Go to | Workspace drafts | G then J |
| Go to | Workspace archives | G then R |
| Go to | Projects list | G then P |
| Miscellaneous | Toggle app sidebar | Ctrl + B |
| Miscellaneous | Copy current page URL | Ctrl + Shift + C |
| Miscellaneous | Focus search input | Ctrl + F |
| Help | Open keyboard shortcuts | Ctrl + / |

You do not need to memorize these on day one. Start with the palette, **Escape** and **N then I** (new work item). Add navigation shortcuts once you recognize the destinations. A shortcut never grants access: it cannot open a private project or run an action your role does not allow.

> **Tip:** **Ctrl + .** copies the open work item's ID. It is the fastest way to get an exact key such as `WEB-42` into a branch name or commit message without typos.

> **Tip:** If a shortcut seems to do nothing, check whether a text editor, the browser address bar or a dialog has focus. Use the mouse once to confirm the destination before troubleshooting the keys.

## 3.6 Keep a reliable route back

A direct link to a work item is the most useful thing to share in a discussion: it points to one record instead of describing the clicks to find it. Always put the identifier next to the link so people recognize it in a message, commit or PR.

### Goal: share a work item

**Steps**

1. Open the work item.
2. Use its copy-link control, or press **Ctrl + Shift + ,**.
3. Paste the link where you need it.
4. Check that the text next to the link includes the correct identifier.

**Result:** your teammate opens the same record.

A link does not override permissions. If a teammate sees "not found", ask them to check their workspace and project membership. Do not make a project public to work around one missing invitation.

> **Warning:** The link contains your team's Plane address. Do not paste private project links into public GitHub repositories unless your team's policy allows it. git-sync's own link-back comments on GitHub also contain Plane links, so administrators should enable them only where that is acceptable (chapter 25).

## What you learned

- The workspace switcher, sidebar, main area and top-right controls frame every page.
- Home and Your work are personal starting points; a project's Work items page is the complete list.
- The command palette (Ctrl/Cmd + K) and the shortcuts dialog (Ctrl + /) speed up daily work; Ctrl + . copies an item's ID.
- Share work with a direct link plus its identifier; links never bypass permissions.

## Source files

- Plane CE v1.4.2 web application (`apps/web/`), observed in the running test instance
- `apps/web/core/components/settings/workspace/sidebar/item-categories.tsx` (the admin-only **GitHub Sync** settings entry)
- `docs/handbook/03-finding-your-way.md` (original transcription of the shortcuts dialog)
