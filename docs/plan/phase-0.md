# Phase 0 — Architecture Plan

Status: **awaiting approval**. No application code has been written. Open questions were resolved as decisions in section 13.
Scope: white-label, single-organization, configurable CRM. Node + Express + React + MySQL.

Contents
1. Decisions and stack (with versions)
2. Folder tree
3. Database schema (migration outlines)
4. Custom-field engine
5. RBAC, scopes, permission matrix
6. API surface
7. Blueprint engine and JSON schema
8. Module manifest contract
9. Product and design system (modern UX spec)
10. White-label guarantees
11. Phase 1 delivery milestones
12. Risks
13. Decisions taken

---

## 1. Decisions and stack

Versions are "current stable major" as of Oct 2026. Exact patch versions are pinned in lockfiles at install time, and each dependency's reason is recorded in `CLAUDE.md`.

| Area | Choice | Why |
|---|---|---|
| Runtime | Node 24 LTS in Docker/CI, `engines >= 22` locally | Active LTS. The dev machine has 22.23. |
| API | Express 5, TypeScript strict, ESM | Express 5 forwards async errors natively, so no wrapper is needed |
| DB | MySQL 8.4 LTS, InnoDB, utf8mb4_0900_ai_ci | LTS line, JSON + functional/multi-valued indexes |
| SQL | Knex + mysql2 | Migrations + query builder, no ORM fighting JSON columns |
| Validation | Zod 4 | `z.toJSONSchema` for blueprint schema, OpenAPI via `@asteasolutions/zod-to-openapi` |
| Auth | `@node-rs/argon2` (argon2id), `jose` (JWT), `otplib` (TOTP) | Prebuilt binaries, so no node-gyp in Alpine images |
| CSRF | Double-submit token (`csrf-csrf`) | `csurf` is deprecated |
| Security | helmet, cors, express-rate-limit (+ Redis store in prod) | Standard |
| Logging | pino + pino-http, request id propagation | Fast, structured |
| Mail | nodemailer, Mailpit in dev, Handlebars templates | Auto-escaping templates, reused by blueprints |
| Files | multer + `file-type` (magic bytes), `StorageDriver` interface (local now, S3 later) | Safe uploads |
| CSV | `csv-parse` / `csv-stringify` (streaming) | Large imports/exports |
| Jobs | `JobRunner` interface; in-process runner in Phase 1, BullMQ in Phase 2 | "Design for it now" without adding Redis jobs yet |
| Web | React 19, Vite 7, React Router 7 (data mode) | Current stable. **Changes the spec's React 18** (D2) |
| Server state | TanStack Query 5 | Spec |
| Tables | TanStack Table 8 + TanStack Virtual | Headless, server-side sort/filter/paginate, virtualized rows |
| Forms | React Hook Form + Zod resolver | Spec. Schema built from field definitions at runtime |
| Styling | Tailwind CSS 4 (CSS-first `@theme` mapped to CSS variables) | Runtime theming with no rebuild |
| Components | shadcn/ui (Radix primitives), copied into `apps/web/src/components/ui` | Accessible, owned code |
| UX libs | `cmdk` (command palette), `sonner` (toasts), `dnd-kit` (Kanban), `vaul` (mobile sheets) | Modern interaction patterns (section 9) |
| Calendar | FullCalendar (MIT standard views) | Mature, accessible |
| Charts | Recharts | Dashboard widgets |
| Color | `culori` (OKLCH scale + WCAG contrast) | Derives full token scales from one brand color |
| i18n | i18next + react-i18next | Vocabulary overrides via interpolation |
| Tests | Vitest + Supertest (API, real MySQL), Vitest + RTL (web), Playwright (E2E) | Spec |
| Lint | ESLint 9 flat config, typescript-eslint strict, Prettier 3, Husky + lint-staged, commitlint | Spec |
| CI | GitHub Actions with MySQL 8.4 + Redis service containers | Assumed (D11) |

Deliberate non-choices: no ORM, no GraphQL, no Next.js. A Vite SPA plus Express matches the spec; see D1.

Workspace package names are neutral (`@app/api`, `@app/web`, `@app/shared`, `@app/blueprints`, `@app/module-sdk`).

---

## 2. Folder tree

```
/apps
  /api
    src/
      config/              env.ts (zod), constants
      core/
        auth/              routes, controller, service, repository, tokens, totp, sessions
        rbac/              roles, permissions catalog, scopes, field-visibility, guard
        users/ teams/
        settings/          settings + branding (assets, contrast warnings)
        labels/            vocabulary
        custom-fields/     definitions, schema-builder, ddl-service, serializer
        layouts/ pipelines/ saved-views/
        contacts/ organizations/ leads/ deals/ activities/ tags/
        files/ audit/ search/ import-export/ dashboard/ notifications/ privacy/
      modules/             loader, registry, module context
      blueprints/          applier, differ, exporter, version tracker
      http/                route registry (defineRoute), app factory, openapi
      middleware/          auth, csrf, permission guard, validate, error handler, rate limit
      db/                  knexfile, migrations/, seeds/, transaction helpers
      lib/                 logger, mailer, storage, pagination, filter-ast→sql, job-runner, uuid
      cli/                 install, blueprint-apply, blueprint-export, user, privacy, modules
    test/                  integration (real MySQL), factories, helpers
  /web
    src/
      app/                 providers, router, shell (sidebar, top bar), boot (branding → CSS vars)
      components/ui/       shadcn primitives
      components/data/     DataTable, FilterBuilder, ColumnPicker, BulkBar, SavedViewTabs
      components/fields/   FieldInput, FieldDisplay, FieldFilter, LayoutRenderer
      components/record/   RecordPage, RecordPeek (side sheet), Timeline, RelatedList
      features/            contacts, organizations, leads, deals, activities, dashboard,
                           admin/(branding, users, roles, fields, pipelines, labels, modules, audit)
      lib/                 api client (CSRF + refresh single-flight), query keys, i18n, theme
      modules/             lazy module loader (import.meta.glob over /modules/*/web)
    e2e/                   Playwright
/packages
  /shared         zod schemas, DTO types, permission keys, error codes, filter AST, contrast utils
  /blueprints     generic/, coworking/, visa-consultancy/ (stub), schema.ts, validator, JSON Schema
  /module-sdk     types for manifest, ModuleContext, web module contract
/modules
  /notes-demo     reference module (api, migrations, web, manifest.json)
  /bookings /invoices /tickets /documents   manifest-only stubs (status: "stub")
/docker           docker-compose.yml, docker-compose.test.yml, api.Dockerfile, web.Dockerfile, nginx.conf
/scripts          check-brand-strings.mjs, check-routes.mjs
/docs             architecture.md, blueprint-authoring.md, module-authoring.md, deployment.md,
                  env-reference.md, roadmap.md, plan/
CLAUDE.md
```

Feature layering is `routes → controller → service → repository`. Controllers parse and respond. Services own rules, permissions, scopes, field visibility, and audit. Repositories own SQL.

---

## 3. Database schema (migration outlines)

Conventions:
- PK `id BIGINT UNSIGNED AUTO_INCREMENT`, and a public `uuid CHAR(36) UNIQUE` (UUIDv7, app-generated, index-friendly) on anything that appears in URLs.
- Business entities have `created_at`, `updated_at`, `created_by`, `updated_by`, `deleted_at`.
- Config tables that a blueprint can seed carry `source_blueprint VARCHAR(64) NULL`, `source_key VARCHAR(100) NULL`, `source_version VARCHAR(20) NULL`, `source_hash CHAR(64) NULL`, `customized BOOL DEFAULT 0`, with `UNIQUE(source_blueprint, source_key)`. These are called **"bp cols"** below.
- All FKs are real. Polymorphic links (`related_type` + `related_id`) are limited to a whitelisted enum.

### 001_platform
| Table | Columns (abridged) | Notes |
|---|---|---|
| `settings` | id, `key` UNIQUE, `group`, value JSON, is_public, updated_at, updated_by, bp cols | `is_public` rows feed `/public/branding` |
| `labels` | id, entity_key, locale, singular, plural, bp cols | UNIQUE(entity_key, locale) |
| `templates` | id, `key`, channel (email/notification/document), locale, subject, body, bp cols | Storage + seed in P1, manager UI in P2 |
| `sequences` | `key` PK, prefix, padding, next_value | Numbering formats, `SELECT … FOR UPDATE` |
| `files` | id, uuid, entity, entity_id, original_name, storage_key, mime, size, sha256, uploaded_by, created_at, deleted_at | Random storage keys, served by signed URL |
| `audit_logs` | id, actor_id NULL, actor_type (user/system/cli), action, entity, entity_id, entity_uuid, diff JSON, ip, user_agent, request_id, created_at | Append-only: BEFORE UPDATE/DELETE triggers raise errors |
| `blueprint_applications` | id, blueprint_key, version, checksum, applied_by, applied_at, report JSON | |
| `module_states` | module_key PK, enabled, installed_version, settings JSON, updated_at | |
| `notifications` | id, uuid, user_id, type, title, body, data JSON, link, read_at, emailed_at, created_at | INDEX(user_id, read_at) |
| `jobs` | id, uuid, type, payload JSON, status, progress, result JSON, error, attempts, run_at, started_at, finished_at | Phase 1 in-process runner, later mirrored by BullMQ |

### 002_access
| Table | Columns | Notes |
|---|---|---|
| `users` | id, uuid, email UNIQUE, password_hash, first_name, last_name, avatar_file_id, locale, timezone, status (invited/active/disabled), totp_secret_enc, totp_enabled, failed_login_count, locked_until, last_login_at, password_changed_at, timestamps, deleted_at | TOTP secret encrypted (AES-256-GCM, key from env) |
| `sessions` | id, uuid, user_id, refresh_hash, family_id, user_agent, ip, created_at, last_used_at, expires_at, revoked_at | Rotation with reuse detection |
| `auth_tokens` | id, user_id, purpose (reset/invite), token_hash, expires_at, used_at | |
| `roles` | id, uuid, `key` UNIQUE, name, description, is_system, bp cols | Admin is `is_system` and cannot be deleted |
| `permissions` | id, `key` UNIQUE, module_key, description | Synced from the code + manifest registry at boot |
| `role_permissions` | role_id, pattern | Patterns: `*`, `core.contacts.*`, exact keys |
| `role_scopes` | role_id, resource, scope (own/team/all) | PK(role_id, resource) |
| `user_roles` | user_id, role_id | |
| `teams` / `team_members` | id, uuid, name / team_id, user_id, is_lead | |

### 003_config
| Table | Columns |
|---|---|
| `custom_field_groups` | id, entity, `key`, label, sort_order, visibility JSON, bp cols |
| `custom_field_definitions` | id, uuid, entity, `key`, label, type, group_id, options JSON, required, default_value JSON, validation JSON, visibility JSON, filterable, sortable, show_in_list, help_text, sort_order, active, gen_column, bp cols. UNIQUE(entity, key) |
| `layouts` | id, entity, context (form/detail/list), name, config JSON, is_default, bp cols |
| `pipelines` | id, uuid, name, entity (deal/lead/ticket), is_default, sort_order, bp cols |
| `pipeline_stages` | id, uuid, pipeline_id, `key`, name, color, probability, sort_order, is_won, is_lost, rotting_days, bp cols |
| `saved_views` | id, uuid, entity, name, filters JSON (AST), columns JSON, sort JSON, owner_id, is_shared, is_default, sort_order |
| `dashboards` | id, uuid, name, owner_id NULL, is_default, layout JSON, widgets JSON, bp cols |

### 004_crm_core
| Table | Columns (beyond common) | Indexes |
|---|---|---|
| `contacts` | first_name, last_name, full_name (STORED generated), email, email_norm (generated lower), phone, phone_e164, owner_id, source, lifecycle_status, avatar_file_id, merged_into_id, custom JSON | FULLTEXT(first_name,last_name,email), (owner_id), (email_norm), (phone_e164) |
| `organizations` | name, website, domain (normalized), industry, email, phone, address_line1/2, city, region, postal_code, country CHAR(2), owner_id, merged_into_id, custom JSON | FULLTEXT(name, domain), (domain) |
| `contact_organization` | contact_id, organization_id, relationship_type, job_title, is_primary, started_at, ended_at | UNIQUE(contact_id, organization_id, relationship_type) |
| `leads` | contact fields + company_name, status, pipeline_id NULL, stage_id NULL, converted_at, converted_contact_id, converted_organization_id, converted_deal_id, custom | |
| `deals` | reference (sequence), title, contact_id, organization_id, pipeline_id, stage_id, value DECIMAL(15,2), currency CHAR(3), expected_close DATE, status (open/won/lost), won_at, lost_at, lost_reason, owner_id, stage_entered_at, position DECIMAL(20,10), custom | (pipeline_id, stage_id, position), (owner_id), (expected_close) |
| `deal_stage_history` | deal_id, from_stage_id, to_stage_id, changed_by, changed_at | Feeds conversion and velocity widgets |
| `activities` | type (task/call/meeting/note/email), subject, body (sanitized rich text), due_at, start_at, end_at, all_day, completed_at, priority, outcome, assignee_id, owner_id, related_type (contact/organization/deal/lead), related_id, reminder_at, reminded_at, custom | (related_type, related_id), (assignee_id, due_at, completed_at) |
| `tags` / `taggables` | name, slug UNIQUE, color / tag_id, taggable_type, taggable_id | PK(tag_id, taggable_type, taggable_id) |
| `record_follows` | user_id, entity, entity_id | Lets users follow a record for notifications |

Module tables are prefixed `m_<key>_` and tracked in a per-module Knex migrations table (`knex_migrations_m_<key>`).

---

## 4. Custom-field engine

**Storage.** Values live in the entity's `custom` JSON column, keyed by field key. Select values store the option **key**, not the label, so renaming an option never breaks data.

| Type | Stored as | Zod (runtime) | Generated column (when filterable) |
|---|---|---|---|
| text / textarea | string | `string().max(n)` | `VARCHAR(255)` via `custom->>'$.k'` (text only) |
| number | integer | `int()` + min/max | `JSON_VALUE(... RETURNING SIGNED)` |
| decimal / currency | number | `number()` + scale | `JSON_VALUE(... RETURNING DECIMAL(20,4))` |
| date / datetime | `YYYY-MM-DD` / ISO-8601 UTC | regex/`iso.datetime()` | `RETURNING DATE` / `DATETIME` |
| boolean | bool | `boolean()` | `RETURNING UNSIGNED` |
| select | option key | `enum(activeKeys)` | `VARCHAR(64)` |
| multi_select | key[] | `array(enum)` | Multi-valued index `CAST(custom->'$.k' AS CHAR(64) ARRAY)`, queried with `JSON_OVERLAPS` / `MEMBER OF` |
| url / email / phone | string (phone in E.164) | `url()` / `email()` / phone normalizer | `VARCHAR(255)` |
| user | user uuid | uuid + exists check | `CHAR(36)` |
| file | file uuid | uuid + ownership check | none |

Currency fields carry a fixed currency in `options.currency` (default: instance currency). See D5.

**Runtime validation.** `SchemaBuilder.for(entity, mode)` compiles a Zod object from active definitions. It is cached in-process, keyed by `(entity, mode, defsVersion)`. `defsVersion` is a settings row bumped on every definition change and checked with a 5-second TTL, which is safe for multi-process deploys.
- `create` mode enforces `required`.
- `patch` mode validates only the keys sent, and required keys cannot be set to null. This keeps old records valid when a new required field is added.
- Unknown keys are rejected (`VALIDATION_FAILED`, `details.path = custom.<key>`).

**Field visibility.** Each definition or group has `visibility: { default: "write"|"read"|"hidden", roles: { <roleKey>: … } }`. The user's effective level is the most permissive across their roles; Admin always gets `write`. Visibility is enforced in services:
- The serializer strips hidden fields from every response, export, timeline diff, and search result.
- Writes to `read` or `hidden` fields → `403 FIELD_FORBIDDEN`.
- Filters and sorts on hidden fields are rejected.

**Filter/sort DDL.** `CustomFieldDdlService` handles filterable fields only:
- Column name is `cf_<key>`. The key must match `^[a-z][a-z0-9_]{0,48}$` and is looked up from the definitions table, never from the request.
- DDL is `ALGORITHM=INSTANT` for the virtual column and `ALGORITHM=INPLACE, LOCK=NONE` for the index.
- It is idempotent: an `ensure()` pass reconciles definitions against `information_schema`.
- Capped at 40 indexed custom fields per entity (MySQL allows 64 indexes per table).
- Archiving a field (`active=false`) keeps its values and its column. A separate admin action can drop the column and index.

**Filter AST** (shared between API, saved views, and UI):
```json
{ "and": [ { "field": "lifecycle_status", "op": "in", "value": ["customer"] },
           { "or": [ { "field": "cf.preferred_plan", "op": "eq", "value": "hot_desk" },
                     { "field": "owner", "op": "eq", "value": "@me" } ] } ] }
```
- Ops: `eq neq in nin contains starts_with gt gte lt lte between is_empty is_not_empty`, plus relative dates (`within_last`, `within_next`, `today`).
- Max depth is 3.
- Each resource has a field whitelist. Custom fields are referenced as `cf.<key>` and resolved through definitions.

**UI rendering.** `LayoutRenderer` reads the layout (sections → field refs, core or custom) and renders `FieldInput` / `FieldDisplay` / `FieldFilter` by type. A field with no layout entry falls back to its group's section. Nothing for custom fields is hardcoded.

---

## 5. RBAC, scopes, permission matrix

**Permission keys** follow `<module>.<resource>.<action>`.
- Actions: `view create update delete export import merge assign bulk`.
- Admin keys: `core.settings.manage`, `core.branding.manage`, `core.users.manage`, `core.roles.manage`, `core.fields.manage`, `core.pipelines.manage`, `core.labels.manage`, `core.audit.view`, `core.blueprints.manage`, `core.modules.manage`, `core.privacy.manage`.

**Route declaration.** Every route goes through `defineRoute({ method, path, permission, schema, handler, audit })`, where `permission` is a key, `'public'`, or `'authenticated'`. A test walks the Express router and fails if any mounted layer lacks a registry entry. Module routes use the same helper.

**Record scope.** `role_scopes(resource) ∈ own | team | all`. When a user has several roles, the most permissive wins.
- `own`: `owner_id = me`. For activities it is `assignee_id = me OR owner_id = me`.
- `team`: `owner_id IN (members of my teams)`.
- The scope is applied in the repository from a service-provided `ScopeContext`.
- An out-of-scope single-record read returns **404**, not 403, so record ids can't be probed.
- Activities and files are also visible when the user can view the parent record (D9).

**Permission matrix (seeded by blueprints)**

| Resource | generic: Admin | generic: Manager | generic: Sales rep | generic: Read-only | coworking: Community mgr | coworking: Front desk |
|---|---|---|---|---|---|---|
| contacts | * / all | all actions / all | view create update / **own** | view / all | * / all | view / all |
| organizations | * / all | all / all | view create update / all | view / all | * / all | view / all |
| leads | * / all | all / all | view create update / own | view / all | * / all | — |
| deals | * / all | all / all | view create update / own | view / all | * / all | — |
| activities | * / all | all / all | all / own | view / all | * / all | view create / own |
| tags | * | manage | view, attach | view | manage | view |
| import / export | * | both | export (own scope) | — | both | — |
| bookings.* (stub) | * | — | — | — | view | * / all |
| tickets.* (stub) | * | — | — | — | * / all | create, view own |
| admin keys | * | audit.view | — | — | — | — |

---

## 6. API surface (`/api/v1`)

- List response: `{ data, meta: { page, pageSize, total } }`.
- Error response: `{ error: { code, message, details? } }`.
- Error codes: `VALIDATION_FAILED UNAUTHENTICATED TOKEN_EXPIRED CSRF_INVALID FORBIDDEN FIELD_FORBIDDEN NOT_FOUND CONFLICT DUPLICATE_DETECTED RATE_LIMITED ACCOUNT_LOCKED MFA_REQUIRED MFA_INVALID STAGE_INVALID BLUEPRINT_CONFLICT MODULE_DEPENDENCY PAYLOAD_TOO_LARGE UNSUPPORTED_FILE_TYPE INTERNAL`.
- List query params: `page`, `pageSize` (max 100), `sort=-created_at,last_name`, `filter=<AST JSON>`, `q`, `view=<savedViewUuid>`.
- Every mutation writes an audit entry, inside the same transaction as the change.

| Group | Endpoints |
|---|---|
| Public | `GET /public/branding`, `GET /public/manifest.webmanifest`, `GET /public/favicon`, `GET /health`, `GET /ready` |
| Auth | `GET /auth/csrf`, `POST /auth/login`, `POST /auth/2fa/verify`, `POST /auth/refresh`, `POST /auth/logout`, `POST /auth/password/forgot`, `POST /auth/password/reset`, `POST /auth/invite/accept` |
| Me | `GET/PATCH /me`, `POST /me/password`, `POST /me/2fa/setup｜enable｜disable`, `GET /me/sessions`, `DELETE /me/sessions/:uuid`, `GET /me/access` (effective permissions, scopes, field visibility) |
| Bootstrap | `GET /meta/bootstrap`: labels, field defs, layouts, pipelines, enabled modules + menu, access, user prefs in one call |
| Users / teams / roles | CRUD `/users` (+ `/:uuid/disable`, `/:uuid/reset-2fa`, `/:uuid/resend-invite`), CRUD `/teams` + `/teams/:uuid/members`, CRUD `/roles`, `GET /permissions` |
| Settings | `GET /settings`, `PATCH /settings/:group`, `GET/PUT /settings/branding`, `POST /settings/branding/assets/:slot`, `GET/PUT /labels` |
| Config | CRUD `/custom-fields` (+ `/:uuid/archive｜restore`, `PUT /custom-fields/order`), CRUD `/custom-field-groups`, `GET/PUT /layouts`, CRUD `/pipelines` + `/pipelines/:uuid/stages` + `PUT …/stages/order`, CRUD `/saved-views` |
| Entities | For `contacts organizations leads deals activities`: `GET /`, `POST /`, `GET /:uuid`, `PATCH /:uuid`, `DELETE /:uuid`, `POST /:uuid/restore`, `POST /bulk`, `GET /:uuid/timeline`, `GET /export` |
| Contacts/orgs extras | `GET /contacts/:uuid/duplicates`, `POST /contacts/check-duplicates` (pre-create), `POST /contacts/merge`, same for organizations, CRUD `/contact-organizations` |
| Deals extras | `GET /deals/board?pipeline=`, `PATCH /deals/:uuid/stage` `{stageUuid, beforeUuid?, afterUuid?, lostReason?}`, `POST /leads/:uuid/convert` |
| Activities extras | `POST /activities/:uuid/complete｜reopen`, `GET /activities/calendar?from&to&assignee` |
| Tags / files | CRUD `/tags`, `POST /files` (multipart), `GET /files/:uuid/url`, `GET /files/download?token=`, `DELETE /files/:uuid` |
| Import | `POST /imports` (upload → headers + suggested mapping), `POST /imports/:uuid/start`, `GET /imports/:uuid`, `GET /imports/:uuid/errors.csv` |
| Search | `GET /search?q=&types=` |
| Dashboard | CRUD `/dashboards`, `GET /dashboards/widgets/:type/data` |
| Notifications | `GET /notifications`, `GET /notifications/unread-count`, `POST /notifications/:uuid/read`, `POST /notifications/read-all` |
| Audit | `GET /audit-logs`, `GET /audit-logs/:id` |
| Blueprints | `GET /blueprints`, `POST /blueprints/:key/preview` (dry-run diff), `POST /blueprints/:key/apply`, `GET /blueprints/export` |
| Modules | `GET /modules`, `POST /modules/:key/enable｜disable`, module routes under `/m/:key/*` |
| Privacy | `POST /privacy/:entity/:uuid/anonymize`, `DELETE /privacy/:entity/:uuid` (hard delete, Admin, double confirmation token) |
| Docs | `GET /docs` (OpenAPI UI, dev or behind permission), `GET /openapi.json` |

**Auth model.**
- Access JWT lifetime is 15 min, in an httpOnly cookie scoped to `/api`.
- The refresh token is opaque (256-bit), stored hashed, in an httpOnly cookie scoped to `/api/v1/auth`. It rotates on every use; reusing an old token revokes the whole family.
- CSRF uses a double-submit cookie plus the `X-CSRF-Token` header on all non-GET requests.
- Lockout and the password policy come from settings.
- The web app and API are deployed **same-origin** (nginx serves the SPA and proxies `/api`), so cookies stay first-party.

**CLI** (npm scripts in the root):
- `install:instance -- --blueprint=<key> [--admin-email --app-name --sample-data]`, also aliased as `crm:install`
- `blueprint:apply [--dry-run]`
- `crm:export-blueprint --out`
- `db:migrate｜rollback｜seed`
- `user:create-admin`, `user:reset-password`
- `modules:enable｜disable`
- `privacy:anonymize`

---

## 7. Blueprint engine

**File:** `packages/blueprints/<key>/blueprint.json`. It is validated by a Zod schema, and the JSON Schema exported from it lets editors autocomplete. Every item has a stable `key`.

```jsonc
{
  "$schema": "../schema.json",
  "key": "coworking", "name": "Coworking space", "version": "1.0.0",
  "description": "Members, memberships and front-desk operations",
  "settings":   { "currency.default": "GBP", "locale.default": "en", "features.leads": false },
  "vocabulary": { "contact": { "singular": "Member", "plural": "Members" },
                  "organization": { "singular": "Company", "plural": "Companies" },
                  "deal": { "singular": "Membership", "plural": "Memberships" } },
  "modules": ["bookings", "invoices", "tickets", "documents"],
  "custom_fields": {
    "contact": [
      { "key": "id_verified", "label": "ID verified", "type": "boolean", "filterable": true },
      { "key": "preferred_plan", "label": "Preferred plan", "type": "select", "filterable": true,
        "options": [ { "key": "hot_desk", "label": "Hot desk" }, { "key": "dedicated_desk", "label": "Dedicated desk" },
                     { "key": "private_office", "label": "Private office" }, { "key": "virtual_office", "label": "Virtual office" } ] },
      { "key": "access_card_no", "label": "Access card no.", "type": "text",
        "visibility": { "default": "write", "roles": { "front_desk": "read" } } } ],
    "deal": [
      { "key": "desk_or_room", "label": "Desk or room", "type": "text" },
      { "key": "start_date", "label": "Start date", "type": "date", "required": true, "filterable": true },
      { "key": "monthly_fee", "label": "Monthly fee", "type": "currency", "filterable": true },
      { "key": "deposit_paid", "label": "Deposit paid", "type": "boolean" },
      { "key": "end_date", "label": "End date", "type": "date", "filterable": true },
      { "key": "billing_cycle", "label": "Billing cycle", "type": "select", "filterable": true,
        "options": [ { "key": "monthly", "label": "Monthly" }, { "key": "quarterly", "label": "Quarterly" }, { "key": "annual", "label": "Annual" } ] } ] },
  "pipelines": [ { "key": "memberships", "name": "Memberships", "entity": "deal", "is_default": true,
    "stages": [ { "key": "enquiry", "name": "Enquiry", "probability": 10 },
                { "key": "tour_booked", "name": "Tour booked", "probability": 30 },
                { "key": "proposal_sent", "name": "Proposal sent", "probability": 60 },
                { "key": "contract_signed", "name": "Contract signed", "probability": 90 },
                { "key": "active", "name": "Active", "is_won": true },
                { "key": "lost", "name": "Lost", "is_lost": true } ] } ],
  "roles": [ { "key": "admin", "name": "Admin", "permissions": ["*"], "scopes": { "*": "all" } },
             { "key": "community_manager", "name": "Community manager",
               "permissions": ["core.contacts.*", "core.organizations.*", "core.deals.*", "core.activities.*", "tickets.tickets.*"],
               "scopes": { "*": "all" } },
             { "key": "front_desk", "name": "Front desk",
               "permissions": ["core.contacts.view", "bookings.bookings.*", "tickets.tickets.create"],
               "scopes": { "core.contacts": "all", "core.activities": "own" } } ],
  "layouts":   [ { "entity": "contact", "context": "form", "sections": [ … ] } ],
  "dashboard": { "widgets": [ { "key": "occupancy", "type": "module:bookings.occupancy" },
                              { "key": "pipeline_value", "type": "pipeline_value", "params": { "pipeline": "memberships" } },
                              { "key": "renewals", "type": "date_window", "params": { "entity": "deal", "field": "cf.end_date", "days": 30 } },
                              { "key": "open_tickets", "type": "module:tickets.open_count" } ] },
  "templates": [ { "key": "auth.password_reset", "channel": "email", "subject": "…", "body": "…" } ],
  "sample_data": { "contacts": [ … ], "deals": [ … ] }
}
```

**Apply algorithm** (`BlueprintApplier`, also used by install):
1. Validate the schema. Check that referenced modules exist and that permission keys resolve against the catalog (core + module manifests).
2. Checksum the canonical JSON.
   - Same key, version, and checksum as already applied → **no-op**.
   - Same version with a different checksum → refuse (the blueprint was edited without a version bump).
   - Downgrade → refuse unless `--force`.
3. **Phase A, in one transaction:** for each item, match it by `(source_blueprint, source_key)`, then by natural key.
   - missing → **create** (bp cols set)
   - matched, `customized = 0`, blueprint content changed → **update**
   - matched, `customized = 1` (or the current hash differs from `source_hash`) → **skip + conflict**
   - natural-key collision with a client-created item → **skip + conflict**
   - present in the DB but gone from the new blueprint → **orphaned** (reported, never deleted)
4. **Phase B, outside the transaction because MySQL DDL implicitly commits:** run module migrations, then `CustomFieldDdlService.ensure()`. Both are idempotent and safe to re-run.
5. Write a `blueprint_applications` row with the report (`created / updated / skipped / conflicts / orphaned`). The CLI prints it, and `preview` returns it without writing.

Any admin edit to a blueprint-sourced item sets `customized = 1`. **Export** (`crm:export-blueprint`) serializes the current configuration (and no records) into the same format, so a configured install can become the next preset.

Phase 1 ships `generic`, `coworking`, and a `visa-consultancy` stub (manifest + vocabulary only).

---

## 8. Module manifest contract

```jsonc
{
  "key": "notes-demo", "name": "Notes (reference)", "version": "1.0.0", "status": "available",   // or "stub"
  "depends_on": [],
  "permissions": [ { "key": "notes-demo.notes.view", "description": "View notes" }, … ],
  "menu_items":  [ { "key": "notes", "label": "Notes", "path": "/m/notes-demo", "icon": "notebook", "permission": "notes-demo.notes.view", "order": 50 } ],
  "settings_schema": { /* JSON Schema */ },
  "migrations_dir": "api/migrations",
  "api_entry": "api/index.ts",
  "web_entry": "web/index.tsx",
  "dashboard_widgets": [ { "type": "notes-demo.recent", "title": "Recent notes" } ]
}
```

- **API.** At boot the API reads all manifests and validates them. For enabled modules in dependency order, it calls `register(ctx)`. `ctx` exposes `defineRoute`, db, logger, audit, settings, labels, and the permission guard; it does not expose raw app internals. Routes mount under `/api/v1/m/<key>`.
- **Enable/disable.** Enabling checks `depends_on` and runs the module's migrations. Disabling unmounts routes on the next request cycle through a registry gate, and is refused while another enabled module depends on it. Data is never dropped.
- **Web.** `import.meta.glob('/modules/*/web/index.tsx')` gives one lazy chunk per module. Menu entries and routes render only when the module is enabled **and** the user holds the permission. Adding a new module requires a rebuild; enabling an existing one does not.
- **Stubs.** `bookings`, `invoices`, `tickets`, and `documents` are manifest-only in Phase 1, so blueprint permissions and widget references validate. Their widgets render a "not installed yet" state.

---

## 9. Product and design system (modern UX spec)

The bar is Attio, Linear, and HubSpot's newer surfaces: fast, keyboard-first, dense where people work, calm everywhere else. Because the product is white-label, the **default theme** is the "factory finish" that each client restyles. The structure, density, and interaction model are the parts that stay constant.

### Product patterns (Phase 1)
| Pattern | Spec |
|---|---|
| Command palette | `⌘K`/`Ctrl K`: jump to any record, page, or saved view, and run actions ("Create deal", "Log call"). Results respect permissions and vocabulary |
| Keyboard | `c` create, `/` search, `g c` go to contacts, `j/k` move in lists, `e` edit, `Esc` close. Help sheet on `?` |
| Record peek | Clicking a row opens a right-side sheet with the summary, inline-editable fields, and next activity. `Enter` opens the full page. The list keeps its scroll position |
| Inline editing | Click a field on the detail page or peek to edit it in place. Optimistic save, with undo in the toast |
| Views as tabs | Saved views sit as tabs above every list. Filter chips are editable in place, and unsaved changes show a "Save view" affordance |
| Tables | Virtualized rows, sticky header and first column, resizable and reorderable columns, density toggle (comfortable/compact), row selection with a floating bulk-action bar |
| Kanban | Columns per stage with count and value totals, drag with keyboard support (dnd-kit), stage probability shown, rotting indicator after `rotting_days` |
| Timeline | One chronological stream per record: activities, field changes (from audit), stage moves, files. Filterable by type |
| Composer | A single "Log activity" composer on the record page, with tabs for Note, Task, Call, and Meeting |
| Duplicates | Warning shown inline while typing an email or phone on create, with a "View existing" link. Side-by-side merge with a per-field pick |
| States | Skeletons that match the final layout. Empty states tell the user what to do next, with one primary action. Errors say what failed and how to fix it |
| Notifications | Bell with an inbox popover. Toasts only for the user's own actions |
| Onboarding | First-run checklist for Admins: set branding, invite users, review fields, import data |
| Mobile | Below `md`: bottom-sheet peeks (vaul), list cards instead of tables, a sticky create button. Core flows (find, view, log activity, move stage) work on a phone |

### Default token system (overridable per instance)
| Token | Light | Dark | Role |
|---|---|---|---|
| `--canvas` | `#F3F5F4` | `#141917` | App background behind panes |
| `--surface` | `#FFFFFF` | `#1C2220` | Panes, tables, sheets |
| `--ink` | `#17201D` | `#E6ECE9` | Primary text |
| `--line` | `#DCE3E0` | `#2C3532` | Borders, dividers |
| `--primary` | `#1F6F5C` (deep spruce) | `#4FB89C` | Actions, focus, selection |
| `--accent` | `#C2410C` | `#F08A5D` | Rare emphasis: overdue, rotting, destructive confirm |

- Each brand color generates an 11-step OKLCH scale. Foreground tokens (`--primary-fg` etc.) are chosen automatically for WCAG AA. The admin UI warns when a pair falls below 4.5:1 for text or 3:1 for UI.
- Default typeface is **IBM Plex Sans**: tabular figures for money columns, wide language coverage, open license, bundled via `@fontsource`. The admin can pick from bundled families (Plex Sans, Public Sans, Source Sans 3, Atkinson Hyperlegible, system UI) with no rebuild.
- Type scale: 12 / 13 (table) / 14 (body) / 16 / 20 / 24 / 32. Weights 400/500/600. Sentence case everywhere.
- Shape: radius tokens have a hierarchy (`--radius-sm` for inputs/chips, `--radius-md` for panes, `--radius-lg` for sheets/dialogs) instead of one radius for everything. A single brand radius scales all three.
- Elevation is used only on floating layers (popover, sheet, palette). Panes are separated by `--line` on `--canvas`. Data does not sit in a grid of shadowed cards.
- Motion stays short (120–200 ms ease-out) and only responds to user actions: sheet slide, palette open, card drag, stage drop. `prefers-reduced-motion` is honored.
- RTL-ready: layout uses CSS logical properties (`ms-*`, `pe-*`, `start/end`), and icons that imply direction flip under `dir="rtl"` (D12).
- Accessibility: visible focus ring (`--primary`, 2 px offset), labelled inputs, focus trapping in dialogs/sheets, live regions for toasts, and every action reachable by keyboard.

### Layout
```
┌────────┬──────────────────────────────────────────────────────┐
│ Brand  │  ⌘K Search…                         🔔   Avatar      │
│────────│──────────────────────────────────────────────────────│
│ Home   │  Members                                   + New     │
│ Members│  [All] [My members] [Verified] [+ view]              │
│ Compan.│  Filter: Plan is Hot desk ×   Owner is me ×          │
│ Member.│  ┌───────────────────────────────────┬──────────────┐│
│ Tasks  │  │ ☐ Name        Plan     Owner  ... │  Peek sheet  ││
│ ───    │  │ ☐ …                               │  (inline     ││
│ Modules│  │                                   │   edit)      ││
│ Admin  │  └───────────────────────────────────┴──────────────┘│
└────────┴──────────────────────────────────────────────────────┘
```
The sidebar is collapsible to icons. Its items come from vocabulary, enabled modules, and permissions. Content is left-aligned, and numbers are right-aligned with tabular figures.

---

## 10. White-label guarantees

- No product or vendor names exist in code. The fallback app name is the generic word "CRM", used only until settings load.
- `index.html` ships with an empty `<title>`. Boot sets the title, favicon, theme-color, and manifest link from `/public/branding`. Emails, PDFs, and error pages read the same settings.
- `scripts/check-brand-strings.mjs` greps `apps/*/dist`, templates, blueprints, and docs against `brand-denylist.txt` (D3), and fails CI on a match.
- An ESLint rule bans hex/rgb literals and named Tailwind palette colors (`bg-blue-500`) in `apps/web/src`, except inside `theme/defaults.ts`.
- All user-facing copy goes through i18n keys that interpolate vocabulary, e.g. `"New {{entity.deal.singular}}"`. Copy avoids articles before entity names ("a/an Member" problems).

---

## 11. Phase 1 delivery milestones

Phase 1 has 16 items, which is too much for one review. I'll deliver it as four milestones (D4).

| Milestone | Spec items | Demo at checkpoint |
|---|---|---|
| **1a Foundation** | 1–6 + install CLI skeleton | `docker compose up`, install, log in, change branding and vocabulary live, roles admin UI |
| **1b Records** | 7–10 | Custom fields end to end, contacts/orgs with dedupe and merge, deals Kanban, activities calendar |
| **1c Productivity** | 11–13 | Saved views, bulk actions, import/export, dashboard, audit, notifications |
| **1d Platform** | 14–16 | Blueprints (generic, coworking) with idempotent re-apply, export, module loader + notes-demo, Playwright flows, docs |

---

## 12. Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | **MySQL DDL implicitly commits**, so a "transactional install" can't include generated columns or module migrations | Two-phase apply (config in a transaction, DDL as an idempotent reconcile pass) with a recorded report |
| 2 | Index limits (64/table), and ALTERs on large tables | Cap of 40 filterable fields per entity, INSTANT virtual columns, online index builds, DDL serialized with a `GET_LOCK` |
| 3 | Adding a required field invalidates existing records | Required is enforced on create and on explicit null only, and the admin UI shows a "N records missing value" banner |
| 4 | Append-only audit vs. privacy erasure | Triggers block UPDATE/DELETE. Anonymization replaces PII inside diffs through one privileged CLI path that is itself audited (D6) |
| 5 | Triggers need `TRIGGER` privilege, and `log_bin_trust_function_creators` when binlog is on | Documented in the deployment guide. The installer checks and explains |
| 6 | Cookie auth across origins | Same-origin deployment via nginx is required. Cross-origin is unsupported in P1 |
| 7 | Vocabulary grammar (articles, gendered languages) | Interpolation conventions, plus per-locale label rows with optional grammatical forms later |
| 8 | User-picked colors fail contrast | Auto-derived foregrounds plus warnings. Low contrast is never silently accepted |
| 9 | Module web code is compiled in, so new modules need a rebuild | Documented. Enable/disable is runtime-only |
| 10 | CSV import without a queue in P1 | `jobs` table + in-process runner, 50k row cap, resumable status; swapped for BullMQ in P2 |
| 11 | Phase 1 is large | Milestone branches with atomic commits (section 11, D4) |
| 12 | **Docker is not installed on this machine** | Can't verify the `docker compose up` DoD locally. Herd's MySQL works for dev and tests meanwhile (D7) |

---

## 13. Decisions taken

You asked me to make these calls myself, based on how bespoke multi-industry CRMs are usually built. Each one is reversible before Phase 1 starts.

| # | Topic | Decision | Reasoning |
|---|---|---|---|
| D1 | Framework | **Vite SPA + Express**, per spec. The folder name `crm_nextjs` is only a name | A CRM sits behind a login, so SSR/SEO buys nothing. A separate API serves modules, CLI, and future integrations cleanly |
| D2 | React | **React 19** instead of 18 | Current stable, supported by shadcn/Radix, and you asked for modern specs |
| D3 | Brand denylist | `brand-denylist.txt` ships with generic placeholders (`Acme`, `Lorem ipsum`, `Powered by`, `example.com` in built output). Add vendor or agency names to it whenever needed | The CI check is already wired in, so adding names later only means editing that file |
| D4 | Checkpoints | Phase 1 runs milestones 1a→1d on one branch per milestone, with **atomic conventional commits**. A short status after each milestone, a full report at the end of Phase 1. I stop early only if blocked | Keeps momentum and keeps every change reviewable |
| D5 | Currency fields | Fixed currency per field (`options.currency`, defaulting to the instance currency) | Single-org installs almost always bill in one currency. Deals keep their own `currency` column for exceptions |
| D6 | Audit vs. erasure | Privacy anonymization **may redact PII inside audit diffs**. It runs through one privileged, itself-audited path, and everything else stays append-only | GDPR/DPDP erasure obligations outrank audit immutability. This is standard practice |
| D7 | Local infra | Docker Compose remains the reference stack (CI and prod). On this machine, dev and tests use Herd's MySQL plus a Redis service, configured through `.env` | Docker isn't installed here. Install Docker or OrbStack to verify the `docker compose up` DoD |
| D8 | Coworking renewals | Add `end_date` (date, filterable) and `billing_cycle` (select: monthly, quarterly, annual) to coworking deal fields. The renewals widget counts deals whose `end_date` falls in the next 30 days | Memberships renew on a contract end date. Without it the widget has nothing to count |
| D9 | Activity visibility | Users see activities and files on any record they can view. `own` scope limits only the "My activities" lists and editing | Matches how teams work: front desk sees the community manager's notes on a member |
| D10 | Leads | Leads stay a core entity, toggled per instance by the `features.leads` setting. `generic` enables it. `coworking` disables it, because enquiries enter the Memberships pipeline at "Enquiry" | Many verticals (coworking, clinics, gyms) qualify inside the deal pipeline, while B2B sales wants separate leads |
| D11 | CI | GitHub Actions. No remote exists yet, so nothing is pushed until you add one | Most common choice, and service containers cover MySQL and Redis |
| D12 | Locales | English at launch. i18n scaffolding from day one, and **RTL-ready** layout using CSS logical properties | Visa-consultancy and regional clients often need Arabic or Hebrew, and retrofitting RTL is expensive |
| D13 | Blueprints per install | One primary blueprint per instance. It can be upgraded to newer versions but not swapped for another blueprint. Industry extras come as modules | Mixing two blueprints' vocabularies and roles creates unresolvable conflicts |

### Industry-informed extras folded into the design (no scope added)
- Every pipeline stage has `rotting_days`, so deals that sit too long are flagged. This is standard in sales, admissions, and memberships CRMs.
- `lost_reason` options come from a configurable list (setting `deals.lost_reasons`) rather than free text, so loss analysis works.
- `source` on contacts and leads is a configurable select. Attribution is the first report every industry asks for.
- Every entity has `custom` plus tags, so vertical data never forces a schema fork.
