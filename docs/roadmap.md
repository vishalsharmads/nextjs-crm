# Roadmap

Phases come from the product brief. Ideas that come up during a phase but sit outside its scope go under **Future** rather than into the code.

| Phase | Scope                                                                                                                                                                                     | Status                         |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 0     | Planning: architecture, schema, API, blueprint and module contracts                                                                                                                       | Done ([plan](plan/phase-0.md)) |
| 1     | Foundation: auth, RBAC, branding, vocabulary, custom fields, contacts, organizations, deals, activities, views, import/export, dashboard, audit, notifications, blueprints, module loader | Done                           |
| 2     | Configuration and communication: layout builder UI, workflow automation, templates manager, email integration, web forms, webhooks, API keys, BullMQ jobs                                 | Done                           |
| 3     | Commercial: products, quotes, invoices, payments, contracts and renewals, client portal                                                                                                   | Done                           |
| 4     | Operational and industry modules: bookings, tickets, documents, inventory/assets, vertical modules                                                                                        | Done                           |
| 5     | Compliance readiness: profiles with enforced floors, access logging, data subject rights and consent, retention, encryption of sensitive data ([overview](compliance/overview.md))        | In progress (5a done)          |

## Future

- Field-level visibility for **core** columns (e.g. hide deal value from a role). Phase 1 covers custom fields only.
- Activity participants (multiple contacts and users on a meeting).
- Calendar sync (Google, Microsoft 365).
- Custom font upload (woff2). Phase 1 offers a bundled font list only.
- Grammatical forms in vocabulary (articles, gender) for non-English locales.
- S3-compatible storage driver.
- Cross-origin deployment of web and API (Phase 1 requires same-origin).
- Record-level sharing beyond owner and team (explicit share with user or team).
- Deal velocity and forecast reports built on `deal_stage_history`.
- Extract remaining literal English UI copy into `apps/web/src/i18n/en.json` (entity names already go through vocabulary).
- Dashboard editing in the UI (add, remove, resize widgets). Phase 1 ships blueprint-defined dashboards and the API to save personal copies.
- Mouse-friendly "Move to stage" menu on Kanban cards (keyboard drag works today).
- Per-user notification preferences UI (the `preferences.emailNotifications` flag exists).
- OAuth mailbox connection (Google, Microsoft) instead of app passwords.
- Threaded email view and reply-from-CRM using `In-Reply-To`.
- Credit notes and refunds (Phase 3 voids unpaid invoices only).
- Online card payments from the client portal (payment provider integration).
- Recurring invoices generated from active contracts.
- Server-side PDF rendering (Phase 3 prints from the browser, which is also "Save as PDF").
- E-signature with document hashing for quote acceptance (Phase 3 records a typed name, time and IP in the audit log).
- Quote and invoice panels on deal and organization record pages.
- Recurring bookings and a member self-service booking page in the client portal.
- Configurable ticket response targets (per priority and business hours), and email-to-ticket.
- A rich-text template editor for documents, and drawn signatures.
- Barcode scanning for asset tags and stock counts.
- Visitor pre-registration and printed badges for the front desk.
- Bookings and front desk show linked contact names to anyone with view access (shared calendar by design); add an option to hide names outside the viewer's contact scope.
