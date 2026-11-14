---
id: records.duplicates
title: Possible duplicates
area: Records
route: /duplicates
related: settings.duplicates, records.contacts, records.organizations
---

{{contactPlural}} and {{organizationPluralLower}} that a duplicate rule matched, found by the nightly scan.

- **Keep this** merges the other record into the one you keep: activities, {{dealPluralLower}}, files, comments, tags and module records move across, and fields that are empty on the kept record are filled from the other. Unsubscribes and processing restrictions carry over.
- **Not a duplicate** removes the pair from the list for good; later scans do not bring it back.
- You see a pair only when you may merge that record type and can open both records.
- Admins choose what counts as a duplicate in Settings → Duplicate rules.
