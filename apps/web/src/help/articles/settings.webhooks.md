---
id: settings.webhooks
title: Webhooks
area: Integrations
route: /settings/webhooks
related: settings.api-keys, settings.automations
permission: core.webhooks.manage
---

Send events, such as {{dealLower}} won, to another system as they happen.

Choose the events and the address to send them to. Each delivery is signed so the receiver can check it came from you; failures are retried. Turn on minimal webhooks in Compliance to send only ids.

The address must use https and point to a public server. Addresses inside your own network (such as `localhost`, `10.x`, `192.168.x` or cloud metadata addresses) are refused, both when you save the webhook and again each time it sends, so a name that later points somewhere private is still blocked.
