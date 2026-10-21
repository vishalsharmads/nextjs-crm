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
- Dashboard widgets: `registerModuleWidget('<key>.<name>', async (params, user) => data)`.

## Web

```tsx
const notesModule: WebModule = { key: 'notes-demo', routes: [{ path: '', element: <NotesPage /> }] };
export default notesModule;
```

The page renders at `/m/<key>/…`, inside the app shell, as its own lazy-loaded chunk. Use the shared UI components and theme tokens; the same white-label and RTL lint rules apply.

## Registering

1. Add the module to `apps/api/src/modules/installed.ts` (a test fails if a manifest folder is not listed).
2. `npm install` to link the workspace package.
3. Enable it in **Settings → Modules**, or list it in a blueprint's `modules`.
