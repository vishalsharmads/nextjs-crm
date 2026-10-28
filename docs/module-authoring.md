# Writing a module

Modules add industry features that need their own tables and screens (bookings, tickets, invoices). They are compiled into the build and turned on or off per instance at runtime. Turning a module off hides it; its data stays.

There are two reference modules. Use `modules/records-demo` for a record type that behaves like contacts or deals, and `modules/notes-demo` for a module that writes its own routes and screens.

## Record types

A module that keeps a list of records (properties, vehicles, cases) should not write its own CRUD. Generate it instead:

```
npm run cli -w @app/api -- module:new --key=fleet --entity=vehicle --plural=Vehicles [--singular=Vehicle] [--personal]
npm install
```

This writes `modules/fleet/` and adds it to `installed.ts`. The record type is declared with `defineRecordType` in `api/index.ts`. Out of the box it gets:

- REST routes under `/api/v1/m/<key>/<route>`: list, get, create, update, delete, restore, timeline, `/bulk` and `/export`
- pages under `/m/<key>/<route>`: list, peek, full page and form, built from the record type
- custom fields, layouts and saved views
- global search and ⌘K, CSV import and export, and bulk actions (assign, update field, delete)
- trash, audit and access logging
- `<entity>.created/updated/deleted` events for automations and webhooks
- own/team/all record scope in the role editor

Columns are `text`, `textarea`, `email`, `phone`, `url`, `number`, `money` (stored as integer cents), `date`, `datetime`, `boolean`, `select` and `relation` (to a contact, organization, deal or lead; stored as `<key>_id`). Keys are camelCase in the API and snake_case in SQL.

Rules:

- The table must have the standard columns the generated migration creates. Columns that are not `required` must be nullable.
- The FULLTEXT index lists exactly the `searchable` columns, in order.
- To add a column, add it to the spec and write a new migration. Committed migrations are immutable.
- Record keys (`--entity`) are global: they must not reuse a core entity or a vocabulary key.
- A record type with an `email` or `phone` column, or a relation to a contact or lead, holds personal data. Its module must return a `PrivacyHandler`, or the API refuses to start. Pass `--personal` to generate a stub, then fill it in so access exports and erasure reach these records. Events about a linked restricted person are skipped by automations and webhooks.
- Relation columns accept only records the user may view. A linked record outside the reader's scope shows as empty.
- Not yet available on record types: tags, activities, files, merge and Kanban boards. Add your own routes and pages for those.

## Layout

```
modules/<key>/
  manifest.json          contract (validated at boot)
  package.json           name @app/module-<key>
  api/index.ts           exports an ApiModule
  api/migrations/*.ts    Knex migrations for m_<key>_* tables
  web/index.tsx          default-exports a WebModule
```

## Manifest

```json
{
  "key": "notes-demo",
  "name": "Pinned notes",
  "version": "1.0.0",
  "depends_on": [],
  "permissions": [{ "key": "notes-demo.notes.view", "description": "View pinned notes" }],
  "menu_items": [
    {
      "key": "notes",
      "label": "Pinned notes",
      "path": "/m/notes-demo",
      "icon": "notebook",
      "permission": "notes-demo.notes.view",
      "order": 50
    }
  ],
  "dashboard_widgets": [{ "type": "notes-demo.latest", "title": "Latest pinned notes" }]
}
```

- Permission keys must start with `<key>.`. Roles and blueprints can grant them once the module is installed, even before it is enabled.
- `icon` is one of the curated names in `apps/web/src/app/shell/nav.ts`.
- `status: "stub"` declares a module that is not built yet, so blueprints can reference its permissions.

## API

Import only from `@app/api/module-api`, never from API internals:

```ts
import { db, defineRoutes, audit, type ApiModule } from '@app/api/module-api';

const routes = defineRoutes('/m/notes-demo/notes', ['notes-demo'], 'notes-demo').add({
  method: 'get',
  path: '/',
  permission: 'notes-demo.notes.view',
  handler: () => db('m_notes_demo_notes').select(),
});

export const notesDemo: ApiModule = { routes: () => [routes], migrations: { '0001_notes': m0001 } };
```

- Routes live under `/api/v1/m/<key>/…`. The third `defineRoutes` argument (the module key) makes the access gate return `MODULE_DISABLED` while the module is off.
- Every route declares a permission, and mutations write an audit entry in the same transaction, exactly as in core.
- Tables are prefixed `m_<key_with_underscores>_`. Migrations run when the module is first enabled and are tracked in their own table. Like core migrations, they are never edited once committed.
- Dashboard widgets: `registerModuleWidget('<key>.<name>', async (params, user) => data)`. Apply record scope inside the provider; it runs as the viewing user.
- Recurring work: return `start: () => every(ms, '<key>.<task>', fn)` from the module. `fn` must return early while `isModuleEnabled('<key>')` is false.
- Module-to-module calls: import the other module's exported functions directly (for example invoices imports `quoteForConversion` from quotes). Check `isModuleEnabled()` before calling into a module you do not declare in `depends_on`.
- **Personal data:** a module that stores anything about a data subject (a record of the `contact` or `lead` entity) must return `privacy: PrivacyHandler` from its `ApiModule` (see `modules/tickets/api/privacy.ts`). `export(subject, conn)` returns everything the module holds about the person, for access requests. `erase(subject, trx, mode)` runs inside the erasure transaction: in `anonymize` mode remove what the person wrote or what identifies them, and in `delete` mode remove their rows. Report data you must keep in `retained` with the reason, or throw `AppError('CONFLICT', …)` when deleting would destroy something the law requires you to keep. Commercial documents can use `documentPrivacyHandler(key, table)`.
- Record reads of personal data with `logAccess(ctx, { action: 'view', entity, entityId })` so access logging covers the module.
- Public endpoints (for customers, not users) go under `/public/...` with `permission: 'public'` and must authenticate callers themselves. Use `rateLimiter()` and `cookieOptions()` from `module-api`.

## Web

```tsx
const notesModule: WebModule = { key: 'notes-demo', routes: [{ path: '', element: <NotesPage /> }] };
export default notesModule;
```

The page renders at `/m/<key>/…`, inside the app shell, as its own lazy-loaded chunk. Use the shared UI components and theme tokens; the same white-label and RTL lint rules apply.

- Link with absolute paths (`/m/<key>/<uuid>`). Module routes are mounted under a wildcard, so relative links resolve unpredictably.
- `widgets: { '<key>.<name>': ({ data }) => <Widget data={data} /> }` renders the module's dashboard widgets.
- `publicRoutes` render at `/p/<key>/…` with no app shell and no staff session, for customer-facing pages such as the client portal. Call your API with `noRetry: true`, so a 401 never triggers a staff session refresh.
- After adding a new module folder, restart `npm run dev`: Vite only picks up new `modules/*/web` entries at startup.
- Tailwind scans `modules/` through `@source` in `apps/web/src/styles.css`, so any utility class works in module code. Theme tokens only, as in core: elevation is `shadow-raised` or `shadow-overlay`, page titles use `text-title` (`PageHeader` does this for you), and a list table gets linked rows from `DataTable`'s `rowHref`.
- Rich text: use `RichTextEditor` from `@/components/editor/rich-text-editor` (`mode="document"` adds tables, dividers and page breaks) and render stored HTML inside `.rte-prose`. Sanitize it on the server with `sanitizeDocumentHtml`. For templates, list your placeholders from an API route built on `mergeFieldGroups()` and pass them as `mergeFields`.
- Uploads: put `uploadSingle()` in `before`, after a middleware that checks access, so files are never parsed for callers who may not upload. Store them with `storeFile()` against a core record.

## Registering

1. Add the module to `apps/api/src/modules/installed.ts` (a test fails if a manifest folder is not listed).
2. `npm install` to link the workspace package.
3. Enable it in **Settings → Modules**, or list it in a blueprint's `modules`.
