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

## Task statuses

With **Task statuses** on (Settings → General), a **Task statuses** tab appears here. Its won stage is the _done_ status: moving a task there completes it, and completing a task anywhere moves it there. Reopening a task puts it back on the first open status. Probability and lost stages have no effect on tasks.

## Removing stages and pipelines

- **Remove a stage** with its bin icon. Records in it move to the stage you choose; their stage history is kept.
- **Disable a pipeline** you no longer use (any pipeline except the default; make another one the default first). Its records move to a stage in another pipeline. A disabled pipeline disappears from boards, filters and new records; its stages and stage history are kept.
- **Turn on** a disabled pipeline from the same page to use it again.
