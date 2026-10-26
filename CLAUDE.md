# CLAUDE.md

White-label, single-organization, configurable CRM. One codebase, one database, and one organization per deployment. Industry behavior comes from **blueprints** (config) and **modules** (optional code), never from forks.

Architecture plan: [docs/plan/phase-0.md](docs/plan/phase-0.md). Roadmap and "Future" ideas: [docs/roadmap.md](docs/roadmap.md).

## Current status

- Phase 0 approved. The user asked to continue through all phases (1 → 4) autonomously, in milestone branches.
- **Phases 1–4 complete** (all planned phases). New work goes through the roadmap's Future list.

## Non-negotiables

1. **Not SaaS, not multi-tenant.** No `tenant_id`/`org_id`, no tenant scoping, no subdomain routing, billing, or super-admin. The top role is the org's Admin. The `organizations` table holds the client's _customers_, not tenants.
2. **White-label.** No vendor, product, or company names anywhere user-visible in the product (the marketing site in `apps/site` is the one place the vendor name "Bespoq" appears; it is on the brand deny list for the product) (UI, titles, emails, PDFs, errors, API responses, docs). Everything comes from `settings`. Workspace packages are named `@app/*`. The fallback app name is "CRM".
3. **No hardcoded colors** in `apps/web/src`: no hex/rgb literals and no Tailwind palette classes (`bg-blue-500`). Use theme tokens (`bg-primary`, `text-ink`, `border-line`). The only exception is `theme/defaults.ts`.
4. **Vocabulary everywhere.** All user-facing copy goes through i18n keys that interpolate entity labels (`"New {{entity.deal.singular}}"`). Never put an article before an entity name ("a/an Member").
5. **Fixed core entities + custom fields.** No dynamic "define any entity" engine. Industry tables ship as modules (`m_<key>_*` tables).
6. **Industry-specific anything** belongs in `packages/blueprints/<key>` or `modules/<key>`, never in core.
7. **No features beyond the current phase.** Park ideas under "Future" in `docs/roadmap.md`.

## Stack

Node 24 LTS (`engines >= 22`), TypeScript strict, ESM. Express 5, Knex + mysql2, MySQL 8.4, Zod 4, pino, nodemailer. React 19, Vite 7, React Router 7, TanStack Query 5 / Table 8, React Hook Form, Tailwind 4 (CSS variables), shadcn/ui (Radix), cmdk, sonner, dnd-kit, i18next. Tests use Vitest, Supertest (real MySQL), RTL, and Playwright.

**Every new dependency** needs a one-line reason in the table below, and boring, well-known libraries are preferred.

| Dependency                                                                                      | Reason                                                                          |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| express 5, helmet, cors, cookie-parser, express-rate-limit                                      | HTTP server, secure headers, cookie auth, auth rate limits                      |
| knex, mysql2                                                                                    | Migrations + query builder without an ORM fighting JSON columns                 |
| zod                                                                                             | Validation everywhere; runtime custom-field schemas; blueprint/manifest schemas |
| @node-rs/argon2                                                                                 | argon2id with prebuilt binaries (no native toolchain on servers)                |
| jose                                                                                            | JWT access tokens                                                               |
| pino, pino-http (pino-pretty dev)                                                               | Structured logging                                                              |
| nodemailer, handlebars                                                                          | SMTP mail; auto-escaping templates shared with blueprints                       |
| multer, file-type                                                                               | Multipart uploads; content sniffing instead of trusting client MIME             |
| csv-parse, csv-stringify                                                                        | Streaming import/export                                                         |
| sanitize-html                                                                                   | Safe rich text in activity bodies                                               |
| uuid                                                                                            | UUIDv7 public ids (time-ordered)                                                |
| dotenv                                                                                          | Load `.env`                                                                     |
| tsx, tsup                                                                                       | Dev runner; production bundle including workspace packages                      |
| @asteasolutions/zod-to-openapi                                                                  | OpenAPI from route Zod schemas                                                  |
| react 19, react-router 7, @tanstack/react-query, @tanstack/react-table, @tanstack/react-virtual | SPA, routing, server state, headless tables, virtualized rows                   |
| react-hook-form, @hookform/resolvers                                                            | Forms with Zod validation                                                       |
| tailwindcss 4, clsx, tailwind-merge                                                             | Token-driven styling                                                            |
| radix-ui, cmdk, sonner, vaul, lucide-react                                                      | Accessible primitives, command palette, toasts, mobile sheets, icons            |
| @dnd-kit/*                                                                                      | Accessible drag and drop (Kanban, column order)                                 |
| @fullcalendar/*                                                                                 | Calendar view (MIT standard views)                                              |
| recharts                                                                                        | Dashboard charts                                                                |
| i18next, react-i18next                                                                          | Locale files + vocabulary interpolation                                         |
| qrcode                                                                                          | 2FA setup QR code                                                               |
| @fontsource/*                                                                                   | Self-hosted fonts selectable from branding (no external font CDN)               |
| astro, @astrojs/sitemap, @astrojs/check                                                         | Static marketing site (`apps/site`), sitemap, type checks                       |
| gsap                                                                                            | Marketing-site animation (hero intro, industry re-tailoring)                    |
| @fontsource-variable/*                                                                          | Self-hosted marketing-site fonts                                                |
| vitest, supertest, @testing-library/*, jsdom, @playwright/test                                  | Tests                                                                           |
| eslint, typescript-eslint, prettier, husky, lint-staged, commitlint, concurrently               | Tooling                                                                         |

## Repo layout

```
apps/api          Express API: src/{config,core,modules,blueprints,http,middleware,db,lib,cli}
apps/web          React SPA: src/{app,components/{ui,data,fields,record},features,lib,modules}
apps/site         Bespoq marketing site (Astro + GSAP), independent of the product; see apps/site/README.md
packages/shared   Zod schemas, DTO types, permission keys, error codes, filter AST, contrast utils
packages/blueprints  <key>/blueprint.json + schema + validator
packages/module-sdk  manifest + ModuleContext types
modules/<key>     manifest.json, api/, api/migrations/, web/
deploy/           nginx site config, systemd unit, release script (no Docker)
scripts/ docs/
```

## Commands

```
npm run dev                      # API :4000 + web :5173 (web proxies /api)
npm run dev:site | build:site    # Bespoq marketing site :4321 (apps/site)
npm run build:single | start:single  # site at /, app at /app, API, one port (demo / shared hosting; docs/deploy-single-server.md)
npm run build | lint | typecheck | test | test:e2e
npm run db:migrate | db:rollback
npm run install:instance -- --blueprint=coworking --admin-email=a@b.c --admin-password='...' [--app-name=..] [--sample-data]
npm run blueprint:apply -- --blueprint=<key> [--dry-run]
npm run crm:export-blueprint -- --out=<file>
npm run check:brand              # white-label grep over build output, templates, blueprints, locales
npm run doctor                   # Node/MySQL versions, sql_mode, TRIGGER privilege, binlog, SMTP
npm run cli -w @app/api -- user:reset-password --email=<email>
npm run cli -w @app/api -- demo:seed [--password=..]   # one demo user per role; shown on sign-in only with DEMO_MODE=true
npm run demo:reset -- --industry=<slug> [--yes]        # wipe the demo DB and install one industry with sample data (demo instances only)
```

API tests drop and recreate `crm_test` on every run (`apps/api/test/global-setup.ts`). E2E (`npm run test:e2e`) drops and reinstalls `crm_e2e` and starts its own API (:4300) and web (:5300).
Run test suites one workspace at a time on this machine; running all three in parallel can be killed for memory.
`TEST_LOG_LEVEL=error npx vitest run` shows API errors that tests otherwise swallow as 500s.

## Backend conventions

- **Layering:** `routes → controller → service → repository`. Controllers parse and respond only. Services hold business rules, permission/scope/field-visibility checks, and audit. Repositories hold SQL.
- **Access gate** runs before a route's `before` middleware (uploads are never parsed for unauthorized callers) and enforces module state, permission and required 2FA enrolment.
- **Grants:** non-admins can only grant permissions/scopes they hold (`core/rbac/grants.ts`); `*` belongs only to the system Admin role; only admins can change admin accounts.
- **Route order:** static paths (`/deals/board`, `/contacts/export`) must be registered before `/:uuid` routes. A test fails on shadowed routes.
- **Domain events** (`core/events/events.ts`) are emitted by services after commit; webhooks and automations subscribe and enqueue jobs. New record types must emit created/updated/deleted.
- **Jobs:** `enqueue`/`registerJob` in `lib/jobs.ts` (in-process, or BullMQ with `REDIS_URL`); recurring work uses `every()`, which takes a Redis lock per tick.
- **`demo:reset` is guarded to demo instances** (`apps/api/src/cli/demo.ts`): `DEMO_MODE=true`, a database name containing `demo`, a `STORAGE_DIR` whose own folder name contains `demo` and which holds neither the app nor a home folder, and a database that is empty or carries the `demo_reset_marker` table (written right after emptying, so failed resets can be retried). `resetDemo` re-checks all of them itself. Keep every guard; it drops tables. Its test runs the CLI in a child process against `crm_test_demo`.
- **Captured test mail is shared across test files:** filter by recipient (`takeMail().filter(m => m.to === …)`), never assert on the whole mailbox.
- **Tests share one database:** a test that creates a _required_ custom field must archive it before it ends, or other files' creates fail.
- **Modules** import only from `@app/api/module-api`; tables are `m_<key>_*`; list new modules in `apps/api/src/modules/installed.ts`.
- **Routes** are registered only through `defineRoute({ method, path, permission, schema, handler })`. `permission` is a key, `'public'`, or `'authenticated'`. A test fails if any Express layer lacks a registry entry.
- **Permission keys** follow `<module>.<resource>.<action>`. Wildcards: `*`, `core.contacts.*`.
- **Record scope** (`own | team | all`) is applied in the repository from a service-supplied `ScopeContext`. An out-of-scope single-record read returns **404**.
- **Field visibility** (custom fields): strip `hidden` from every response, export, search result, and timeline diff. Writing to `read`/`hidden` → `403 FIELD_FORBIDDEN`.
- **PATCH schemas** always use `toPatch(createSchema)` from `@app/shared`, never `.partial()`: Zod 4's `.partial()` keeps `.default()`, so a one-field PATCH would reset every defaulted field.
- **Commercial documents** (quotes, invoices, contracts) are modules that share `core/commerce/documents.ts`: gap-free numbering (`nextDocNumber`), scope-checked links (`resolveLinks`), and server-computed line totals (`saveLines`). Money math lives in `packages/shared/src/commerce.ts` (integer cents) so web previews match the API.
- **Validation:** Zod on every body, query, and param. Custom fields use the runtime schema from `SchemaBuilder`.
- **SQL:** parameterized only. Identifiers from user input (custom field keys) must match `^[a-z][a-z0-9_]{0,48}$` **and** be resolved through `custom_field_definitions`. Never interpolate request values into `knex.raw`.
- **Audit:** every mutation writes an `audit_logs` row in the same transaction. Audit is append-only (DB triggers). The only exception is the privileged privacy anonymize path.
- **Errors:** throw `AppError(code, message, details?)`. Response shape is `{ error: { code, message, details? } }`. Codes are in `packages/shared/src/errors.ts` and are stable once released.
- **Lists:** `{ data, meta: { page, pageSize, total } }`. `pageSize` max is 100. Filters use the shared filter AST with a per-resource field whitelist.
- **IDs:** internal `BIGINT` ids never leave the API. URLs and DTOs use `uuid` (UUIDv7).
- **Blueprint-seedable config rows** carry `source_blueprint`, `source_key`, `source_version`, `source_hash`, `customized`. Any admin edit **and any admin create** sets `customized = 1`, so blueprint upgrades never adopt or overwrite client work.
- **Layering:** record entities (contacts, organizations, leads, deals, activities) use full `routes → service → repository`. Small admin resources (roles, teams, settings) may keep handler + data access in the routes file.
- **Copy:** anything that names an entity must go through `useT()` with vocabulary vars. Other literal English copy in components is tolerated for now (tracked in roadmap: extract to locale files).

## Database gotchas

- **Knex builders are thenables.** Never `return qb` from an `async` function and never `await` a builder you still want to modify: the query runs. Mutate the builder in helpers (`applyScope` returns `void`) or wrap it (`return { qb }`).

- **MySQL DDL implicitly commits.** Never put `ALTER TABLE` (generated columns, module migrations) inside a business transaction. DDL goes through idempotent reconcile passes (`CustomFieldDdlService.ensure()`).
- **Migrations are immutable once committed.** Fix forward with a new migration. A hook blocks editing committed migration files.
- Generated columns for custom fields are named `cf_<key>`. At most 40 indexed custom fields per entity.
- Multi-select uses multi-valued indexes (`CAST(... AS CHAR(64) ARRAY)`) and is queried with `JSON_OVERLAPS` / `MEMBER OF`.
- Audit triggers need the `TRIGGER` privilege, plus `log_bin_trust_function_creators=1` when binlog is on.
- **Never use Knex `whereLike`/`orWhereLike`** on MySQL: it appends `COLLATE utf8_bin` (invalid for utf8mb4, and case-sensitive). Use `.where(col, 'like', value)` with `escapeLike()`.
- Every pooled connection runs `SET time_zone = '+00:00'` (`db/knex.ts`) so `CURRENT_TIMESTAMP` defaults are UTC like app-written dates. Don't remove it.
- MySQL identifiers max 64 chars: give long composite indexes an explicit `indexName`.
- Indexing a VIRTUAL generated column needs `LOCK=SHARED` (blocks writes during the build), not `LOCK=NONE`.
- **Never store JSON `null` in `custom`**: a null makes multi-valued index inserts fail. Clearing a value removes the key.
- Inserts into tables with generated columns must name their columns (always true with Knex objects).
- DATE columns come back as `'YYYY-MM-DD'` strings (typeCast in `db/knex.ts`); DATETIME as UTC `Date`.

## Frontend conventions

- **Server state** lives in TanStack Query only. Query keys come from `lib/query-keys.ts`. Simple mutations (task complete, stage move, inline edit) use optimistic updates.
- **Forms, detail pages, and list columns render from layouts + field definitions.** Never hardcode a custom field.
- **Every data view** has loading (skeleton matching the layout), empty (next action + one primary button), and error (what failed + how to fix) states.
- **Product patterns** (plan §9): `⌘K` command palette, keyboard shortcuts, record peek sheet, inline edit with undo toast, saved views as tabs, virtualized tables with bulk bar, Kanban with dnd-kit.
- **`Button asChild`** renders its single child only (Radix Slot needs exactly one child).
- **Never `import * as Icons from 'lucide-react'`** (pulls every icon into the bundle). Module menu icons come from the curated map in `app/shell/nav.ts`.
- **Accessibility:** labelled inputs, visible focus, focus trap in dialogs and sheets, AA contrast, full keyboard reach, `prefers-reduced-motion`.
- **RTL-ready:** use logical properties (`ms-`, `pe-`, `start-`, `end-`), never `ml-`/`pr-`/`left-`/`right-`.
- **Motion:** 120–200 ms ease-out, only in response to user actions.
- **Auth tokens** live in httpOnly cookies only. Never use localStorage or sessionStorage for tokens. The API client sends `X-CSRF-Token` and does a single-flight refresh on 401.
- **Module pages** link with absolute paths, and buttons inside forms that are not submits need `type="button"`. Restart `npm run dev` after adding a module folder (Vite globs module entries at startup). Module web entries live outside `apps/web`, so `styles.css` declares `@source '../../../modules'`; without it, Tailwind classes used only in modules are never generated.
- **The app may run under a sub-path** (`/app` in the single-server setup, `APP_BASE_PATH`). Navigate with the router; links that leave it (new tabs, copyable URLs) use `appUrl()`/`basePath` from `lib/app-url.ts`, never a bare `/path` or `window.location.origin`.
- **Shared-clock screens** (bookings board, front desk) show the workspace time zone via `lib/zoned.ts`, never the browser's, because the server validates in the workspace zone.
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
