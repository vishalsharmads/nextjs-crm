# Phase 11: production hardening

Source: [production-readiness review](../review/production-readiness-2026-11.md). No new features; every item ships with a regression test.

| Milestone | Scope |
|---|---|
| 11a | Privacy and access: automations run as the rule creator (items 1, 6), conversion and merge keep opt-out, restriction, consents and module records (2, 3), team membership grant check (7), import dry run sends nothing, import files purged and erased (8, 9), timeline access log and activities permission, relation scope checks, user directory trimmed |
| 11b | Security and operations: nginx header snippet and `limit_req`, webhook IP parsing and pinning (4, 5), crash handlers and error hook, graceful shutdown, job and webhook recovery with atomic claims, production config checks, request-id validation, audit inside transactions, bulk events (10–15) |
| 11c | Search: FULLTEXT and prefix as separate ranked queries, searchable custom fields, activities and notes in ⌘K, debounce, vocabulary labels, results page; load test at 100k rows |
| 11d | Web reliability: unsaved-changes guard, error states on every list, confirm dialog instead of `window.confirm`, split the largest settings files, background polling off |
| 11e | Delivery: release folders with rollback, backup timer and freshness check, `npm audit` and Dependabot in CI, replace or isolate exceljs, `DB_POOL_MAX`, readiness covers Redis and storage, SMTP test email, the flaky API test, "one API process" documented or Redis-backed limits and cache invalidation |

**Status (2026-11-14):** 11a is built. Decision kept: a record's activities stay visible to anyone who can see the record (D9), so the timeline gained an access-log entry but no extra permission check. The flaky API test (shared captured mail) was fixed early. Import rows that find an existing organization outside the importer's scope now fail with "Not found" instead of linking it.

**Status (2026-11-15):** 11b is built. Webhook addresses are parsed with `net.BlockList` (IPv4-mapped IPv6 included) and the checked address is pinned at connect time (`lib/safe-net.ts`). nginx includes one header snippet per location and rate-limits `/api/auth/`. Crash handlers exit after a fatal log and an optional `ERROR_WEBHOOK_URL` report; shutdown has a 15-second limit. Jobs and webhook attempts are claimed atomically, interrupted work is recovered, and job errors shown to people are plain. Production refuses missing `APP_URL`, `DATABASE_URL`, `SMTP_*`, `MAIL_FROM`. Request ids are validated. Deletes and revokes audit inside their transaction; bulk delete, restore and tags, and single restore, emit events. Decision: module enable/disable keeps its audit row after the change, because enabling runs DDL migrations, which cannot share a transaction. Release folders and rollback (item 15) moved to 11e with the other delivery work.

**Status (2026-11-15):** 11c is built. Each record type runs a FULLTEXT query and a starts-with query separately (each uses its own index), merged and ranked: exact title, then title prefix, then relevance. Filterable text, email, phone and link custom fields are searched through their generated columns when visible to the person and not special-category; the hit names the field. Notes, emails, calls, meetings and tasks come back as `activity` hits (tasks open the task, others their record). ⌘K waits 200 ms after typing, keeps the server's order, names types with the workspace vocabulary and links to a new `/search` page. Global search writes one access-log entry. Load check (`scripts/search-load.ts`, 100,000 contacts on the dev machine): 14–133 ms per search across all types.

Phases 12–18 (feature gaps) are listed in the [roadmap](../roadmap.md).
