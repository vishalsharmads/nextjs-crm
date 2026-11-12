---
id: settings.modules
title: Modules
area: Settings
route: /settings/modules, /settings/modules/:key
related: getting-started
permission: core.modules.manage
---

Modules are optional features and integrations, such as bookings, tickets, quotes, invoices or a chat notification connection.

## Find a module

Search by name or pick a category. **Turned on** lists the modules in use, **Available** the ones you can turn on, and **Updates** newer versions from the module catalog when your workspace has one.

Modules under **Available from the catalog** are not part of this release. A developer adds one with the command shown on its card; it arrives with your next update.

## Turn a module on or off

Use the switch on the card or the module page. Turning a module off hides it; its data stays until you turn it back on. Some modules need others first (invoices need products), and a module that others use cannot be turned off until they are.

## A module's page

Open a module by its name.

- **Overview**: version, what it needs, what uses it and the pages it adds.
- **Settings**: addresses, tokens and options the module uses. Saved tokens and passwords are never shown again: type a new one to replace it, or choose **Remove**. **Test connection** checks the values on screen before you save them.
- **Permissions**: what the module lets people do. Give these to people in Roles.
- **Activity**: who turned the module on or off, changed its settings or tested its connection.
