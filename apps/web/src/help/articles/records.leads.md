---
id: records.leads
title: '{{leadPlural}}'
area: Records
route: /leads, /leads/:uuid
permission: core.leads.view
related: records.lists, records.import, settings.fields
---

The {{leadPluralLower}} list shows everyone your role lets you see. Open one to see its details, history and everything linked to it.

## What you can do

- **Create**: the **New {{lead}}** button, or press `c`. Required fields are marked.
- **Find**: search, filter by any field, sort by a column, and save the result as a view tab so you can come back to it.
- **Peek or open**: click a row to peek at it on the side; open the full page with its link or `Enter`.
- **Edit**: change a field in place on the record page. You can undo from the message that appears.
- **Work in bulk**: tick several rows to assign an owner, change a field, add tags or delete them.
- **Log what happens**: add notes, tasks, calls and meetings from the record page. They appear in its timeline.
- **Convert** qualified {{leadPluralLower}} from the record's menu: this creates {{contactLower}} records, and optionally {{organizationLower}} and {{dealLower}} records too.
- With the {{leadLower}} pipeline turned on (Settings → General), {{leadPluralLower}} also move through stages on a board.
- {{leadPlural}} can be turned off entirely in Settings → General.

## Fields

Besides the built-in fields, your admin can add custom fields and arrange them (Settings → Custom fields and Layouts). Some fields may be read-only or hidden for your role.

## Permissions

<!-- generated:permissions:core.leads -->
