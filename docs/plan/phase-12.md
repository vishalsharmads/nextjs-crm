# Phase 12: collaboration and data quality

Source: the feature-gap table in the [production-readiness review](../review/production-readiness-2026-11.md) and row 12 of the [roadmap](../roadmap.md). Status: **approved 2026-11-15** (D1–D7 as written); built milestone by milestone.

## Goal

People who share a customer can talk about it in the record itself, duplicates are caught and cleaned up before they spread, a record can be opened to one more person without widening their role, sensitive standard fields can be hidden like custom ones, and the app installs on a phone with push notifications.

## What exists today

| Area | Today | Gap |
|---|---|---|
| Comments | Tasks only (`activity_comments`, @mentions checked against the mentioned person's scope in `viewersAmong`) | Contacts, organizations, leads, deals, module record types and admin-defined objects have no discussion |
| Duplicates | `findContactDuplicates`, `findOrganizationDuplicates`, `mergeRecords` (contacts, organizations); import can skip or update matches | No admin rules, no warning while typing, no queue of suspected pairs, no lead or deal matching |
| Record access | Role scope `own`, `team` or `all` per resource (`applyScope`, `scopeAllows`) | No way to give one person access to one record |
| Field visibility | Custom fields: `write`, `read` or `hidden` per role | Standard fields (deal amount, phone, email, date of birth) are visible to everyone who sees the record |
| Notifications | In-app list and one email on/off switch | No choice per kind of event, no push |
| Installable app | Web manifest from branding (`/api/v1/public/manifest.webmanifest`) | No service worker, no offline shell, no push |

## Milestones

| Milestone | Scope |
|---|---|
| 12a | Comments and @mentions on every record type |
| 12b | Duplicate rules, warning while typing, and a merge queue |
| 12c | Record sharing |
| 12d | Field visibility for standard fields |
| 12e | Notification preferences per event, installable app and web push |

Each milestone gets its own branch, tests, help articles, tour updates where flows change, a full check run and a `--no-ff` merge, as in phase 11.

### 12a: Comments and mentions on every record

- New table `record_comments` (`uuid`, `entity`, `record_id`, `body` (sanitized rich text, `sanitizeBody`), `mentions` JSON of user ids, `author_id`, `edited_at`, `deleted_at`). It is generic over `entity` like `taggables`, so module record types and admin-defined objects get comments with no per-type code. Task comments stay in `activity_comments` (no data move).
- Routes on the records engine: `GET/POST /<path>/:uuid/comments`, `PATCH/DELETE /<path>/:uuid/comments/:commentUuid`. Reading needs `.view` on the record (scope applies, out of scope is 404); writing needs `.view` too: commenting is part of seeing a record, like the timeline (decision D1 below). Authors edit and delete their own; admins delete any.
- @mentions: generalise `viewersAmong` to any record type (`canUserSee(userId, def, uuid)`), so a mention never notifies or reveals a record to someone outside their scope. The picker lists only people who can see the record.
- Comments appear on the record's timeline and in a Comments tab. Events `comment.created` (webhooks, automations: "when someone comments"). Audit and access log as for activities.
- Privacy: comments about a contact or lead are included in the personal data export and removed by erasure; restricted records send no comment notifications by email.
- Assistant/MCP: tools `list_comments` and `add_comment` (write) through the same service.
- Search: comment text joins the activity full-text search (11c) so ⌘K finds it.

### 12b: Duplicate rules and merge queue

- Settings → Data quality → **Duplicate rules**, per record type (contacts, organizations, leads): which fields match (email, phone, name + organization, domain, a filterable custom field), exact or normalised (case, spaces, phone digits, email dots for known patterns are not touched: only case and spaces). Up to 5 rules per type. Blueprints can seed rules (`source_blueprint`).
- While someone types in a create form, the API checks the rules (`POST /<path>/duplicates/check`, scope-aware: only records the person can see are shown; a hidden match is reported as "a possible duplicate you cannot see" without details). The form shows "Possible duplicate: open it" without blocking. An option per rule: **block** creation instead of warning.
- A nightly job (and a manual "Scan now") finds suspected pairs into `duplicate_pairs` (`entity`, `a_id`, `b_id`, `rule_id`, `score`, `status: open | merged | dismissed`). **Merge queue** page lists open pairs for people with `.merge` permission, side by side, with Merge (existing `mergeRecords`, which already carries flags, consents and module records) and Not a duplicate (remembered so the pair never comes back).
- Leads join contacts in matching (a new lead whose email belongs to a contact is flagged), so conversion does not create a second contact.
- Import uses the same rules for "match existing records".

### 12c: Record sharing

- `record_shares` (`entity`, `record_id`, `user_id` or `team_id`, `level: view | edit`, `shared_by`, `created_at`). A share gives access to that one record on top of role scope, never a permission the person's role lacks: someone without `core.deals.view` sees nothing even if shared.
- `applyScope` and `scopeAllows` gain an `OR record is shared with me or my team` branch through an indexed `EXISTS`, so lists, search, reports, board, export and the assistant all respect shares with one change. A view share never allows edits (`edit` needs both the role's `.update` and an edit share or normal scope).
- Share dialog on the record (people and teams, view or edit), visible to the owner, admins and people with a new `.share` permission. Sharing and unsharing are audited and notify the person.
- Child data follows the record: activities, files and comments of a shared record are visible like for owned records (consistent with D9 from phase 11).
- Removing someone's role or deactivating them makes their shares inert; deleting the record removes its shares; merge moves shares to the kept record.

### 12d: Field visibility for standard fields

- Settings → Fields: standard fields of each record type get the same per-role `write`, `read` or `hidden` control as custom fields, for a curated list per type (deal: amount, probability, close date; contact: email, phone, date of birth, address; organization: annual revenue; lead: email, phone). Titles, owner and stage cannot be hidden, because lists, boards and links depend on them.
- Enforcement in the same places as custom fields: every DTO (`toDtos`), list columns and filters, search hits (the 11c subtitle), exports, timeline diffs, reports (`GROUP_TABLES` and measures), automations' field updates, webhooks (the owner's view, as fixed in 11a), assistant tools. Writing a `read` or `hidden` standard field returns `403 FIELD_FORBIDDEN`.
- A test walks every response shape with a role that hides deal amount and fails if the value appears anywhere.

### 12e: Notifications, installable app and push

- **Preferences per event:** Profile → Notifications lists each kind (assigned to me, mentioned, comment on my record, task due, shared with me, automation notices) with in-app, email and push switches. Stored in `users.preferences.notifications`; `notify()` reads it. The compliance minimal-email rule still applies, and push uses it too: under the health-data profile, push text is "You have a new notification".
- **Installable app:** a service worker built with the web app (no new dependency: plain `sw.js` emitted by Vite) caches the app shell and assets only, never API responses, so no personal data is stored on the device. Offline shows a "You are offline" page. Works under `APP_BASE_PATH`.
- **Web push:** standard Web Push with VAPID keys generated at install (`install:instance`) and stored encrypted in settings. Table `push_subscriptions` (user, endpoint, keys, user agent, last used); unsubscribe on 404/410. Sending happens in a background job, through `safePost` from 11b. One new dependency, `web-push` (well-known, small), recorded in the stack table. Subscriptions are deleted on sign-out everywhere and by erasure of the user.

## Decisions to confirm

| # | Decision | Why |
|---|---|---|
| D1 | Anyone who can see a record can comment on it; no separate comment permission | Matches the timeline rule kept in phase 11 (D9); a separate permission would mostly confuse |
| D2 | Duplicate rules warn by default; blocking is opt-in per rule | Blocking on fuzzy matches stops real work; exact email matches are the usual case for blocking |
| D3 | A hidden duplicate is reported only as "a possible duplicate you cannot see" | Reveals that something exists (needed to avoid the duplicate) without revealing any data |
| D4 | Sharing adds access to one record; it never grants a permission the role lacks | Keeps roles the single source of what someone may do |
| D5 | Only a curated list of standard fields can be hidden | Titles, owners and stages drive lists, boards and links; hiding them would break the screens |
| D6 | Push and the offline page cache no API data | A lost phone must not carry customer data |
| D7 | `web-push` is the one new dependency | Payload encryption and VAPID signing by hand would be fragile and hard to review |

## Out of scope (stays on the roadmap)

Real-time co-editing or live presence; comment reactions and threads beyond one level of replies; sharing with people outside the workspace (the portal module covers customers); native mobile apps; SMS notifications.

## Verification

- API tests per milestone: scope (an `own` user cannot read comments, shares or duplicate details of others' records), mention notifications only for people who can see the record, share levels, hidden standard fields absent from every response shape, push subscription cleanup.
- Web tests: comment box and mentions, duplicate warning in the create form, share dialog, field visibility editor for standard fields, notification preferences.
- E2E: comment with a mention on a deal and see the notification as the mentioned user; create a duplicate contact and merge it from the queue; share a deal with an `own`-scope user who then opens it.
- `npm run check:brand`, lint, typecheck, build, the help and tour tests, and a lighthouse installability check for the app.

Estimate: about 4–5 weeks for the whole phase, in the order 12a → 12e.

## Progress

**12a built (2026-11-15).** `record_comments` (entity + record id, FULLTEXT on the body) serves every record type through `addCommentRoutes` on the records engine and the same four routes under `/o/:object`; tasks keep `activity_comments`. Mentions and owner notices go only to people who can open the record (`viewersOf`). Comments appear on the timeline (`kind: 'comment'`), emit `comment.created` (automations: "Someone comments on a record"), are found by global search as hits of their record, are moved by merge, exported with a person's data and removed by erasure. Tools `list_comments` and `add_comment`. Web: a shared `Comments` component (`components/comments`) used by tasks and by a Comments tab on every record page. Fixed on the way: webhook claims allowed for DATETIME rounding (a first attempt could be skipped until the retry sweep).

**12b built (2026-11-15).** `duplicate_rules` (per record type, fields that must all match, warn or block, starter rules seeded by migration 0029) drive `core/duplicates/duplicates.ts`: create forms call `/<type>/check-duplicates` and get `{ data, hidden, blocked }` (matches the person cannot open are only counted, D3); `createRecord` refuses a create a blocking rule matches (409, record not named), which covers forms, imports and the API. Email and phone rules compare contacts and unconverted leads both ways. A nightly scan (and **Scan now**) fills `duplicate_pairs` for contacts and organizations; **Possible duplicates** (`/duplicates`, ⌘K) lists pairs where the person may merge and sees both records, with Keep this (existing merge) and Not a duplicate (never comes back). Merges close their pairs. Decisions: leads are not mergeable, so lead matches are warnings only (no lead queue); a contact rule's "organization" field means "linked to the same organization"; import's own "match existing" option keeps its email/name matching, while blocking rules still refuse import rows.
