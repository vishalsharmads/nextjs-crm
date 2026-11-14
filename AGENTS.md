# AGENTS.md

Instructions for every AI coding agent working in this repo (Claude Code, Codex, Cursor, Copilot, Gemini and others). `CLAUDE.md` only imports this file, so there is one source of truth. Shared working memory (user preferences, workflow lessons, machine notes) lives in [docs/agent-notes.md](docs/agent-notes.md): read it before starting, and add to it instead of to a tool's private memory.

White-label, single-organization, configurable CRM. One codebase, one database, and one organization per deployment. Industry behavior comes from **blueprints** (config) and **modules** (optional code), never from forks.

Architecture plan: [docs/plan/phase-0.md](docs/plan/phase-0.md). Roadmap and "Future" ideas: [docs/roadmap.md](docs/roadmap.md).

## Current status

- Phase 0 approved. The user asked to continue through all phases (1 → 4) autonomously, in milestone branches.
- **Phases 1–5 complete.** Phase 5 is compliance readiness (profiles, access logging, data subject rights, retention, encryption; see `docs/compliance/`). New work goes through the roadmap's Future list.
- **Phase 6** follows [docs/plan/phase-6.md](docs/plan/phase-6.md): 6a (quick wins), 6a2 (UI polish), 6a3 (rich text), 6b (records engine for modules), 6c (admin-defined objects), 6d (tool layer, personal access tokens, MCP), 6e (assistant module), 6f (sales reports) and 6g (delayed and scheduled automations, report builder, dashboard editing) are done. Phase 6 is complete. **Phase 7** (in-app help): 7a page help and knowledge base, 7b articles and blueprint help notes, 7c guided tours.
- **Phase 8** follows [docs/plan/phase-8.md](docs/plan/phase-8.md): module settings and marketplace (8a, 8b), example integration and developer docs (8c), developer MCP server for AI coding agents (8e) and the git-repository module catalog (8g) are done. Run-time upload (8d) and in-product module generation (8f) are design only.
- **Phase 9** follows [docs/plan/phase-9.md](docs/plan/phase-9.md): 9a (tasks: detail page, comments, checklists, recurrence, reminders and digest, My work, calendar, optional task statuses, task tools) and 9b (board Move to, quote and invoice tabs) are built.
- **Phase 11** follows [docs/plan/phase-11.md](docs/plan/phase-11.md) (production readiness): 11a and 11b are built.
- **Phase 10** follows [docs/plan/phase-10.md](docs/plan/phase-10.md): AI setup mode (10a interview and brief, 10b proposal, build and branding, 10c spreadsheet mapping and check-before-import, 10d entry points and E2E) is built.

## Non-negotiables

1. **Not SaaS, not multi-tenant.** No `tenant_id`/`org_id`, no tenant scoping, no subdomain routing, billing, or super-admin. The top role is the org's Admin. The `organizations` table holds the client's _customers_, not tenants.
2. **White-label.** No vendor, product, or company names anywhere user-visible in the product (the marketing site in `apps/site` is the one place the vendor name "Bespoq" and its parent company "Dotsquares" appear; both are on the brand deny list for the product) (UI, titles, emails, PDFs, errors, API responses, docs). Everything comes from `settings`. The one exception is `modules/assistant/providers.json`: the AI providers an admin picks from, named so admins can recognise them (the user asked for this on 2026-10-30). It is read at run time, never bundled, and is the only file the brand check skips; the assistant's own name always comes from its settings. Workspace packages are named `@app/*`. The fallback app name is "CRM".
3. **No hardcoded colors** in `apps/web/src`: no hex/rgb literals and no Tailwind palette classes (`bg-blue-500`). Use theme tokens (`bg-primary`, `text-ink`, `border-line`). The only exception is `theme/defaults.ts`.
4. **Vocabulary everywhere.** All user-facing copy goes through i18n keys that interpolate entity labels (`"New {{entity.deal.singular}}"`). Never put an article before an entity name ("a/an Member").
5. **Fixed core entities + custom fields, plus admin-defined objects within guardrails.** Core entities are fixed. Admins may define up to 20 objects (Settings → Objects, Phase 6c): each is a name, an owner, links to core entities and custom fields, on the shared records engine, with the same scope, field-visibility and audit paths. No per-object code, workflows or schema beyond that. Industry tables with their own logic still ship as modules (`m_<key>_*` tables).
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
| exceljs                                                                                         | Reads Excel (.xlsx) files for import, next to CSV (first sheet, values only)    |
| yazl                                                                                            | Streaming ZIP for personal data exports (no native code)                        |
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
| @tiptap/* (MIT core only, no Pro or cloud extensions)                                           | Rich text editor: headless, so it takes theme tokens; Markdown, tables, menus   |
| marked                                                                                          | Renders in-app help articles (already installed with the editor's Markdown)     |
| i18next, react-i18next                                                                          | Locale files + vocabulary interpolation                                         |
| qrcode                                                                                          | 2FA setup QR code                                                               |
| @fontsource/*                                                                                   | Self-hosted fonts selectable from branding (no external font CDN)               |
| astro, @astrojs/sitemap, @astrojs/check                                                         | Static marketing site (`apps/site`), sitemap, type checks                       |
| gsap                                                                                            | Marketing-site animation (hero intro, industry re-tailoring)                    |
| @fontsource-variable/*                                                                          | Self-hosted marketing-site fonts                                                |
| vitest 5, supertest, @testing-library/*, jsdom, @playwright/test                                | Tests                                                                           |
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
npm run mcp                      # stdio MCP bridge (MCP_URL, MCP_TOKEN); run with npx tsx for clients, so npm's banner never reaches stdout
npm run check:brand              # white-label grep over build output, templates, blueprints, locales
npm run doctor                   # Node/MySQL versions, sql_mode, TRIGGER privilege, binlog, SMTP
npm run cli -w @app/api -- user:reset-password --email=<email>
npm run cli -w @app/api -- demo:seed [--password=..]   # one demo user per role; shown on sign-in only with DEMO_MODE=true
npm run demo:reset -- --industry=<slug> [--yes]        # wipe the demo DB and install one industry with sample data (demo instances only)
npm run cli -w @app/api -- module:new --key=<module> --entity=<entity> --plural=<Plural> [--personal]  # scaffold a module with one record type
npm run cli -w @app/api -- module:new --integration --key=<module> --name=<Name>  # scaffold an integration (settings, event job, connection test)
npm run module:check [-- <key> ...]   # module rules: manifest, help, imports, m_<key>_* tables, unsafe APIs, brand names
npm run module:add -- <key> [--catalog=<url|file>] [--update]  # bring a catalog module in at its pinned commit, for review
npm run mcp:dev                  # developer MCP server for AI coding agents (files only; see docs/ai-agents.md)
```

API tests drop and recreate `crm_test` on every run (`apps/api/test/global-setup.ts`). E2E (`npm run test:e2e`) drops and reinstalls `crm_e2e` and starts its own API (:4300) and web (:5300).
Run test suites one workspace at a time on this machine; running all three in parallel can be killed for memory. The whole API suite in one process can also be killed (exit 137): run it in two halves (in zsh, `${=files}` splits a list of paths).
Before an E2E run, check nothing listens on :4300/:5300. A leftover API from an earlier run answers instead of the new one, with module state cached from the old database.
`TEST_LOG_LEVEL=error npx vitest run` shows API errors that tests otherwise swallow as 500s.

## Backend conventions

- **Layering:** `routes → controller → service → repository`. Controllers parse and respond only. Services hold business rules, permission/scope/field-visibility checks, and audit. Repositories hold SQL.
- **Access gate** runs before a route's `before` middleware (uploads are never parsed for unauthorized callers) and enforces module state, permission and required 2FA enrolment.
- **Grants:** non-admins can only grant permissions/scopes they hold (`core/rbac/grants.ts`); `*` belongs only to the system Admin role; only admins can change admin accounts.
- **Route order:** static paths (`/deals/board`, `/contacts/export`) must be registered before `/:uuid` routes. A test fails on shadowed routes.
- **Domain events** (`core/events/events.ts`) are emitted by services after commit; webhooks and automations subscribe and enqueue jobs. New record types must emit created/updated/deleted.
- **Pipelines** serve deals and, behind `features.leadPipeline` (off by default), leads, and behind `features.taskPipeline` (off by default) tasks, calls and meetings (`STAGED.activity`). For tasks the won stage means done: `taskStageColumns`/`stageForCompletion` (`core/activities/task-stage.ts`) keep stage and `completed_at` in step on every path; bulk stage moves use `outcomeColumns`. Board, stage move, positions and stage history live in `core/pipelines/stage-engine.ts` and `board.ts` for both; new staged entities go through `STAGED` there. Turning the lead pipeline on (`enableLeadPipeline`) creates a starter pipeline when none exists and places stage-less leads by status. Lead `status` stays independent of stages; conversion is still the Convert action.
- **Jobs:** `enqueue`/`registerJob` in `lib/jobs.ts` (in-process, or BullMQ with `REDIS_URL`); recurring work uses `every()`, which takes a Redis lock per tick. A runner claims a job (`queued` → `running`) with a conditional update; `recoverStaleJobs` fails work a stopped process left behind. Job errors stored for people are our `AppError` text or a plain message, never raw errors.
- **Outbound HTTP to user-supplied addresses** goes through `lib/safe-net.ts` (`isPrivateAddress`, `safeLookup`, `safePost`) so the address checked is the one connected to; never test an address with string prefixes. Crashes are fatal (`lib/crash.ts`, optional `ERROR_WEBHOOK_URL`).
- **`demo:reset` is guarded to demo instances** (`apps/api/src/cli/demo.ts`): `DEMO_MODE=true`, a database name containing `demo`, a `STORAGE_DIR` whose own folder name contains `demo` and which holds neither the app nor a home folder, and a database that is empty or carries the `demo_reset_marker` table (written right after emptying, so failed resets can be retried). `resetDemo` re-checks all of them itself. Keep every guard; it drops tables. Admins can also switch from Settings → Security (`POST /settings/demo/switch`, `startDemoSwitch`): it runs `resetDemo` in-process in the background, then clears the settings, access, label, custom-field and module-state caches; progress is public at `GET /public/demo/switch` because the wipe signs everyone out. Its test runs the CLI in a child process against `crm_test_demo`.
- **Captured test mail is shared across test files:** filter by recipient (`takeMail().filter(m => m.to === …)`), never assert on the whole mailbox.
- **Tests share one database:** a test that creates a _required_ custom field must archive it before it ends, or other files' creates fail.
- **Module settings** are declared in the manifest (`settings` fields) and stored in `module_states.settings`; secrets are encrypted (AAD `module_states.settings.<module>.<field>`), never returned (`{ set }`), redacted in audit and re-encrypted by `crypto:rotate`. Modules read them with `getModuleSettings`. `testConnection` errors reach people only as `AppError` messages. The assistant may not call `/modules/:key/settings` or `/test`.
- **Module development and submission** guide: [docs/module-development.md](docs/module-development.md).
- **Module catalog** (`MODULE_CATALOG_URL`, `modules/catalog.ts`) is read-only in instances; code arrives only through `module:add` into a checkout (pinned SHA, `checkModuleFolder`) and a normal release. Run-time upload and in-product generation are design only (phase-8 8d, 8f).
- **Modules** import only from `@app/api/module-api`; tables are `m_<key>_*` (hyphens as underscores); list new modules in `apps/api/src/modules/installed.ts`.
- **Admin-defined objects** (`core/objects/`) are record types with the reserved module key `custom` (`CUSTOM_OBJECTS_KEY`; no module may use it). Each has its own table `m_custom_<key>`, created by `ensureObjectTable` outside transactions, and is loaded by `loadCustomObjects()` at boot and after every change. Records are served by `/o/:object/...`, resolved per request (routes are `authenticated`; the records services check `custom.<key>.<action>`). Archived objects stay registered (DDL reconcile, privacy) but `findRecordDef` answers undefined. Objects that link to contacts or leads get a generated privacy handler (export lists linked records; erasure removes the link). Paths come from `recordTypePath()` in `@app/shared` (`o/<route>` or `m/<module>/<route>`).
- **Recurring tasks:** completing a task with `recurrence` (any path: Complete, PATCH, board move) calls `spawnNextOccurrence` in the same transaction; it never spawns twice from one parent (`recurrence_parent_id`) and computes dates in the workspace time zone (`nextOccurrence` in `@app/shared`).
- **Automation timing:** delayed runs wait in `automation_queue` and scheduled rules use `automations.next_run_at`; `runDueAutomations()` (every minute, `startAutomationScheduler`) claims each row with a conditional update before releasing it. Tests call `runDueAutomations()` directly.
- **Report builder** (`core/reports/builder.ts`) groups only by whitelisted columns (`GROUP_TABLES` for relations: configuration tables, never people's records) and runs as the viewer through `scopedQuery` + `applyListCriteria`.
- **Tools** (`core/tools/`, `defineTool`) are the one place AI clients and the assistant act. Handlers call services as the user (never SQL), so permissions, scope, field visibility, access log and audit apply. Write tools set `write: true` (hidden from read-only tokens; the assistant confirms them). MCP (`core/mcp/mcp.routes.ts`) runs tools with `user.via = 'mcp'`, which becomes the audit `actor_type`.
- **Assistant** (`modules/assistant`) talks to providers only through the two wire formats in `api/providers.ts`; never put a vendor name, URL or vendor-specific header in code (the brand check scans `modules/`). Provider names, addresses, headers and recommended models live only in `providers.json` (`api/catalog.ts` reads it). Picking a provider sets format, address and headers server-side; the saved key is only ever sent to the address it was saved for (also when listing models). **Other compatible API** may run without a key; `compatible` in `providers.json` lists starting points (names stay in that file). Private model hosts are reachable only when the operator lists the exact `host:port` in `ASSISTANT_PRIVATE_HOSTS` (`assertSafeModelUrl`, `assertSafeUrl`'s `privateHosts`); never widen that to `WEBHOOKS_ALLOW_PRIVATE`. **Workspace setup** (`setup_enabled`, off by default) adds `api/setup-tools.ts` for admins only; it runs `applySetupDraft`/`addPreset` (`blueprints/workspace-setup.ts`), which apply blueprints in `add` mode: missing items are created as admin-owned (`customized = 1`, no `source_blueprint`), existing ones are left alone except labels and settings, and nothing is recorded as the workspace's blueprint. Provider errors are rewritten so their text never reaches people. Write tools wait for the person's decision (`pending` on the conversation).
- **Assistant configuration** (`modules/assistant/api/config-tools.ts`, admins with setup on): `config_read`/`config_change` call the app's own routes in-process through `callRoute` (`http/routes.ts`: module gate, permission, 2FA gate, Zod, then the handler, so audit and rules apply; routes with `before` middleware are refused). Areas come from `routeRegistry` by prefix; never DELETE, never the `NEVER` paths (security, compliance, MCP, commerce, demo, uploads, reveal, export, preview, run, render). `assertSafeChange` adds: no `auth.*` templates, no email sender, no `send_email` automations, no team membership, no `*`, no Admin role, existing roles may only lose access. `precheckConfigChange` runs before a change is proposed, so impossible changes never reach the admin, and the confirm card's main line comes from `describeChange` on the server. A new config route under an allowed prefix becomes available to the assistant automatically: check it against these guards.
- **AI setup mode** (`modules/assistant/api/setup.ts`, `/m/assistant/setup`, admins only): sessions in `m_assistant_setup_sessions`; the website is read once (`readWebsite`: `assertSafeUrl`, manual redirects, size and time caps); the build runs the preset engine in add mode plus `callRoute` as the admin. Imports read CSV or Excel (`parseTable`, exceljs); `POST /imports/check` is a dry run in a rolled-back transaction. Model replies go through `askJson` (one retry); excluded record types never send sample rows to the model.
- **OAuth for MCP** (`core/oauth/oauth.ts`): discovery at the site root (`oauthWellKnownRouter`, mounted before `/api`), `/oauth/register|token|revoke` are public and CSRF-exempt, the approval page is `/oauth/authorize` in the SPA. Access tokens (`mat_…`) authenticate only `TOKEN_PATHS`, like personal tokens. `burnUserTokens` revokes personal and OAuth tokens.
- **Personal access tokens** (`pat_…`, `core/tokens/tokens.ts`) authenticate only paths in `TOKEN_PATHS` (`/api/v1/mcp`); elsewhere they authenticate nobody. A read-only token's `can()` allows only `.view`.
- **Module record types** (`defineRecordType`, generated by `module:new`) run on the core records engine. Entity keys are open strings (`RecordEntity`). Resolve them with `getRecordDef`/`findRecordDef` or validate them with `recordEntitySchema`, never `recordDefs[entity]`, so a disabled module's types answer 404. Iterate `customizableEntities()` instead of `CUSTOMIZABLE_ENTITIES`, and `scopedResources()` instead of `SCOPED_RESOURCES`. `registerRecordType` also fills the table, label, event and scoped-resource registries through setters in those files, which keeps `definitions.ts`, `labels.service.ts`, `events.ts` and `rbac/scoped.ts` free of imports from the registry (that would create a cycle). Optional columns must be nullable, and a create leaves out empty values so column defaults apply.
- **Routes** are registered only through `defineRoute({ method, path, permission, schema, handler })`. `permission` is a key, `'public'`, or `'authenticated'`. A test fails if any Express layer lacks a registry entry.
- **Permission keys** follow `<module>.<resource>.<action>`. Wildcards: `*`, `core.contacts.*`.
- **Record scope** (`own | team | all`) is applied in the repository from a service-supplied `ScopeContext`. An out-of-scope single-record read returns **404**.
- **Field visibility** (custom fields): strip `hidden` from every response, export, search result, and timeline diff. Writing to `read`/`hidden` → `403 FIELD_FORBIDDEN`.
- **PATCH schemas** always use `toPatch(createSchema)` from `@app/shared`, never `.partial()`: Zod 4's `.partial()` keeps `.default()`, so a one-field PATCH would reset every defaulted field.
- **Commercial documents** (quotes, invoices, contracts) are modules that share `core/commerce/documents.ts`: gap-free numbering (`nextDocNumber`), scope-checked links (`resolveLinks`), and server-computed line totals (`saveLines`). Money math lives in `packages/shared/src/commerce.ts` (integer cents) so web previews match the API.
- **Compliance profile** (`standard | privacy | hipaa`, settings group `compliance`) sets enforced floors (`PROFILE_FLOORS` in `packages/shared/src/compliance.ts`). Read security and compliance settings through `effectiveSecurity()` / `effectiveCompliance()`, never `getGroup('security')`, so floors apply even to stale stored values. PATCH rejects values below a floor; changing the profile raises stored values.
- **Idle timeout** is decided from stored `sessions.last_used_at` only. The `x-idle-ms` header (ms since the last keyboard/pointer input, sent by `lib/api.ts` only after real input) can move that clock forward, never decide expiry, so a missing or forged header can't revive an idle session and polling/refresh don't count as activity. The web idle timer pings `POST /me/activity` after input. Rotated sessions carry `family_started_at` and `last_used_at` (`SessionCarry`). Security and compliance settings are admin-only.
- **Validation:** Zod on every body, query, and param. Custom fields use the runtime schema from `SchemaBuilder`.
- **SQL:** parameterized only. Identifiers from user input (custom field keys) must match `^[a-z][a-z0-9_]{0,48}$` **and** be resolved through `custom_field_definitions`. Never interpolate request values into `knex.raw`.
- **Audit:** every mutation writes an `audit_logs` row in the same transaction. Audit is append-only (DB triggers). The only exceptions are the privileged privacy anonymize path (`@audit_redaction`, then `resealDays()` for sealed days) and the retention job (`@audit_purge`, only on sealed days).
- **Encryption:** use `encrypt`/`decrypt`/`encryptBuffer` from `lib/crypto.ts` (key ring, `ENCRYPTION_KEYS`); never use `ENCRYPTION_KEY` directly. Read stored files through `readStoredFile()` (decrypts when `files.enc_kid` is set), never `storage.get` on its own. Sensitive (`special`) custom field values are stored as `enc:` strings and leave the API only as `SENSITIVE_MASK`; a new place that reads raw `custom` must mask (`maskEncrypted`) or, on privileged paths, `decryptCustom`. A new table with encrypted columns must be added to `crypto:rotate` (`core/security/rotation.ts`).
- **Personal data in modules:** a module that stores data about contacts or leads returns `privacy: PrivacyHandler` from its `ApiModule` (export + erase); core erasure (`core/privacy/privacy.service.ts`) also clears email copies, webhook payloads, jobs, automation logs and notifications. A new core table that copies personal data must be added there.
- **Restriction and opt-out:** automations, webhooks and CRM email skip events that touch a restricted person (`eventTouchesRestricted`, `restrictedRecipients` in `core/privacy/privacy.service.ts`); automated email to a contact/lead checks `marketing_opt_out` and adds the unsubscribe link. New outbound channels must do the same.
- **CSV exports** pass every cell through `csvSafe()` (`lib/csv.ts`) so spreadsheet formulas never run.
- **Merged contacts** keep their soft-deleted rows (`merged_into_id`). Anything that acts on a person (erasure, export, unsubscribe) must follow them (`subjectRows()`).
- **Access log:** reads of personal data call `logAccess(ctx, …)` (`core/audit/access-log.ts`); it is a no-op unless `accessLogging` is on and never throws. New record detail, download or export paths must call it.
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
- **Lists link their rows.** `DataTable` takes `rowHref` so the title cell is a real link (Tab, Enter, open in a new tab); a plain click still opens the peek. Its keyboard cursor stays hidden until the first key press or click.
- **Every data view** has loading (skeleton matching the layout), empty (next action + one primary button), and error (what failed + how to fix) states.
- **Product patterns** (plan §9): `⌘K` command palette, keyboard shortcuts, record peek sheet, inline edit with undo toast, saved views as tabs, virtualized tables with bulk bar, Kanban with dnd-kit.
- **`Button asChild`** renders its single child only (Radix Slot needs exactly one child).
- **Never `import * as Icons from 'lucide-react'`** (pulls every icon into the bundle). Module menu icons come from the curated map in `app/shell/nav.ts`.
- **Accessibility:** labelled inputs, visible focus, focus trap in dialogs and sheets, AA contrast, full keyboard reach, `prefers-reduced-motion`.
- **RTL-ready:** use logical properties (`ms-`, `pe-`, `start-`, `end-`), never `ml-`/`pr-`/`left-`/`right-`.
- **Motion:** 120–200 ms with the `--ease-out` token (it is also Tailwind's `ease-out`), only in response to user actions; never on keyboard-driven ones (`j`/`k`, `⌘K`, `c`). Overlays use the `anim-pop`, `anim-fade` and `anim-sheet` classes in `styles.css`. Their exits (about 120 ms) need their own keyframes, because Radix keeps an element mounted only while a differently named exit animation runs, and a closing overlay has `pointer-events: none`. Buttons and nav links scale slightly on press. Tests must find a dialog by name, since the one that is closing is still in the page for a moment.
- **Stage colors** are named keys (`STAGE_COLORS` in `packages/shared/src/stages.ts`), never hex. `applyBranding` sets `--stage-<key>`/`--stage-<key>-fg` per mode; render with `stageStyle()`, `StageDot` or `StageBadge` (`components/data/stage-color.tsx`) and the `bg-(--sc)` / `stage-soft` classes.
- **Elevation, type and touch:** use `shadow-raised` and `shadow-overlay` (derived from brand tokens; dark mode darkens the canvas instead of glowing) and `text-title` for page titles. `--faint` and `--muted` text must stay at 4.5:1 or better on surface, canvas and subtle backgrounds. Controls grow under `pointer-coarse:` (36–40 px) and inputs use 16 px text there so iOS does not zoom.
- **Auth tokens** live in httpOnly cookies only. Never use localStorage or sessionStorage for tokens. The API client sends `X-CSRF-Token` and does a single-flight refresh on 401.
- **Module pages** link with absolute paths, and buttons inside forms that are not submits need `type="button"`. Restart `npm run dev` after adding a module folder (Vite globs module entries at startup). Module web entries live outside `apps/web`, so `styles.css` declares `@source '../../../modules'`; without it, Tailwind classes used only in modules are never generated.
- **The app may run under a sub-path** (`/app` in the single-server setup, `APP_BASE_PATH`). Navigate with the router; links that leave it (new tabs, copyable URLs) use `appUrl()`/`basePath` from `lib/app-url.ts`, never a bare `/path` or `window.location.origin`.
- **Shared-clock screens** (bookings board, front desk) show the workspace time zone via `lib/zoned.ts`, never the browser's, because the server validates in the workspace zone.
- **Rich text** goes through `RichTextEditor` (`components/editor`), never a raw `Textarea`. It emits HTML; the server sanitizes it again (`sanitizeBody` for notes and email, `sanitizeDocumentHtml` for documents), and `basic` mode only produces tags `sanitizeBody` keeps. Placeholders are stored as plain `{{path}}` text. Pass `mergeFields` for templates and `replies` (`useSavedReplies`) where people write to a record. Show stored HTML inside `.rte-prose`. Notes are never compiled as Handlebars; only templates are.
- **Copy:** sentence case, active verbs. A button and its resulting toast use the same verb ("Archive" → "Archived").
- **In-app help:** every page has a help article (`apps/web/src/help/articles/*.md`, module pages in `modules/<key>/help/*.md`), found by the `route` in its front matter and opened from the ⓘ in `PageHeader`/`SettingsPage` or with `?`. Use vocabulary placeholders (`{{dealPluralLower}}`, `{{appName}}`; quote them in front matter) and generated tables (`<!-- generated:settings:<group> -->`, `<!-- generated:permissions:<prefix> -->`, `<!-- generated:tools -->`) instead of retyping values. Every setting needs a `SETTINGS_HELP` entry (`packages/shared/src/settings-help.ts`; it does not compile otherwise). `src/help/help.test.ts` fails when a page, module or setting has no help, or help names something that no longer exists. The help sheet and articles load lazily; never import `help/registry` from shared components.
- **Guided tours** (`src/help/tours.ts`, engine in `components/tour/tour.tsx`) point at `data-tour="<target>"` attributes; the help test fails when a target disappears. Finished tours are stored per person (`POST /me/tours/:tour/seen`, `me.toursSeen`). The welcome tour is offered once as a non-blocking message, never forced.

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
5. Keep this file updated with new decisions, commands, and gotchas as they are learned. Preferences and lessons about how to work go in `docs/agent-notes.md`.
6. Reusable procedures live in `.claude/skills/*/SKILL.md` (feature-slice, phase-report) and review checklists in `.claude/agents/*.md`. They are plain Markdown: agents without skill support read and follow them directly.

## Local environment notes

- **No Docker, anywhere.** No Dockerfiles, Compose files, or container-based tooling (including Testcontainers and CI service containers). Everything runs natively.
- Dev machine: Homebrew MySQL (server 26.7, root without password, binlog on, `log_bin_trust_function_creators=0`) and Mailpit (SMTP `localhost:1025`, UI `http://localhost:8025`) are already running as brew services. Databases are `crm_dev` and `crm_test`. Redis is not installed; Phase 1 doesn't need it, and Phase 2 will add it via `brew install redis`.
- CI: GitHub Actions installs MySQL 8.4 natively on the runner.
- Production: the built API runs under systemd behind nginx, which serves `apps/web/dist` and proxies `/api` same-origin. One server or vhost, database, and `.env` per client instance.
- The minimum supported MySQL is 8.4 LTS. Don't rely on features newer than 8.4 just because dev runs a newer server.
