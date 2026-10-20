# CLAUDE.md

White-label, single-organization, configurable CRM. One codebase, one database, and one organization per deployment. Industry behavior comes from **blueprints** (config) and **modules** (optional code), never from forks.

Architecture plan: [docs/plan/phase-0.md](docs/plan/phase-0.md). Roadmap and "Future" ideas: [docs/roadmap.md](docs/roadmap.md).

## Current status

- Phase 0 (plan) is written and **awaiting approval**. Do not write application code until the user approves.
- After approval, implement **Phase 1 only**, in milestones 1a → 1d (plan §11). Do not start Phase 2 until the user says so.

## Non-negotiables

1. **Not SaaS, not multi-tenant.** No `tenant_id`/`org_id`, no tenant scoping, no subdomain routing, billing, or super-admin. The top role is the org's Admin. The `organizations` table holds the client's *customers*, not tenants.
2. **White-label.** No vendor, product, or company names anywhere user-visible (UI, titles, emails, PDFs, errors, API responses, docs). Everything comes from `settings`. Workspace packages are named `@app/*`. The fallback app name is "CRM".
3. **No hardcoded colors** in `apps/web/src`: no hex/rgb literals and no Tailwind palette classes (`bg-blue-500`). Use theme tokens (`bg-primary`, `text-ink`, `border-line`). The only exception is `theme/defaults.ts`.
4. **Vocabulary everywhere.** All user-facing copy goes through i18n keys that interpolate entity labels (`"New {{entity.deal.singular}}"`). Never put an article before an entity name ("a/an Member").
5. **Fixed core entities + custom fields.** No dynamic "define any entity" engine. Industry tables ship as modules (`m_<key>_*` tables).
6. **Industry-specific anything** belongs in `packages/blueprints/<key>` or `modules/<key>`, never in core.
7. **No features beyond the current phase.** Park ideas under "Future" in `docs/roadmap.md`.

## Stack

Node 24 LTS (`engines >= 22`), TypeScript strict, ESM. Express 5, Knex + mysql2, MySQL 8.4, Zod 4, pino, nodemailer. React 19, Vite 7, React Router 7, TanStack Query 5 / Table 8, React Hook Form, Tailwind 4 (CSS variables), shadcn/ui (Radix), cmdk, sonner, dnd-kit, i18next. Tests use Vitest, Supertest (real MySQL), RTL, and Playwright.

**Every new dependency** needs a one-line reason in the table below, and boring, well-known libraries are preferred.

| Dependency | Reason |
|---|---|
| _(filled as dependencies are added)_ | |

## Repo layout

```
apps/api          Express API: src/{config,core,modules,blueprints,http,middleware,db,lib,cli}
apps/web          React SPA: src/{app,components/{ui,data,fields,record},features,lib,modules}
packages/shared   Zod schemas, DTO types, permission keys, error codes, filter AST, contrast utils
packages/blueprints  <key>/blueprint.json + schema + validator
packages/module-sdk  manifest + ModuleContext types
modules/<key>     manifest.json, api/, api/migrations/, web/
deploy/           nginx site config, systemd unit, release script (no Docker)
scripts/ docs/
```

## Commands

_(Added in milestone 1a. Keep this section accurate.)_

```
npm run dev | build | lint | typecheck | test | test:e2e
npm run db:migrate | db:rollback | db:seed
npm run install:instance -- --blueprint=<key>
npm run crm:export-blueprint -- --out=<file>
npm run check:brand
npm run doctor        # verifies Node/MySQL versions, sql_mode, TRIGGER privilege, binlog, SMTP
```

## Backend conventions

- **Layering:** `routes → controller → service → repository`. Controllers parse and respond only. Services hold business rules, permission/scope/field-visibility checks, and audit. Repositories hold SQL.
- **Routes** are registered only through `defineRoute({ method, path, permission, schema, handler })`. `permission` is a key, `'public'`, or `'authenticated'`. A test fails if any Express layer lacks a registry entry.
- **Permission keys** follow `<module>.<resource>.<action>`. Wildcards: `*`, `core.contacts.*`.
- **Record scope** (`own | team | all`) is applied in the repository from a service-supplied `ScopeContext`. An out-of-scope single-record read returns **404**.
- **Field visibility** (custom fields): strip `hidden` from every response, export, search result, and timeline diff. Writing to `read`/`hidden` → `403 FIELD_FORBIDDEN`.
- **Validation:** Zod on every body, query, and param. Custom fields use the runtime schema from `SchemaBuilder`.
- **SQL:** parameterized only. Identifiers from user input (custom field keys) must match `^[a-z][a-z0-9_]{0,48}$` **and** be resolved through `custom_field_definitions`. Never interpolate request values into `knex.raw`.
- **Audit:** every mutation writes an `audit_logs` row in the same transaction. Audit is append-only (DB triggers). The only exception is the privileged privacy anonymize path.
- **Errors:** throw `AppError(code, message, details?)`. Response shape is `{ error: { code, message, details? } }`. Codes are in `packages/shared/src/errors.ts` and are stable once released.
- **Lists:** `{ data, meta: { page, pageSize, total } }`. `pageSize` max is 100. Filters use the shared filter AST with a per-resource field whitelist.
- **IDs:** internal `BIGINT` ids never leave the API. URLs and DTOs use `uuid` (UUIDv7).
- **Blueprint-seedable config rows** carry `source_blueprint`, `source_key`, `source_version`, `source_hash`, `customized`. Any admin edit sets `customized = 1`.

## Database gotchas

- **MySQL DDL implicitly commits.** Never put `ALTER TABLE` (generated columns, module migrations) inside a business transaction. DDL goes through idempotent reconcile passes (`CustomFieldDdlService.ensure()`).
- **Migrations are immutable once committed.** Fix forward with a new migration. A hook blocks editing committed migration files.
- Generated columns for custom fields are named `cf_<key>`. At most 40 indexed custom fields per entity.
- Multi-select uses multi-valued indexes (`CAST(... AS CHAR(64) ARRAY)`) and is queried with `JSON_OVERLAPS` / `MEMBER OF`.
- Audit triggers need the `TRIGGER` privilege, plus `log_bin_trust_function_creators=1` when binlog is on.

## Frontend conventions

- **Server state** lives in TanStack Query only. Query keys come from `lib/query-keys.ts`. Simple mutations (task complete, stage move, inline edit) use optimistic updates.
- **Forms, detail pages, and list columns render from layouts + field definitions.** Never hardcode a custom field.
- **Every data view** has loading (skeleton matching the layout), empty (next action + one primary button), and error (what failed + how to fix) states.
- **Product patterns** (plan §9): `⌘K` command palette, keyboard shortcuts, record peek sheet, inline edit with undo toast, saved views as tabs, virtualized tables with bulk bar, Kanban with dnd-kit.
- **Accessibility:** labelled inputs, visible focus, focus trap in dialogs and sheets, AA contrast, full keyboard reach, `prefers-reduced-motion`.
- **RTL-ready:** use logical properties (`ms-`, `pe-`, `start-`, `end-`), never `ml-`/`pr-`/`left-`/`right-`.
- **Motion:** 120–200 ms ease-out, only in response to user actions.
- **Auth tokens** live in httpOnly cookies only. Never use localStorage or sessionStorage for tokens. The API client sends `X-CSRF-Token` and does a single-flight refresh on 401.
- **Copy:** sentence case, active verbs. A button and its resulting toast use the same verb ("Archive" → "Archived").

## Testing

- API integration tests run against a real MySQL test DB (`DATABASE_URL_TEST`). Each test file runs in a transaction or on a truncated schema. Never mock the DB for repository or service tests.
- Required coverage: auth, RBAC (`own` scope cannot read or edit others' records), the route-permission registry, custom fields, contacts, deals, import, and blueprint idempotency. Web: forms, custom field rendering, theming.
- Playwright: login, create contact with a custom field, move deal across stages.
- Never leave failing tests, lint errors, or type errors. Never use `any` to bypass types; shared types live in `packages/shared`.

## Git workflow

- `main` holds approved work only. Work happens on a branch per phase or milestone (`phase-0-planning`, `phase-1a-foundation`, …), merged with `--no-ff` after the user approves.
- **Atomic commits:** one logical change per commit, and each commit should build, lint, and test on its own. Don't mix refactors with features, or formatting with logic.
- **Conventional commits:** `feat(scope):`, `fix(scope):`, `chore:`, `docs:`, `test:`, `refactor:`, `build:`, `ci:`. Scope is the feature folder (`contacts`, `rbac`, `custom-fields`, `web`, …).
- No remote is configured yet. Never push or force-push without the user asking.

## Working agreement

1. Plan → approval → implement in small commits.
2. Make decisions with bespoke multi-industry CRM experience (the user delegated this), and record them in the plan's decisions table or here. Ask only when blocked.
3. Every feature ships with tests and docs updated in the same milestone.
4. At the end of each phase, report: what was built, how to run it, what is untested or deferred, and open questions (use the `phase-report` skill).
5. Keep this file updated with new decisions, commands, and gotchas as they are learned.

## Local environment notes

- **No Docker, anywhere.** No Dockerfiles, Compose files, or container-based tooling (including Testcontainers and CI service containers). Everything runs natively.
- Dev machine: Homebrew MySQL (server 26.7, root without password, binlog on, `log_bin_trust_function_creators=0`) and Mailpit (SMTP `localhost:1025`, UI `http://localhost:8025`) are already running as brew services. Databases are `crm_dev` and `crm_test`. Redis is not installed; Phase 1 doesn't need it, and Phase 2 will add it via `brew install redis`.
- CI: GitHub Actions installs MySQL 8.4 natively on the runner.
- Production: the built API runs under systemd behind nginx, which serves `apps/web/dist` and proxies `/api` same-origin. One server or vhost, database, and `.env` per client instance.
- The minimum supported MySQL is 8.4 LTS. Don't rely on features newer than 8.4 just because dev runs a newer server.
