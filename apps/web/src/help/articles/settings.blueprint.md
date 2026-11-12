---
id: settings.blueprint
title: Blueprint
area: Settings
route: /settings/blueprint
related: settings.modules
permission: core.blueprints.manage
---

The industry preset this workspace started from, and its upgrades.

A blueprint brings fields, pipelines, roles, objects, templates and settings for an industry. Upgrades only add what is new: anything you changed is never overwritten, and conflicts are listed before you apply. You can also export your configuration as a blueprint.

## Presets

Every installed preset is listed with what it contains: modules, custom fields, pipelines, roles and sample data. Search by name or module.

- **Details** shows the names it uses (for example what it calls {{contactPluralLower}}), its pipelines with their stages, its fields and its roles.
- **Preview** lists exactly what applying it would add or update, before anything changes. Then choose **Apply**.
- **Adding a second preset** (any preset that is not the current one) creates only what is missing, as your own changes: its names and settings replace yours, everything that already exists stays as it is, and the current preset does not change.
- **History** lists every preset applied to this workspace, with its version and date.
