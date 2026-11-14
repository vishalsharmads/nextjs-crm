---
id: settings.fields
title: Custom fields
area: Settings
route: /settings/fields
related: settings.layouts, settings.objects
permission: core.fields.manage
---

Add the details your work needs to any record type, and decide who can see or change them.

- **Types**: text, long text, number, decimal, currency, date, date and time, yes/no, choice, multiple choice, link, email, phone, person and file.
- **Filterable** fields can be used in filters, sorting, reports and automations (up to 40 per record type). Filterable text, email, phone and link fields are also found by search, for people who can see them.
- **Required** fields must be filled in when a record is created.
- **Visibility**: per role, a field can be editable, read-only or hidden. Hidden fields never appear anywhere for that role, including exports and search.
- **Sensitivity**: "personal" marks personal data; "special" (health and similar) is encrypted and masked until someone with permission reveals it.
- **Archive** a field to hide it; its data is kept.

## Standard fields

Some built-in fields can be hidden or made read only per role, the same way as custom fields: a {{dealLower}}'s value and expected close date, and the email, phone and job title of {{contactPluralLower}} and {{leadPluralLower}}, and the email and phone of {{organizationPluralLower}}. Choose **Who can see it** next to the field under **Standard fields**.

- **Hidden** removes the field from lists, filters, forms, the record page, search, exports, the history and API responses for that role. Hiding a {{dealLower}}'s value also hides money totals on the board and dashboard and turns off sales reports for that role, which are built from values.
- **Read only** shows the value but refuses changes.
- Names, owners and stages cannot be hidden, because lists, boards and links depend on them. Admins always see everything.
