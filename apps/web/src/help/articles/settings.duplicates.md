---
id: settings.duplicates
title: Duplicate rules
area: Settings
route: /settings/duplicates
related: records.duplicates, records.contacts, records.organizations, settings.fields
permission: core.settings.manage
---

Decide when two {{contactPluralLower}}, {{organizationPluralLower}} or {{leadPluralLower}} are the same, and what happens when someone is about to create a second one.

## How rules work

- A rule lists one to four fields. Two records match when **every** field of the rule is the same (case and extra spaces are ignored; phone numbers are compared in international format).
- Fields you can use: email, phone, name and organization for {{contactPluralLower}}; website and name for {{organizationPluralLower}}; email, phone, name and company for {{leadPluralLower}}; plus any **Filterable** custom field that is not marked sensitive.
- **Warns**: while someone fills in a new record, matches are listed above the form with a link to open them. They can still save.
- **Refuses the save**: the record cannot be created while a match exists, also from imports, forms and the API. Use it for fields that are truly unique, such as email.
- A match the person is not allowed to open is never shown. They only see that a possible duplicate exists, so they can ask its owner.
- Email and phone rules for {{contactPluralLower}} and {{leadPluralLower}} also look at the other type, so a new {{leadLower}} whose email belongs to a {{contactLower}} is flagged.
- Switch a rule off to stop using it without deleting it.

## Merge queue

A scan runs every night (and when you choose **Scan now**) and lists matching {{contactPluralLower}} and {{organizationPluralLower}} in **Possible duplicates**, where people who may merge can merge them or mark them as different.

New workspaces start with these rules: same email, same phone, and same name at the same organization for {{contactPluralLower}}; same website and same name for {{organizationPluralLower}}; same email and same phone for {{leadPluralLower}}. All of them warn.
