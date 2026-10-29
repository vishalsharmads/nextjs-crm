---
id: settings.webhooks
title: Webhooks
area: Integrations
route: /settings/webhooks
related: settings.api-keys, settings.automations
permission: core.webhooks.manage
---

Send events, such as a {{dealLower}} won, to another system as they happen.

Choose the events and the address to send them to. Each delivery is signed so the receiver can check it came from you; failures are retried. Turn on minimal webhooks in Compliance to send only ids.
