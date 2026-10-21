# Architecture

A white-label CRM installed once per client: one codebase, one MySQL database, one organization. Industry behavior comes from **blueprints** (configuration) and **modules** (optional code), never from forks.

## Shape of the system

```
browser ──https──▶ nginx ─┬─ /            → apps/web/dist (React SPA)
                          └─ /api/v1/*    → Node API (systemd) ──▶ MySQL 8.4+
                                                      └──▶ SMTP, local file storage
```

Web and API share one origin, so the httpOnly auth cookies are first-party and CSRF protection uses a signed double-submit token.

## Repository

| Path                  | What lives there                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/api`            | Express 5 API. `src/core/<feature>` holds each feature; `src/http` the route registry; `src/blueprints` the applier; `src/modules` the module registry; `src/cli` install, migrate, doctor |
| `apps/web`            | React 19 SPA. `src/features/<feature>`, shared `components/{ui,data,fields}`, `app/` shell and providers                                                                                   |
| `packages/shared`     | Zod schemas, DTO types, permission keys, error codes, filter AST, contrast checks. Used by both apps                                                                                       |
| `packages/blueprints` | `<key>/blueprint.json` presets plus the schema that validates them                                                                                                                         |
| `packages/module-sdk` | Module manifest schema and types                                                                                                                                                           |
| `modules/<key>`       | Optional modules: `manifest.json`, `api/`, `api/migrations/`, `web/`                                                                                                                       |
| `deploy/`             | nginx and systemd examples, release script                                                                                                                                                 |

## Request lifecycle (API)

1. `contextMiddleware` attaches a request id, IP and user agent.
2. `authenticate` verifies the access-token cookie, checks the session is live, and loads the user's roles, permissions and record scopes (cached ten seconds).
3. `csrfProtection` checks the token on every non-GET request.
4. The **access gate** for the route checks the module is enabled, the user has the route's declared permission, and (when policy requires) that admins have 2FA. It runs before upload parsing.
5. Zod validates params, query and body.
6. The handler calls a **service**. Services enforce record scope, field visibility and business rules, and write the audit entry in the same transaction as the change.

Every route is declared with `defineRoutes(...).add({ permission, ... })`. Tests fail if any mounted route is missing from the registry, if a public route is outside the allow-list, or if a route is shadowed by an earlier `/:param` route.

## Data model

- Core entities are real tables with foreign keys: `contacts`, `organizations` (the client's customers), `contact_organization`, `leads`, `deals`, `deal_stage_history`, `activities`, `tags`/`taggables`, `files`.
- Every business row has `id` (internal) and `uuid` (UUIDv7, the only id the API exposes), timestamps, `created_by`/`updated_by` and `deleted_at`.
- Configuration tables (`custom_field_definitions`, `pipelines`, `pipeline_stages`, `roles`, `layouts`, `labels`, `settings`, `dashboards`, `templates`) carry blueprint provenance: `source_blueprint`, `source_key`, `source_version`, `source_hash`, `customized`.
- `audit_logs` is append-only. MySQL triggers reject UPDATE and DELETE; the only exception is the privacy redaction path, which sets a session flag and is itself audited.

## Custom fields

Values live in each entity's `custom` JSON column. Definitions are validated at write time by a Zod schema built from the active definitions (`buildCustomSchema` in `packages/shared`), so the web form and the API use the same rules.

- **Filterable fields** get a `VIRTUAL` generated column `cf_<key>` (via `JSON_VALUE`) plus an index. Multi-select fields get a multi-valued index instead. DDL runs outside transactions, serialized with `GET_LOCK`, and is idempotent (`ensureCustomFieldIndexes`).
- **Visibility** per role is `write`, `read` or `hidden`. Hidden fields are stripped from every response, export, search result and timeline diff, and cannot be filtered or sorted on.
- Archiving a field keeps its values. Select options are never deleted, only deactivated, so stored keys always resolve.

## Access control

- Permissions are `<module>.<resource>.<action>`. Roles hold patterns (`*`, `core.deals.*`, exact keys). `*` is reserved for the system Admin role.
- Record scope per resource is `own`, `team` or `all`; the most permissive across a user's roles wins. Out-of-scope reads return 404.
- Non-admins can only grant permissions and scopes they hold themselves; only admins can change admin accounts.

## Lists, filters and search

All lists share one shape: `{ data, meta: { page, pageSize, total } }`. Filters are a JSON tree (`and`/`or`, max depth 3) compiled to parameterized SQL against a per-entity field whitelist. Search uses MySQL FULLTEXT in boolean mode with a prefix `LIKE` fallback. Saved views store the same filter tree, columns and sort.

## Jobs and schedules

`lib/jobs.ts` runs jobs in-process and records them in the `jobs` table (imports today). Activity reminders run every minute via `every()`. The contract (`enqueue`, `registerJob`) is what Phase 2 moves onto BullMQ.

## Web app

- Branding is fetched unauthenticated at boot and applied as CSS variables on `:root` (light and dark palettes, font, radius, favicon, title). Nothing in the bundle names a brand.
- `/meta/bootstrap` returns everything the shell needs after sign-in: the user, effective access, vocabulary, settings, custom fields, layouts, pipelines and enabled modules.
- Entity screens are generic: each entity has a config (`features/records/entities.tsx`) built from vocabulary, settings and field definitions. One list page, record page, peek sheet and form serve every entity.
- Vocabulary (for example "Member" instead of "Contact") reaches every screen through i18n variables such as `{{contactPlural}}`.
