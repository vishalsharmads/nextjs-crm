---
id: module.chat-notify
title: Chat notifications
area: Modules
route: /settings/modules/chat-notify
permission: core.modules.manage
module: chat-notify
related: settings.modules
---

Posts a short message to a team chat channel when something happens in {{appName}}: a deal is won, a new {{dealLower}} or {{leadLower}} arrives, or a ticket comes in.

## Set it up

1. In your chat service, add an **incoming webhook** to the channel and copy its address.
2. Here, turn the module on, open **Settings**, paste the address and choose what to post.
3. Choose **Test connection**. A test message should appear in the channel.

## What is sent

Each message says what happened and links back to the record. Names of people are never sent. Record titles are sent only when **Include record titles** is on.

Nothing is sent about a person whose processing is restricted. Messages go out in the background, so a slow chat service never slows down saving a record.

## Settings

<!-- generated:module-settings:chat-notify -->
