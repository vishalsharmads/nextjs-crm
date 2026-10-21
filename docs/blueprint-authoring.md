# Writing a blueprint

A blueprint turns the neutral CRM into an industry preset: vocabulary, custom fields, pipelines, roles, layouts, a dashboard and templates. It is a single JSON file applied at install time and upgradable later without touching what a client changed.

## Where it lives

```
packages/blueprints/<key>/blueprint.json
```

`<key>` matches the file's `key`: lowercase letters, digits and dashes. The schema is `packages/blueprints/src/schema.ts`; invalid files are rejected with the exact path of the problem.

## Minimal example

```json
{
  "key": "fitness-studio",
  "name": "Fitness studio",
  "version": "1.0.0",
  "description": "Members, trials and memberships for gyms and studios.",
  "settings": { "features": { "leads": false }, "general": { "currency": "EUR" } },
  "vocabulary": {
    "contact": { "singular": "Member", "plural": "Members" },
    "deal": { "singular": "Membership", "plural": "Memberships" }
  },
  "custom_field_groups": { "contact": [{ "key": "health", "label": "Health" }] },
  "custom_fields": {
    "contact": [
      {
        "key": "waiver_signed",
        "label": "Waiver signed",
        "type": "boolean",
        "group": "health",
        "filterable": true
      }
    ]
  },
  "pipelines": [
    {
      "key": "memberships",
      "name": "Memberships",
      "entity": "deal",
      "is_default": true,
      "stages": [
        { "key": "trial", "name": "Trial booked", "probability": 30, "rotting_days": 7 },
        { "key": "active", "name": "Active", "is_won": true },
        { "key": "lost", "name": "Lost", "is_lost": true }
      ]
    }
  ],
  "roles": [
    {
      "key": "coach",
      "name": "Coach",
      "permissions": ["core.contacts.view", "core.activities.*"],
      "scopes": { "core.contacts": "all", "core.activities": "own" }
    }
  ],
  "dashboard": {
    "widgets": [
      { "key": "pipeline", "type": "pipeline_value", "size": "lg", "params": { "pipeline": "memberships" } }
    ]
  }
}
```

## Sections

| Section               | Notes                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings`            | Partial settings groups (`general`, `features`, `contacts`, `deals`, `security`). Merged over defaults                                                                                            |
| `vocabulary`          | Label overrides for `contact`, `organization`, `lead`, `deal`, `activity`, `pipeline`, `stage`, `tag`, `user`, `team`                                                                             |
| `modules`             | Module keys to enable. Stub modules are recorded and enabled once released                                                                                                                        |
| `custom_field_groups` | Sections that group fields in forms and record pages                                                                                                                                              |
| `custom_fields`       | Per entity. Types: `text textarea number decimal currency date datetime boolean select multi_select url email phone user file`. Set `filterable: true` for anything people will filter or sort by |
| `pipelines`           | At most one `is_won` and one `is_lost` stage each. `rotting_days` flags stalled records                                                                                                           |
| `roles`               | `permissions` are patterns; `scopes` map resources (or `*`) to `own`, `team` or `all`. Do not define `admin` (system-managed)                                                                     |
| `layouts`             | `form`/`detail` sections (`fields` can mix core inputs and `cf.<key>`), or `list` `columns`                                                                                                       |
| `dashboard`           | Widgets: `pipeline_value`, `tasks_due`, `conversion`, `activity_by_user`, `date_window`, or a module widget `module:<key>.<name>`                                                                 |
| `templates`           | Email, notification or document templates (Handlebars, auto-escaped). `{{branding.appName}}` and `{{labels.contact.singular}}` are available                                                      |
| `sample_data`         | Optional demo organizations, contacts and deals, seeded only with `--sample-data` on first install                                                                                                |

## Rules that keep upgrades safe

- **Every item has a stable `key`.** Rename labels freely; never change keys.
- **Bump `version` for every change.** Applying a changed file under the same version is refused.
- Applying a newer version:
  - creates items the instance does not have yet;
  - updates items that came from this blueprint and were never edited on the instance;
  - **skips and reports** anything the client edited, or created themselves with the same key;
  - **reports, never deletes,** items you removed from the file.
- One primary blueprint per instance. Downgrades are refused.

## Workflow

```bash
npm run blueprint:apply -- --blueprint=<key> --dry-run   # what would change
npm run blueprint:apply -- --blueprint=<key>             # apply
npm run crm:export-blueprint -- --key=<new-key> --version=1.0.0 --out=blueprint.json
```

Export turns a configured instance into a new preset: configure a pilot client in the UI, export, review the JSON, and commit it as `packages/blueprints/<new-key>/blueprint.json`. Admins can also preview an uploaded file from **Settings → Blueprint → Check a file**.

Run `npm run check:brand` before committing: blueprint text is user-visible.
