---
name: feature-slice
description: Checklist for adding a backend+frontend feature slice (a core entity, admin resource, or module resource) in this CRM. Use when creating a new resource, endpoint group, or entity screen.
---

# Adding a feature slice

Follow `CLAUDE.md`. Work test-first, and commit each step atomically (`feat(<scope>): …`, `test(<scope>): …`).

## 1. Shared contract (`packages/shared`)
- [ ] Zod schemas for create, patch, list query, and DTO. Export the inferred types.
- [ ] Permission keys `<module>.<resource>.<action>` added to the catalog.
- [ ] New error codes (if any) added to `errors.ts`.
- [ ] Filter/sort whitelist for the resource.

## 2. Database (`apps/api/src/db/migrations` or `modules/<key>/api/migrations`)
- [ ] New migration only (never edit a committed one). `id` BIGINT + `uuid` (UUIDv7), timestamps, `created_by`/`updated_by`, `deleted_at`, `custom` JSON if custom fields apply.
- [ ] Real FKs, plus indexes for owner, scope, and list sort columns.
- [ ] Module tables are prefixed `m_<key>_`.

## 3. API (`routes → controller → service → repository`)
- [ ] Routes via `defineRoute` with a permission on every route.
- [ ] Repository applies `ScopeContext` (own/team/all) on every read and write path.
- [ ] Service: validates custom fields via `SchemaBuilder`, enforces field visibility, writes audit in the same transaction, serializes with hidden fields stripped.
- [ ] Timeline, search, export, and bulk paths covered if the entity has them.

## 4. Tests (`apps/api/test`)
- [ ] Happy path CRUD against real MySQL.
- [ ] `own`-scope user cannot read (404) or edit another user's record.
- [ ] Hidden or read-only custom field enforcement.
- [ ] Validation failures return `VALIDATION_FAILED` with `details.path`.

## 5. Web (`apps/web/src/features/<feature>`)
- [ ] Query keys in `lib/query-keys.ts`, hooks with TanStack Query, optimistic update for simple mutations.
- [ ] List: DataTable with saved-view tabs, filter chips, column picker, bulk bar, virtualized rows.
- [ ] Record: peek sheet + full page with tabs (overview, timeline, activities, files, related).
- [ ] Form: `LayoutRenderer` + field definitions, no hardcoded custom fields.
- [ ] Loading (skeleton), empty (next action), and error states.
- [ ] All copy via i18n with vocabulary interpolation. Theme tokens only. Logical CSS properties.
- [ ] Command palette entries and keyboard shortcuts registered.
- [ ] React Testing Library tests for form rendering and custom fields.

## 6. Finish
- [ ] `npm run lint && npm run typecheck && npm test` all pass.
- [ ] Docs updated (`docs/architecture.md`, `docs/env-reference.md` if env changed).
- [ ] Run the `white-label-auditor` and `access-control-reviewer` agents on the diff and fix their findings.
