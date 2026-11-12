---
id: module.assistant
title: Assistant
area: Modules
route: /m/assistant, /m/assistant/*
permission: assistant.chat.use
module: assistant
related: settings.modules
---

An in-app assistant that answers questions about your records, summarises history, drafts notes and emails, and proposes changes you confirm. Uses the AI provider and model an admin configures; it is off until then.

Ask questions about your records in plain words, get summaries of a record's history, and draft notes and emails. Open it from the button in the top bar on any page (it knows the record you are looking at) or from its own page.

## How it works

- It looks things up with your permissions: it only sees what you can see, and hidden fields are never sent.
- **Changes need your confirmation.** When it wants to create or update something, it shows exactly what it will do, and nothing happens until you choose **Confirm**.
- Replies appear as they are written, with each step it takes.
- Conversations are private to you and deleted after the number of days an admin sets.

## Setting it up (admins)

1. Open the **Settings** tab and pick an AI provider. Providers marked **Free tier** or **Free models** let you start without paying; switch on **Free to start** to see only those.
2. Paste the provider's API key. **Get a key** opens the provider's page where you create one. The key is stored encrypted and only ever sent to that provider.
3. Pick a model. The provider's model list loads with your key, and the recommended one (★) is chosen for you.
4. Choose **Save and test**. The assistant sends one short message to check everything works.

Any other service with a compatible API (including your own) works through **Other compatible API**.

**Trying it out without AI:** on demo and development instances the list starts with **Simulated replies (testing)**. It needs no key and uses no tokens: answers are scripted, but it still looks up your records with your permissions and asks before changing anything (try "Show my contacts" or "Create a task to call back tomorrow"). It is never offered on a live instance. A key you saved for another provider is kept for when you switch back.

**Recommended for best results** suggests limits and the recommended model; **Apply** fills them in, and **Save** keeps them. Below that: the name people see (never the provider's), monthly and daily limits, how long conversations are kept, record types it must never use, and usage per person.

## Setting up the workspace with the assistant

Admins can let the assistant set up {{appName}} for the business: rename records, add fields, pipelines and roles, turn on modules or add an industry preset. It is **off by default**; turn on **Workspace setup and configuration** in the assistant settings, then describe your business in the chat (for example "Set up this CRM for a dental clinic").

- Only admins can use it, even when it is on.
- It previews the changes first, then shows them for you to **Confirm**. Nothing changes before that.
- It only adds what is missing. Fields, pipelines and roles that already exist are left as they are; names and settings it proposes replace yours.
- Every change is recorded in the audit log. Turn it off again once the workspace is set up.

With setup on, admins can also ask for everyday configuration changes, such as "Add a Renewal stage after Proposal", "Make the Industry field required", "Rename Deals to Opportunities", "Create an automation that emails the owner when a deal is won" or "Turn on the Quotes module". The assistant reads the current setup first, then proposes each change in plain words; **Exact change** shows precisely what it will send.

Its safety guards, which no instruction can change:

- It can change names, settings and branding, fields and layouts, pipelines and stages, roles and teams, automations, templates, forms, saved views and tags, reports and dashboards, objects and modules.
- It never deletes anything. To retire something it archives it or turns it off, where that area allows.
- It never touches security, compliance or connection settings, users and their sign-in, API keys and tokens, webhooks, email accounts, privacy requests, the audit log or demo data.
- It cannot grant every permission or change the Admin role.
- Each change runs with your permissions and the same checks as the settings screens. A change that cannot run is never put to you; the assistant tells you why instead.

## Permissions

<!-- generated:permissions:assistant. -->
