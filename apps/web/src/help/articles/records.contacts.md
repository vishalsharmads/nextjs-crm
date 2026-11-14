---
id: records.contacts
title: '{{contactPlural}}'
area: Records
route: /contacts, /contacts/:uuid
permission: core.contacts.view
related: records.lists, records.import, settings.fields
---

The {{contactPluralLower}} list shows everyone your role lets you see. Open one to see its details, history and everything linked to it.

## What you can do

- **Create**: the **New {{contact}}** button, or press `c`. Required fields are marked.
- **Find**: search, filter by any field, sort by a column, and save the result as a view tab so you can come back to it.
- **Peek or open**: click a row to peek at it on the side; open the full page with its link or `Enter`.
- **Edit**: change a field in place on the record page. You can undo from the message that appears.
- **Work in bulk**: tick several rows to assign an owner, change a field, add tags or delete them.
- **Log what happens**: add notes, tasks, calls and meetings from the record page. They appear in its timeline.
- **Merge duplicates**: from the record's menu, merge two {{contactPluralLower}} into one. History, notes, links and records from modules (such as tickets, quotes, invoices and bookings) move to the record you keep. If either one unsubscribed or had processing restricted, the record you keep does too.
- **Privacy**: the Privacy tab records consent and lets privacy staff export or erase a person's data.
- **Email**: send email from the record; replies are logged when a mailbox is connected (Settings → Email).
- **Comments**: discuss the record with colleagues in the Comments tab. Mention someone to notify them; only people who can open the record are notified. The owner hears about new comments. You can edit or delete your own comments.
- **Duplicates**: a new {{contactLower}} that matches an existing one is flagged while you type (Settings → Duplicate rules decides what counts). Matches found later appear under **Possible duplicates** (⌘K) to merge.
- **Share**: ⋯ → **Share** gives one more person or team access to this record, to view or to edit, without changing their role. They still need permission for this kind of record, and a share never lets them delete or merge it. The owner, admins and people with the share permission can share; anyone can remove their own access.

## Fields

Besides the built-in fields, your admin can add custom fields and arrange them (Settings → Custom fields and Layouts). Some fields may be read-only or hidden for your role.

## Permissions

<!-- generated:permissions:core.contacts -->
