---
id: settings.automations
title: Automations
area: Settings
route: /settings/automations
related: settings.templates, settings.webhooks
permission: core.automations.manage
---

When something happens, or on a schedule, check conditions and act: create tasks, notify, send email, update fields, assign, add notes or tags.

- **When**: an event (created, updated, stage changed, won…), after an optional wait, or on a daily or weekly schedule for every matching record.
- **Only if**: the same filters as lists. After a wait, the conditions are checked again.
- **Then**: one or more actions, in order.

Rules run with the permissions of the person who last changed them. Each run is logged with its outcome. Rules started by other rules stop after three levels.
