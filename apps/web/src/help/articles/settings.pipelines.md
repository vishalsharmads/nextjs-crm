---
id: settings.pipelines
title: Pipelines
area: Settings
route: /settings/pipelines
related: records.deals, reports
permission: core.pipelines.manage
---

The stages {{dealPluralLower}} (and optionally {{leadPluralLower}}) move through, with their probability and color.

- **Probability** weights the forecast.
- One stage can be **won** and one **lost**; moving there closes the record.
- **Rotting days** flag records that stay in a stage too long.
- You can have several pipelines, for example one per product line.
