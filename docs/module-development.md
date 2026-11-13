# Module development and submission

This is the start-to-finish guide for building a module and getting it into the module catalog, so other instances can add it. It covers the whole path and links to the detailed references:

- [module-authoring.md](module-authoring.md): the module contract (manifest, API, web, record types, settings, help)
- [integration-authoring.md](integration-authoring.md): a worked integration (`modules/chat-notify`)
- [ai-agents.md](ai-agents.md): building modules with an AI coding agent and the developer MCP server
- [integrations.md](integrations.md): how instances read the catalog

## 1. Decide whether it should be a module

Use a module for optional code with its own logic, such as an industry feature, an integration with another service, or a commerce document. Do not write a module for:

| Need                                                       | Use instead                                                      |
| ---------------------------------------------------------- | ---------------------------------------------------------------- |
| Extra fields on contacts, deals and the other core records | Custom fields (Settings → Fields)                                |
| A simple record type with fields and links, no logic       | An admin-defined object (Settings → Objects)                     |
| Labels, pipelines, sample data or settings for an industry | A blueprint in `packages/blueprints/<key>`                       |
| Code from a party the instance does not fully trust        | An outside service using webhooks, personal access tokens or MCP |

A module runs inside the API process with full rights. It is trusted like the rest of the release. See "8d" in [plan/phase-8.md](plan/phase-8.md).

## 2. Ground rules

A module that breaks any of these rules is rejected.

- **White-label.** No vendor, product or company names anywhere: code, copy, help, manifest, comments. Describe other services generically ("a chat service that accepts incoming webhooks"). `brand-denylist.txt` lists the names that the checks look for.
- **One import path.** API code imports from the app only through `@app/api/module-api`; web code never imports API code. Imports from another module are allowed only if that module ships in the same release (`depends_on`).
- **Own tables only.** Name every table `m_<key>_*`, with hyphens in the key written as underscores. Never alter core tables.
- **No process or code execution.** No `child_process`, `vm`, `eval` or `new Function`.
- **Permissions and audit.** Every route declares a permission key `<key>.<resource>.<action>`. Changes go through services that write audit rows, so the records engine and `defineRecordType` handle this for you.
- **Privacy.** If you store data about contacts or leads, return a `PrivacyHandler` (export and erase). Outbound channels must skip restricted people (`eventTouchesRestricted`).
- **No hardcoded colors, and vocabulary everywhere.** Web code uses theme tokens and `useT()` with entity labels, never a hex value or a fixed word like "Deal".
- **Help.** Every page and every setting has help text, and the module ships `help/<key>.md`.

## 3. Create it

From a checkout of the app:

```
# A module with one record type (table, list, detail, form, permissions)
npm run cli -w @app/api -- module:new --key=fleet-log --entity=vehicle --plural=Vehicles [--personal]

# An integration (settings, event handler, background job, connection test)
npm run cli -w @app/api -- module:new --integration --key=chat-relay --name="Chat relay"

npm install
npm run dev   # restart after adding a module folder
```

Keys use lowercase letters, numbers and hyphens, and must be unique across the catalog. Choose carefully: the key names the folder, the tables and the permission keys, and it can never change.

With an AI coding agent, run `npm run mcp:dev`. Its tools `module_scaffold`, `module_validate`, `brand_check` and `docs_read` do the same as these commands and stay inside the checkout.

The result:

```
modules/<key>/
  manifest.json          key, name, version, category, icon, permissions, menu, settings
  package.json           @app/module-<key>
  api/index.ts           ApiModule: routes, record types, events, jobs, testConnection, privacy
  api/migrations/        m_<key>_* tables
  web/                   pages and components (optional)
  help/<key>.md          help article
```

The generator also lists the module in `apps/api/src/modules/installed.ts`.

## 4. Build it

Work through [module-authoring.md](module-authoring.md). The usual order:

1. **Manifest.** Set the name, description, category (`integration`, `industry`, `productivity`, `commerce`), icon, permissions, menu items and `depends_on`.
2. **Data.** Write migrations for `m_<key>_*` tables, or use `defineRecordType` and let the records engine provide routes, scope, field visibility, audit and events.
3. **Settings.** Declare them in the manifest. Use `secret` for anything password-like. Read them with `getModuleSettings(key)` and never build a settings screen.
4. **Events and jobs.** Subscribe with `onEvent`, check `isModuleEnabled` first, and `enqueue` outbound work instead of calling out from the handler.
5. **Outbound calls.** Run `assertSafeUrl` on every address, refuse redirects, set a timeout, and throw `AppError('UPSTREAM_FAILED', …)` with a sentence written for people.
6. **Web.** Add pages under `/m/<key>/…` built from the shared components, with loading, empty and error states.
7. **Help.** Write `help/<key>.md` with step-by-step setup and `<!-- generated:module-settings:<key> -->` for the settings table.

## 5. Test it

Ship tests with the module. Use the patterns in `apps/api/test/chat-notify.test.ts` and `record-types.test.ts`:

- **API (Vitest and Supertest, real MySQL).**
  - Permissions: a role without the key gets 403.
  - `own` scope cannot read other people's records (404).
  - Validation errors (422).
  - Audit rows are written.
  - Events fire and jobs run.
  - Restricted people are skipped.
  - Erasure clears the module's data.
- **Integrations.** Stand in for the other service with a local HTTP server. Test a good and a failing connection test.
- **Web (RTL).** Forms and any custom components.
- **Turned off.** Once the module is turned off, its routes answer 404 and its event handlers do nothing.

Run:

```
npm run module:check -- <key>
npm run typecheck && npm run lint
npx vitest run test/<your-tests>        # in apps/api
npm run check:brand
```

## 6. Version it

Versions follow semver (`MAJOR.MINOR.PATCH`) in `manifest.json`.

- **Patch:** fixes with no change to data or settings.
- **Minor:** new features, new optional settings, new migrations that only add things.
- **Major:** anything that breaks existing data, settings keys, permission keys or routes. Avoid this. Write a migration that carries data forward instead.

Migrations are immutable once released: fix forward with a new one. Instances run new migrations on startup and record the installed version. Never rename or remove a settings key or permission key in a minor release.

## 7. Package it for the catalog

Each catalog module lives in its own git repository, at the repository root or in a subfolder:

```
your-repo/
  manifest.json
  package.json
  api/ web/ help/
  README.md        what it does, requirements, settings, support contact
  CHANGELOG.md     one entry per version
  LICENSE
```

1. Copy `modules/<key>/` from your checkout into the repository. Don't include `node_modules`, `.env` files or credentials.
2. Run `npm run module:check -- <key>` one last time in the checkout.
3. Commit, then tag the release with the manifest's version: `git tag v1.2.0 && git push --tags`.
4. Note the full 40-character commit the tag points at: `git rev-parse v1.2.0^{commit}`.

Tags must never be moved. `module:add` refuses a tag that no longer points at the pinned commit. To fix a release, publish a new version.

## 8. Submit it

Open a change against the catalog repository (whoever runs your catalog decides how) that adds or updates one entry in `catalog.json`:

```json
{
  "key": "fleet-log",
  "name": "Fleet log",
  "version": "1.2.0",
  "description": "Vehicles and their trips",
  "category": "industry",
  "repo": "https://code.example.com/acme/fleet-log.git",
  "tag": "v1.2.0",
  "sha": "<40-character commit the tag points at>",
  "path": ""
}
```

- **Entry fields.**
  - `repo` must be https.
  - `path` is the folder inside the repository; leave it empty for the repository root.
  - `key`, `name`, `version` and `category` must match `manifest.json`.
- **What to include in the submission.** What the module does and who it is for, which other services it calls, what personal data it stores, a test run of `module:check` and the tests, and screenshots of its pages.
- **Updates.** An update is the same change with a new `version`, `tag` and `sha`. Instances whose installed version is lower then see it under Settings → Modules → Updates.

### What reviewers check

Reviewers add the module to a clean checkout with `npm run module:add -- <key> --catalog=<file>`, then go through this list. Use it on your own module before submitting.

- [ ] `module:add` succeeds: the tag matches the pin and every rule passes
- [ ] No brand names, no hardcoded colors, entity names through vocabulary
- [ ] Every route has a permission, and its scope and field visibility are respected
- [ ] Every change writes an audit row
- [ ] Personal data: has a `PrivacyHandler`, skips restricted people, never sends names out unless the admin chose to
- [ ] Outbound calls: `assertSafeUrl`, no redirects, timeout, messages written for people
- [ ] Secrets are `secret` settings, never logged or returned
- [ ] Migrations touch only `m_<key>_*` and run on a fresh database and on the previous version
- [ ] Help article explains setup, includes the settings table, and every setting has help
- [ ] Tests cover permissions, scope, privacy and turning the module off; all pass
- [ ] Turning the module off leaves the app working and keeps its data

Reviewers may reject a module that duplicates core features, needs core changes, or belongs in a blueprint.

## 9. After it is accepted

- **Instances.** A developer at an instance runs `npm run module:add -- <key>` (or `--update`), reviews the diff, commits it and deploys a normal release. Instances never download or run catalog code on their own.
- **Admins.** They turn the module on and fill in its settings at Settings → Modules.
- **Security fixes.** Publish a patch version and update the catalog entry. Instances on older versions see the update.
- **Withdrawing.** Removing a module from the catalog stops new installs. Instances that already have it keep it until they remove it themselves.

## Later: signed bundles

Uploading a module to a running instance (8d) is designed but not built. When it is, a catalog release will also carry a bundle signed with an ed25519 publisher key, and an instance will accept only keys that its operator lists in `MODULE_PUBLISHER_KEYS`. Everything in this guide still applies.
