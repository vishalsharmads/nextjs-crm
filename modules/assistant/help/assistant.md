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

## For admins

On the assistant's **Settings** tab: the API format, address, model and key of your AI provider, the name people see, monthly and daily limits, record types it must never use, and usage per person.

## Permissions

<!-- generated:permissions:assistant. -->
