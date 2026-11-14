# Roadmap

Phases come from the product brief. Ideas that come up during a phase but sit outside its scope go under **Future** rather than into the code.

| Phase | Scope                                                                                                                                                                                                                                                                                                                                                                                 | Status                         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 0     | Planning: architecture, schema, API, blueprint and module contracts                                                                                                                                                                                                                                                                                                                   | Done ([plan](plan/phase-0.md)) |
| 1     | Foundation: auth, RBAC, branding, vocabulary, custom fields, contacts, organizations, deals, activities, views, import/export, dashboard, audit, notifications, blueprints, module loader                                                                                                                                                                                             | Done                           |
| 2     | Configuration and communication: layout builder UI, workflow automation, templates manager, email integration, web forms, webhooks, API keys, BullMQ jobs                                                                                                                                                                                                                             | Done                           |
| 3     | Commercial: products, quotes, invoices, payments, contracts and renewals, client portal                                                                                                                                                                                                                                                                                               | Done                           |
| 4     | Operational and industry modules: bookings, tickets, documents, inventory/assets, vertical modules                                                                                                                                                                                                                                                                                    | Done                           |
| 5     | Compliance readiness: profiles with enforced floors, access logging, data subject rights and consent, retention, encryption of sensitive data ([overview](compliance/overview.md))                                                                                                                                                                                                    | Done                           |
| 6     | Gap closing ([plan](plan/phase-6.md)): quick wins, UI polish, rich text, records engine for modules, admin-defined objects, tool layer and MCP, assistant module (streamed, in a side panel), sales reports, delayed and scheduled automations, report builder with pivots and currency conversion, dashboard editing, object-to-object links, deal line items, OAuth for MCP clients | Done                           |
| 7     | In-app help: page help sheet (ⓘ and `?`), knowledge base at `/help`, articles for every page and module with generated setting tables, blueprint help notes, guided tours                                                                                                                                                                                                             | Done                           |
| 8     | Integrations and module marketplace ([plan](plan/phase-8.md)): module settings with encrypted secrets, marketplace UI, example integration, `module:new --integration`, module catalog in a git repository with `module:add` and `module:check`, developer MCP server for AI coding agents. Run-time upload and in-product generation are design only                                 | Done                           |
| 9     | Tasks upgrade and quick wins ([plan](plan/phase-9.md)): task detail, comments, checklists, recurrence, reminders, My work, calendar, task statuses; board Move to, quote and invoice tabs                                                                                                                                                                                             |
| 10    | AI setup mode ([plan](plan/phase-10.md)): interview, editable brief, website branding, proposal and build, spreadsheet mapping, check-before-import with plain explanations                                                                                                                                                                                                           |
| 11    | Done                                                                                                                                                                                                                                                                                                                                                                                  |
| 12    | Collaboration and data quality: comments and @mentions on every record, duplicate rules and merge queue, record sharing, core-column field visibility, installable app with push                                                                                                                                                                                                      |
| 13    | Inbox and calendar: mailbox sign-in and two-way sync, threads, tracking, calendar sync, activity participants, scheduling links                                                                                                                                                                                                                                                       |
| 14    | Sales engagement: sequences, lead scoring, round robin, branching automations and approvals, segments and campaigns (module)                                                                                                                                                                                                                                                          |
| 15    | Service desk: email-to-ticket, SLAs with business hours, public knowledge base, CSAT                                                                                                                                                                                                                                                                                                  |
| 16    | Commerce completion: server PDFs, credit notes, recurring invoices, online payments and accounting sync (integration modules), drawn signatures                                                                                                                                                                                                                                       |
| 17    | Identity and ecosystem: SSO (OIDC, SAML), SCIM, passkeys, staging → live config promotion, territories, Zapier/Make/n8n, migrators from other CRMs, enrichment, telephony and messaging modules                                                                                                                                                                                       |
| 18    | Reporting and AI depth: funnels, activity goals, scheduled report emails, deal-risk signals, scheduled assistant tasks, full localisation                                                                                                                                                                                                                                             |

## Future

- AI setup: offer **Set up with AI** on the home page of a brand-new workspace, a guided tour of the setup page, and several sheets in one workbook.

- Per-event notification choices (assignments, mentions, reminders separately) beyond the email and digest switches.
- Email thread view and reply in thread; connect a mailbox by signing in; record-level sharing; field visibility for core columns; rule-based lead scoring; branching in automations; email sequences (from the phase 9 review).
- Task statuses in blueprints (seed a task pipeline per industry); exports leave them out for now.
- Comments on deals, contacts and other records (tasks have them since phase 9).
- Task dependencies (blocked by) and time tracking on tasks.
- Ready-made connectors for Zapier, Make and n8n (triggers and actions built on the existing webhooks and API keys).
- Accounting and invoicing sync (UK and Australia first): Xero, QuickBooks Online, Sage, FreeAgent and MYOB, with two-way sync of customers, invoices and payments.

- WebAuthn / passkeys as a second factor.
- Breached-password check (k-anonymity range API) when setting a password.
- Keep encryption keys in an external key manager (KMS or HSM) instead of the environment.

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
- Mouse-friendly "Move to stage" menu on Kanban cards (keyboard drag works today; the deal page has a stage track).
- A display font in branding, used for page titles only (body and tables keep the readable families).
- Exit animation for the record peek (it closes instantly today, which suits something opened often).
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
- Drawn signatures on documents.
- Images in rich text (notes, emails, documents): upload, scope-checked file access, encryption at rest, and email embedding.
- Conditional sections (`{{#if}}`) editable in the visual editor, instead of only in the HTML view.
- Barcode scanning for asset tags and stock counts.
- Visitor pre-registration and printed badges for the front desk.
- Bookings and front desk show linked contact names to anyone with view access (shared calendar by design); add an option to hide names outside the viewer's contact scope.
