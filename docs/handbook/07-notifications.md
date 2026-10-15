# 07. Notifications and staying informed

The inbox is a place to notice relevant changes without rereading every item in every project. A notification usually needs one of three responses: read it for context, answer a question, or take responsibility for a next action. Opening the notification is only the first step; decide which response is needed.

## 7.1 Open the inbox

The inbox control is in the top bar. Plane also lists **G then X** as the shortcut for going to the inbox. Your own notifications depend on your account's assignments, subscriptions and activity, so your list will differ from a teammate's.

1. Select the inbox icon in the top bar.
2. Review the currently selected notification category.
3. Open the relevant notification.
4. Read the work item and surrounding discussion.
5. Respond on the work item if a response is needed.

![Inbox: (1) All category; (2) Sam’s comment notification; (3) Mentions category.](images/52-inbox.png)

A notification can describe an event that has already been followed by another change. Read the current work item before acting on an old state or assignment. If you received a question and somebody else has already resolved it, a concise acknowledgment is more helpful than repeating the answer.

Use the inbox's read, archive or filtering controls according to the labels shown on your account. Clearing an unread indicator does not complete the work item. An archived notification and an archived work item are different records with different purposes. If a notification disappears from the current selection, inspect its category or filter before assuming the underlying item was deleted.

## 7.2 Mentions are requests for attention

A mention points a comment or description at a specific member. Type `@` in a supported editor and select the intended person from the suggestion list. Include enough context for that person to answer without reconstructing the entire investigation.

> Example: “Alex, should the button keep its full translated label at 320 pixels, or may it wrap onto two lines?” asks for a decision. “Alex, please look” does not say what decision is needed.

A person mentioned in ordinary text is not necessarily a structured Plane mention. Similarly, a copied GitHub username is not automatically a Plane membership grant. git-sync translates supported mentions using its verified user mapping. When it cannot map a GitHub login, it can preserve a profile link rather than pretending it identified a Plane member.

Use mentions sparingly enough that they remain useful. Do not mention a teammate merely to make a routine edit seem urgent. If the work is urgent, set and discuss its priority through the team's normal process.

## 7.3 Subscribe to work you need to follow

Assignment describes responsibility. Subscription describes interest in updates. You may subscribe to a dependency, a review task or a cross-team change even when you are not implementing it. The control on an unsubscribed item reads **Subscribe**; after subscribing it reads **Unsubscribe**.

1. Open the item you need to follow.
2. Select **Subscribe** near its header.
3. Confirm the control changes to **Unsubscribe**.

If the item stops being relevant, unsubscribe using the same control. Removing a subscription does not unassign the item or remove your comments. When tracking several dependencies, a saved view can complement notifications by giving you a deliberate place to review their current state together.

## 7.4 Understand email notifications

Personal Settings → Notifications offers email categories for property changes, state changes, work-item completion, comments and mentions. Review those descriptions before changing switches. If comments are useful but every property edit is noisy, adjust the categories separately.

![Email notifications: (1) property-change switch; (2) Mentions category and its switch.](images/08-notification-preferences.png)

Email additionally depends on the server's mail configuration. The handbook instance has SMTP disabled, so actual delivery to a mailbox was not tested. This does not prevent the book from showing the real preference controls and in-app notifications. Your administrator should verify outgoing email for your team's instance.

When an expected message is missing, first check whether the underlying event appears on the work item. Then inspect your subscription, account preferences and mailbox filtering. If the event is present but mail is consistently absent, give an administrator one concrete example with its item identifier, approximate time and expected category. Include no password or token.

## 7.5 Keep notification habits sustainable

As a suggested team habit, check direct questions before starting a long coding session and again before finishing work for the day. Use comments to leave a clear next action when handing something over. A teammate in another timezone should be able to identify what you checked, what remains uncertain and who needs to decide.

An inbox is a prompt to return to the shared record. Keep the decision on the work item, the technical code discussion on the PR, and a useful link between them. That way the next developer can reconstruct the outcome even after the notification has been marked read.
