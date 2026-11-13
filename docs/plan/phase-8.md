# Phase 8: integrations and module marketplace

Status: 8a, 8b, 8c, 8e and 8g are built. 8d and 8f are designs, not built.

Admins browse, enable, configure and disable modules and integrations in the app. Developers (and their AI coding agents) build custom modules against a documented contract. Modules stay compiled into the release; uploading a module to a running instance is designed here (8d, 8f) and built later.

## Milestones

| Milestone | Scope |
| --------- | ----- |
| 8a | Module settings framework (API): typed `settings` fields in the manifest, encrypted secrets in `module_states.settings`, detail, settings, test-connection and upgrade routes, audit |
| 8b | Marketplace UI: card grid with search, categories and Installed / Available / Updates tabs; detail page with Overview, Settings, Permissions and Activity |
| 8c | Example integration (`chat-notify`), `module:new --integration`, developer guide, integration walkthrough, admin help |
| 8g | Module catalog in a git repository: `catalog.json` lists modules at pinned tags and commit SHAs; the marketplace shows them; `module:add` brings one into the checkout for review |
| 8e | Developer MCP server for AI coding agents: scaffold, validate and check modules in the working tree |
| 8d | Design only: signed module bundles uploaded at run time |
| 8f | Design only: an in-product MCP tool that generates a module on a running instance (needs 8d) |

## 8a: module settings

- **Fields.** The manifest gets `settings`: a list of fields, each `{ key, type, label, help, required, default, options }`. The types are `string`, `secret`, `boolean`, `select`, `number` and `url`. Keys match `^[a-z][a-z0-9_]{0,48}$`. The untyped `settings_schema` is removed; no module used it.
- **Storage.** Values live in `module_states.settings` (JSON, existing column). Secrets are stored as `encrypt(value, 'module_states.settings.<module>.<field>')` and leave the API only as `{ set: true }`. Leaving a secret out of a PATCH keeps it; `null` clears it.
- **Reading.** Modules read their values with `getModuleSettings(key)` from `module-api`, which decrypts secrets.
- **Key rotation.** `crypto:rotate` re-encrypts module secrets.
- **Routes:**

  | Route | Does |
  | ----- | ---- |
  | `GET /modules/:key` | Detail |
  | `PATCH /modules/:key/settings` | Saves settings; audit `module.settings_changed`, with secret values replaced by `[changed]` |
  | `POST /modules/:key/test` | Runs the module's `testConnection(settings)`; provider error text never reaches people |
  
  All need `core.modules.manage`.
- **Manifest.** Also gains `category` (`integration | industry | productivity | commerce`, default `productivity`) and `icon`.
- **Assistant.** The assistant's config tools may not change module settings (`NEVER`), because they can hold credentials.

## 8b: marketplace UI

- **Location.** Settings → Modules becomes the marketplace. The detail page lives at `settings/modules/:key`.
- **Settings tab.** The form is rendered from the field list. A saved secret shows as "Saved" with a Replace action.
- **Activity tab.** Lists `module.*` audit rows for the module.
- **Actions.** Disable explains which enabled modules depend on this one.

## 8c: example integration and docs

- **`modules/chat-notify`.** Posts chosen record events to an incoming-webhook URL (a secret setting). It subscribes with `onEvent` and sends through `enqueue`, never inline. It checks the URL with `assertSafeUrl`, skips events that touch a restricted person, and has a `testConnection`.
- **`module:new --integration`** generates settings fields, a `testConnection` stub and the help article.
- **Docs.** `docs/module-authoring.md` gains settings, secrets, versions, connections, events and a release checklist. `docs/integration-authoring.md` walks through `chat-notify`.
- **Help.** A field's `help` text is required; the help test fails without it.

## 8e: developer MCP server

- **What it is.** A stdio MCP server for AI coding agents working in a checkout: `npm run mcp:dev` (`apps/api/src/cli/dev-mcp.ts`). It is separate from the product's MCP endpoint; it acts on files, not on a database, and never ships in the production bundle.
- **Tools.** Each one wraps code that already exists:

  | Tool | Does |
  | ---- | ---- |
  | `module_scaffold` | `scaffoldModule` / `writeScaffold`, including `--integration`; refuses existing folders |
  | `module_validate` | Parses a manifest with `moduleManifestSchema`, checks dependencies, the help article, `installed.ts` registration and settings help |
  | `module_api_reference` | Lists what `module-api.ts` exports, with doc comments |
  | `brand_check` | Runs the white-label check on one module folder |
  | `docs_read` | Returns the developer guide sections |

- **Resources.** `docs/module-authoring.md` and `docs/integration-authoring.md`.
- **Agent guidance.** The server's instructions repeat the module rules from AGENTS.md (tables `m_<key>_*`, imports only from `module-api`, privacy handlers, no vendor names).

## Versions

Startup already runs new migrations of enabled modules (`migrateEnabledModules`), so a new release is installed by deploying it. Startup also records the new `installed_version`; there is no separate upgrade route. "Update available" comes from the catalog (8g).

## 8g: module catalog in a git repository

- **Catalog.** One repository holds `catalog.json`: for each module, `key`, `name`, `category`, `description`, `repo`, `tag`, `sha` and `version`. Instances read it from `MODULE_CATALOG_URL` (unset: no catalog), cached for an hour, fetched through `assertSafeUrl`. The UI never names the hosting service.
- **Marketplace.** Modules in the catalog but not in this build show as "Available from catalog" with the command a developer runs. A catalog version newer than the installed one shows "Update available".
- **`module:add`.** `npm run module:add -- <key>` clones the catalog entry at its pinned SHA into `modules/<key>`, refusing if the tag now points elsewhere. It then runs `module_validate` and the brand check on the folder, adds the module to `installed.ts`, and leaves the change for code review. Nothing is built or enabled automatically.
- **Private repositories.** A read token in the environment (`MODULE_CATALOG_TOKEN`), sent only to the catalog's host.
- **Later (8d).** Signed bundles attached to the catalog's releases become the source for run-time upload.

## 8d: run-time module upload (design only)

- **Bundles.** A bundle is a pre-built API file, a web chunk, `manifest.json` and migrations, signed with an ed25519 publisher key. Trusted keys are listed in `MODULE_PUBLISHER_KEYS`.
- **Installing.** The bundle is verified, unpacked under `STORAGE_DIR/modules/<key>/<version>`, and loaded at the next restart.
- **Limits.** Migrations may only touch `m_<key>_*` tables, and the bundle may not include native dependencies.
- **Decision: signed publishers, no in-process sandbox.** An uploaded module is treated as trusted code, exactly like a module in the release.
  - **Why no sandbox.** Node's `vm` is not a security boundary, and a real one (a worker process talking to the app over a narrow RPC API, with its own database user) would mean a second module API to design, version and keep in step with the records engine, events, jobs and privacy handlers. Modules need the database, so the effort would buy little isolation.
  - **How signing works.** A module installs only if its bundle is signed by an ed25519 key listed in `MODULE_PUBLISHER_KEYS`, which the server operator sets in `.env`. An admin in the app cannot add a key.
  - **Same checks as a release.** `checkModuleFolder` runs on the bundle (imports, `m_<key>_*` tables, no `child_process`/`eval`, brand names), and migrations may touch only `m_<key>_*` tables.
  - **Approval.** Install needs `core.modules.manage` and 2FA, is audited, and takes effect on the next restart.
  - **Untrusted code stays outside.** Code from parties the operator does not trust connects from outside through webhooks, personal access tokens and MCP, never as a module.
  - **Revisit.** Reopen the sandbox question only if modules from unknown third-party publishers become a goal.

## 8f: in-product module generation (design only)

- **What it adds.** A write tool on the product MCP endpoint, admin only, behind a setting that is off by default.
- **How it works.** It generates a module from a spec, builds and signs it, and hands it to 8d's install path, so it depends on 8d. The person confirms before it installs.
- **Admin-defined objects first.** Until then, AI clients that need new record types use admin-defined objects (Phase 6c), which need no code.

## Decisions

| Decision | Reason |
| -------- | ------ |
| Settings in `module_states.settings`, not per-module tables | One audited, encrypted path every module gets for free |
| Secrets write-only | Same as webhooks and the assistant key |
| Developer MCP separate from product MCP | Different trust: files in a checkout vs data in an instance |
| Run-time upload and generation design only | Built later; 8d trust model decided: signed publishers set by the operator, no in-process sandbox |
