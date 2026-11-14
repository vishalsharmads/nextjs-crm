# Phase 11: production hardening

Source: [production-readiness review](../review/production-readiness-2026-11.md). No new features; every item ships with a regression test.

| Milestone | Scope |
|---|---|
| 11a | Privacy and access: automations run as the rule creator (items 1, 6), conversion and merge keep opt-out, restriction, consents and module records (2, 3), team membership grant check (7), import dry run sends nothing, import files purged and erased (8, 9), timeline access log and activities permission, relation scope checks, user directory trimmed |
| 11b | Security and operations: nginx header snippet and `limit_req`, webhook IP parsing and pinning (4, 5), crash handlers and error hook, graceful shutdown, job and webhook recovery with atomic claims, production config checks, request-id validation, audit inside transactions, bulk events (10–15) |
| 11c | Search: FULLTEXT and prefix as separate ranked queries, searchable custom fields, activities and notes in ⌘K, debounce, vocabulary labels, results page; load test at 100k rows |
| 11d | Web reliability: unsaved-changes guard, error states on every list, confirm dialog instead of `window.confirm`, split the largest settings files, background polling off |
| 11e | Delivery: release folders with rollback, backup timer and freshness check, `npm audit` and Dependabot in CI, replace or isolate exceljs, `DB_POOL_MAX`, readiness covers Redis and storage, SMTP test email, the flaky API test, "one API process" documented or Redis-backed limits and cache invalidation |

Phases 12–18 (feature gaps) are listed in the [roadmap](../roadmap.md).
