# Phase 6 plan: gap review, custom entities, MCP server, AI assistant

Status: **decisions recorded 2026-10-26**. No code has been written for this phase.

Sources: a read-only sweep of `apps/api`, `apps/web`, `packages/*` and `modules/*`, plus [roadmap.md](../roadmap.md). Items marked _(verify)_ come from code search and still need confirming by reading the code. **F** means the item is already on the roadmap's Future list.

Severity: **B** blocker · **I** important · **N** nice-to-have. Effort: **S / M / L**.

---

## 1. Gaps in existing features

### Access and security

| Area | Exists | Gap | Sev | Eff |
|---|---|---|---|---|
| Auth | Password login, TOTP 2FA, sessions, invites, reset (`core/auth/*`) | SSO (OIDC; SAML later) | I | L |
| | | Org-wide password policy _(verify)_ | I | S |
| | | Login history UI, IP allowlist | N | M |
| RBAC | Roles, own/team/all scopes, grants (`core/rbac/*`) | Record-level sharing **F** | I | M |
| | | Manager hierarchy: managers see their reports' records | I | M |
| | | Field-level security on core columns **F** | I | M |
| Users | Disable/enable (`core/users/users.routes.ts`) | Transfer all of a user's records on disable | I | S |
| API keys | Role-bound `sk_` service keys (`core/api-keys/api-keys.ts`) | Personal access tokens tied to a user (needed for MCP) | I | M |

### Records

| Area | Exists | Gap | Sev | Eff |
|---|---|---|---|---|
| Duplicates | Check and merge for contacts/organizations (`core/records/merge.ts`) | Duplicates and merge for leads and deals | I | S–M |
| | | Configurable match rules | I | M |
| | | Review queue | N | M |
| Leads | Convert (`/:uuid/convert`) | Match existing contact/organization on convert _(verify)_ | I | S |
| | | Round-robin assignment | I | M |
| | | Scoring | N | M |
| Deals | Pipelines, board, stage history | Forecast categories and period roll-ups | I | M |
| | | Quotas/targets | I | M |
| | | Velocity reports **F** | I | M |
| | | Product line items driving deal value | I | M |
| | | Contact roles on a deal | N | M |
| | | Multi-currency | N | M |
| | | Kanban "Move to stage" menu **F** | N | S |
| Organizations | — | Parent/child hierarchy _(verify)_ | I | M |
| Activities | Tasks, calls, meetings, notes, email; reminders; calendar | Recurring activities | I | M |
| | | Multiple participants **F** | I | M |
| | | Google/M365 calendar sync **F** | I | L |
| Email | SMTP + IMAP sync with app passwords (`core/email/email.ts`) | Sequences/cadences | I | L |
| | | OAuth mailboxes **F** | I | M |
| | | Threaded view and reply **F** | I | M |
| | | Open/click tracking | N | M |
| | | Bulk send with unsubscribe | N | M |
| Custom fields | Real columns via DDL, layouts | Validation rules, conditional visibility | N | M |
| | | Formula/rollup fields | N | M |
| Import | Start, status, errors CSV, export | Update existing records on match _(verify)_ | I | M |
| | | Undo an import | N | M |
| Files | Local storage driver | S3-compatible driver **F** | I | M |
| | | Inline preview | N | S |

### Privacy and audit

| Area | Exists | Gap | Sev | Eff |
|---|---|---|---|---|
| Privacy | Phase 5 shipped data subject requests, export, erasure, consent, restriction and retention (`core/privacy/*`, `docs/compliance/`) | None open | — | — |
| Audit | Append-only log plus UI | Field-history panel on records | I | S–M |

### Platform

| Area | Exists | Gap | Sev | Eff |
|---|---|---|---|---|
| Automations | Event trigger, filter condition, 5 action types (`core/automations/automations.ts`) | Time-relative and scheduled triggers, delays, branching | I | M |
| | | Webhook and create-record actions | I | S |
| | | Run history UI | I | S |
| | | Module-registered action types | I | M |
| Search | Contacts, organizations, deals, leads (`core/search/search.routes.ts`) | Activities, emails and module records; provider registry | I | S–M |
| Reports | Blueprint dashboards, module widgets | Report builder (group-by, aggregate, chart) | I | L |
| | | Dashboard editing in the UI **F** | I | M |
| | | Scheduled report emails | N | M |
| Modules | Own tables, routes and pages (`modules/*`, `module-api.ts`) | Modules can't use the core records engine, so module records get no custom fields, views, search, import/export or automations | I | L |
| Jobs | `every()`, BullMQ | Cron expressions | N | S |
| Blueprints | Fields, pipelines, roles, layouts, dashboards | Can't ship automations, templates or webhooks _(verify)_ | I | S |

### Web UX

| Area | Gap | Sev | Eff |
|---|---|---|---|
| Tables | ~~No virtualization in `components/data/data-table.tsx`~~ Not needed: lists are server-paginated (`pageSize` max 100), so a page never holds more than 100 rows. Revisit only if a view needs infinite scroll. | — | — |
| | No inline cell edit | N | M |
| i18n | About 140 hard-coded strings; 21 of 59 files use `useT` **F** | I | L |
| Onboarding | No first-run checklist or setup flow | I | M |
| Trash | Delete dialog points to a trash screen that doesn't exist | I | S |
| ⌘K | No create commands or recent items | I | S |
| States | Shared loading/empty/error states used in only about 26 of 59 component files | I | M |
| Mobile | No card layout for tables, no responsive Kanban | I | M |
| Notifications | Inbox page, preferences **F**, realtime push | N | M |
| Kanban | Boards for leads and tasks | N | M |
| a11y | Untranslated `aria-label`s; no automated axe check | I | M |

---

## 2. Missing features worth adding (ranked)

1. **Records engine for modules, then custom entities** (§3): this unlocks every vertical module.
2. **MCP server** (§4) and **AI assistant** (§5): differentiators that share one tool layer.
3. **Report builder and editable dashboards:** every industry asks for these.
4. **Forecasting and quotas:** sales-led blueprints (generic, visa-consultancy).
5. **Email sequences, OAuth mail and calendar sync:** sales and service.
6. **Scheduled automations with delays:** renewals, follow-ups, coworking membership expiry.
7. **SSO:** larger clients.
8. **Record sharing and manager hierarchy:** larger teams.
9. **Onboarding flow, trash screen, ⌘K create commands:** cheap polish.

---

## 3. Custom entity module

**Conflict.** Non-negotiable #5 forbids a "define any entity" engine.

**Recommendation:** build this in two steps. The first step is needed whichever way you decide.

**6b: records engine for modules (no rule change).**
- Generalise `ResourceDef` (`core/records/types.ts`), `CoreEntity` and `CUSTOMIZABLE_ENTITIES` (`packages/shared/src/entities.ts`) so a module can register a resource.
- A registered module resource automatically gets:
  - custom fields (`core/custom-fields/ddl.service.ts`)
  - saved views, search, import/export and bulk actions
  - automations, timeline and audit
  - the generic list/detail/Kanban UI (`features/records/*`)
- Add a scaffolding CLI, `npm run cli -- module:new --key=properties --entity=property`. It generates a code-reviewed module: an `m_properties_*` migration, a resource definition, a manifest and permissions.
- This complies with #5. A developer still makes each new entity.

**6c: admin-defined entities (#5 amended, approved).**
- Admins create entities in Settings → Objects. Storage is a fixed set of tables, `custom_objects` (definitions) and `custom_records` (core columns, owner, team, `custom` JSON, `object_id`), with generated columns from the existing DDL service.
- Guardrails:
  - at most 20 objects
  - no per-object tables and no runtime DDL beyond the existing custom-field pass
  - permissions are generated as `custom.<key>.<action>`
  - every record goes through the same scope, field-visibility and audit paths as core records
- Relations: lookup fields to core entities and other objects. The timeline shows linked records.
- Blueprints can seed objects (with `source_*`/`customized` columns as usual), so industry objects stay configuration rather than forks.


---

## 4. MCP server

- **Transport:** Streamable HTTP at `POST /api/v1/mcp`, same origin. Also a stdio wrapper, `npm run mcp`, for local clients.
- **Auth:**
  - New **personal access tokens** (`pat_…`, stored as a sha256 hash, with expiry and per-token scopes no wider than the user's own permissions).
  - Issued from Profile, so every call runs **as that user**.
  - OAuth 2.1 for MCP clients comes later.
  - The existing role-bound API keys also work, for service use.
- **Enforcement:** tools call the **service layer**, never raw SQL. That gives them the same `assertCan`, scope, field-visibility stripping and audit as the UI. Audit rows are tagged `via: mcp` with the token id. Rate limits are per token (`middleware/rate-limit.ts`). Hidden fields never appear in tool output.
- **Tools:** a curated set, not every route. Each is generated from a `defineTool({ name, permission, input: zod, handler })` registry next to `routeRegistry` (`http/routes.ts`), so module tools plug in the same way.
  - Read: `search_records`, `get_record`, `list_records` (filter AST), `get_timeline`, `list_pipelines`, `describe_schema` (entities, fields, vocabulary; visible fields only).
  - Write: `create_record`, `update_record`, `log_activity`, `create_task`, `move_deal_stage`, `add_note`.
  - Resources: `crm://schema` and `crm://record/{entity}/{uuid}`.
- **White-label:** the server name and descriptions come from `settings` (app name). No vendor names.
- **Admin control:** MCP can be switched on or off in Settings → Integrations, and each tool can be allow-listed.

---

## 5. AI assistant (in-app)

- **UI:** a side panel at the end edge of `app/shell/app-shell.tsx`, held in an `AssistantProvider` next to `CommandPaletteProvider`. On mobile it becomes a sheet.
  - Opened from a TopBar button, a hotkey, or an "Ask…" command in ⌘K.
  - Record pages and the peek sheet publish the current record as context.
- **Backend:** `core/assistant/`. A tool-use loop over the **same tool registry as MCP**, run as the signed-in user. Replies stream over SSE; `lib/api.ts` needs a stream helper.
- **Writes:** the model proposes an action and the UI shows a confirmation card (diff preview). Only "Confirm" runs it. Every executed action is audited with `via: assistant`.
- **Provider:**
  - Admin settings group `ai`: provider, model, API key encrypted with `lib/crypto.ts`, monthly token cap, per-user daily cap.
  - Behind a provider interface (chat, tool calls, streaming, token usage), with adapters for Anthropic, OpenAI-compatible endpoints, and cloud-hosted variants. There is no default provider: an admin picks one.
  - The assistant is disabled until an admin configures it.
- **Data handling:**
  - Only fields visible to the user are sent to the model.
  - Admins can exclude entities or fields from AI.
  - A usage log (tokens and cost per user) is shown in settings.
  - No conversation content is stored in the audit log; conversations are kept per user for 30 days (configurable).
- **White-label:** the assistant's name is a setting (default "Assistant"). No provider name appears in the UI or in errors.
- **First skills:**
  - Q&A over records ("deals closing this month over 10k")
  - summarise a record's timeline
  - draft an email or note
  - create tasks from a meeting note
  - bulk-update suggestions, each confirmed one by one

---

## 6. Milestones (proposed order)

| Branch | Content | Why this order |
|---|---|---|
| `phase-6a-quick-wins` | Trash screen; record transfer on disable; ⌘K create commands. **Done.** Table virtualization dropped (see §1: pages are capped at 100 rows) | Cheap, visible fixes |
| `phase-6b-records-engine` | ResourceDef for modules; module scaffolding CLI; search provider registry | Prerequisite for 6c and for good MCP coverage |
| `phase-6c-custom-objects` | Admin-defined entities (#5 amended) | Builds on 6b |
| `phase-6d-tool-layer-mcp` | `defineTool` registry; personal access tokens; MCP endpoint and stdio wrapper | Shared foundation for AI |
| `phase-6e-assistant` | AI settings, provider interface, chat panel, confirmed writes, usage caps | Needs 6d |
| `phase-6f-sales-depth` | Forecasting, quotas, velocity reports, deal line items | Highest-value CRM gaps |
| `phase-6g-automation-reports` | Scheduled/delayed automations, more action types, report builder, dashboard editing | Larger platform work |
| later | SSO, OAuth mail and calendar sync, sequences, i18n extraction, S3 driver, sharing and hierarchy | Larger or external-integration items |

Each milestone ships with tests, docs and a `phase-report`, per CLAUDE.md.

## 7. Decisions

| # | Decision | Outcome |
|---|---|---|
| 1 | Amend non-negotiable #5 | **Yes.** Admin-defined objects are allowed under the §3 guardrails. CLAUDE.md is updated when 6c starts. |
| 2 | AI provider | **Multiple providers from day one.** A provider interface with Anthropic, OpenAI-compatible (which also covers self-hosted endpoints) and Azure/Bedrock-style adapters. Provider choice and model are admin settings, and no provider names appear in the UI. 6e grows from M to L. |
| 3 | Milestone order | **As proposed** (6a → 6g). |
| 4 | Assistant packaging | **Tool layer and MCP in core; assistant ships as module `assistant`.** Reasons: it can be sold and priced as a separate add-on, deployments that don't want AI (for example under the `hipaa` profile) leave it out entirely, and it proves the module SDK is strong enough for a large feature. Under the `hipaa` profile the module needs an explicit admin acknowledgement before it can be enabled, and `special` (encrypted) field values are never sent to a model. |
