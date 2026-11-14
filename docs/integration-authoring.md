# Writing an integration

New to modules? Start with [module-development.md](module-development.md), the start-to-finish guide from idea to catalog submission.

An integration is a module that connects the workspace to another service: it reads settings an admin fills in, reacts to record events, and calls out in the background. `modules/chat-notify` is the worked example; this guide walks through it. Read [module-authoring.md](module-authoring.md) first for the module contract.

## 1. Generate it

```
npm run cli -w @app/api -- module:new --integration --key=<key> --name="<Name admins see>"
npm install
```

This writes `modules/<key>/` with:

- **`manifest.json`**: `category: "integration"`, an address field, a secret token field and an on/off setting
- **`api/index.ts`**: an event handler, a background job and `testConnection`
- **`help/<key>.md`**: the help article, with the generated settings table

It also adds the module to `installed.ts`. Restart `npm run dev`, then turn the module on in Settings → Modules.

## 2. Declare the settings

Admins fill in the fields from `manifest.json` on the module's Settings tab. You never build a settings screen.

```json
"settings": [
  { "key": "webhook_url", "type": "secret", "label": "Incoming webhook address", "help": "…", "required": true },
  { "key": "events", "type": "select", "label": "What to post", "help": "…", "default": "won",
    "options": [{ "value": "won", "label": "Won deals" }, { "value": "all", "label": "…" }] },
  { "key": "include_titles", "type": "boolean", "label": "Include record titles", "help": "…", "default": false }
]
```

- **Secrets.** Use `secret` for anything that works like a password, including a webhook address with a token in it.
  - Secrets are encrypted at rest and re-encrypted by `crypto:rotate`.
  - They are never sent back to the browser, and they show in the audit log only as `[changed]`.
- **Help text.** Every field needs `help`. It shows under the field and in the help article's table (`<!-- generated:module-settings:<key> -->`).

## 3. React to events

```ts
onEvent(async (e) => {
  if (!isModuleEnabled(KEY)) return;
  const settings = await getModuleSettings(KEY);
  if (!settings.webhook_url) return;
  if (!PRESETS[String(settings.events)]?.includes(e.type)) return;
  if (await eventTouchesRestricted(e)) return;
  await enqueue(JOB, { text: messageFor(e, settings.include_titles === true) });
});
```

- **Turned off.** Event handlers are registered at boot whether or not the module is on, so check `isModuleEnabled` first.
- **Restricted people.** Skip events that touch a restricted person (`eventTouchesRestricted`). Every outbound channel must do this.
- **Background jobs.** Never call out from the handler. `enqueue` a job, so saving a record never waits on another service.
- **Keep payloads small and free of personal data.** Send ids, what happened and a link back. `chat-notify` never sends a person's name, and sends record titles only when the admin allows it.
- **Personal data in jobs.** Job payloads that do carry personal data are cleared by data subject erasure. A module that stores personal data in its own tables also needs a `PrivacyHandler`; see module-authoring.md.

Event names are in `EVENT_TYPES` (`apps/api/src/core/events/events.ts`), plus `<entity>.created|updated|deleted` for module record types.

## 4. Call out safely

```ts
await assertSafeUrl(url, 'webhook_url');
const res = await fetch(url, {
  method: 'POST',
  body,
  redirect: 'error',
  signal: AbortSignal.timeout(10_000),
});
if (!res.ok) throw new AppError('UPSTREAM_FAILED', `The chat service answered ${res.status}.`);
```

- **Check every address.** `assertSafeUrl` blocks private and internal addresses; use it on every outbound address.
- **Redirects and timeouts.** Refuse redirects, so a public address cannot bounce the request to an internal one, and always set a timeout.
- **Errors.** Throw `AppError('UPSTREAM_FAILED', …)` with a sentence written for people. Never pass the other service's own error text on.
- **Read settings when the job runs, not when it is queued.** A changed or removed address then takes effect for messages already waiting.

## 5. Test connection

```ts
export const chatNotify: ApiModule = {
  testConnection: async (settings) => {
    if (!settings.webhook_url)
      throw new AppError('UPSTREAM_FAILED', 'Add the incoming webhook address first.');
    await post(String(settings.webhook_url), 'Test message: …');
    return { message: 'Sent a test message. Check the channel.' };
  },
};
```

- **Which values it gets.** `settings` holds the values on screen laid over the saved ones, so admins can test before saving.
- **What people see.** An `AppError` message is shown to the admin; any other error is logged and replaced with a generic message.

## 6. Test it

`apps/api/test/chat-notify.test.ts` starts a local HTTP server as the other service. It checks that:

- required settings are enforced and the connection test passes and fails as it should
- the chosen events are posted and others are not
- nothing is posted about a restricted person
- nothing is sent once the module is turned off

Jobs run synchronously in tests, so assertions follow the request directly. Tests may call private addresses because `WEBHOOKS_ALLOW_PRIVATE=true` there.

## 7. Before you ship

- `npm run module:check -- <key>` passes. It checks:
  - the manifest, and that a help article exists
  - imports only from `@app/api/module-api`
  - tables named `m_<key>_*`
  - no `child_process` or `eval`
  - no brand names
- No vendor or product names anywhere in the module. Describe the other service generically ("a chat service that accepts incoming webhooks").
- The help article explains setup step by step and includes the settings table.
- `npm run typecheck`, `npm run lint` and the module's tests pass.

To publish the module for other instances, put it in its own repository, tag a release, and add it to the module catalog. See "Modules and the module catalog" in [integrations.md](integrations.md).
