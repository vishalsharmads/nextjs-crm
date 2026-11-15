---
id: settings.email
title: Email
area: Integrations
route: /settings/email
related: settings.templates
permission: core.email.manage
---

Connect a mailbox so emails are sent from it and replies are logged on records.

Enter the mail server details for sending and, optionally, receiving. Replies from {{contactPluralLower}} are matched to their records and appear in the timeline.

**Workspace mail server** (admins): invitations, password resets, reminders and automated emails use the mail server set up for this workspace on the server. Choose **Send test email** to send yourself a message through it. If it fails, the message says which server settings to check.

## Two-way mail

- **Sign in with…**: when your administrator set up sign-in options, choose one to connect your mailbox without a password. If the sign-in later expires, the mailbox shows a message asking you to reconnect.
- Mail you send from {{appName}} through your mailbox is also saved in its **Sent** folder, so it appears in your mail program.
- **Log sent mail too**: mail you write in your mail program to known {{contactPluralLower}} and {{leadPluralLower}} is logged on their records, like mail you receive. Turn it off per mailbox.
- Every person on a message who is a known {{contactLower}} or {{leadLower}} gets it on their timeline, and replies are grouped into one conversation. Choose **Reply** on an email in a timeline to answer in the same conversation.

## Tracking

When an admin turns on **Email tracking** (Settings → General), the email composer offers **Track opens and clicks**. The email then shows "Opened 2 times, last 3 hours ago · 1 link click" in the timeline. Opens are approximate: some mail apps load images on their own. Tracking is never added under the Privacy or Health data profiles, or for anyone who opted out of marketing or whose processing is restricted. The tracking data is erased with the person.
