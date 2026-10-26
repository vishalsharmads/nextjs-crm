# Writing a module

Modules add industry features that need their own tables and screens (bookings, tickets, invoices). They are compiled into the build and turned on or off per instance at runtime. Turning a module off hides it; its data stays.

`modules/notes-demo` is the reference module. Copy it to start.

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
- Tailwind scans `modules/` through `@source` in `apps/web/src/styles.css`, so any utility class works in module code. Theme tokens only, as in core.
- Uploads: put `uploadSingle()` in `before`, after a middleware that checks access, so files are never parsed for callers who may not upload. Store them with `storeFile()` against a core record.

## Registering

1. Add the module to `apps/api/src/modules/installed.ts` (a test fails if a manifest folder is not listed).
2. `npm install` to link the workspace package.
3. Enable it in **Settings → Modules**, or list it in a blueprint's `modules`.
