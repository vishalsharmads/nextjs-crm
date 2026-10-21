# Integrations

## REST API

Every screen uses the same API, so anything people can do, an integration can do.

1. **Settings → API keys → New key.** A key acts with one role's permissions and record scope. Pick the narrowest role that works. You can only grant roles within your own access.
2. Send it as a Bearer token. Bearer requests need no CSRF token.

```bash
curl https://crm.example/api/v1/contacts?pageSize=50 -H "Authorization: Bearer sk_…"
curl -X POST https://crm.example/api/v1/contacts -H "Authorization: Bearer sk_…" \
  -H "Content-Type: application/json" -d '{"firstName":"Ada","email":"ada@example.com","custom":{"plan":"pro"}}'
```

- Lists accept `page`, `pageSize` (max 100), `sort` (`-created_at,last_name`), `q`, and `filter`. `filter` is URL-encoded JSON such as `{"and":[{"field":"cf.plan","op":"eq","value":"pro"}]}`.
- Errors always look like `{ "error": { "code", "message", "details?" } }`.
- The full OpenAPI document is at `/api/v1/openapi.json` (admin session or a key with settings access).

## Webhooks

**Settings → Webhooks.** Choose events (or all). Each delivery is a `POST` with a JSON body:

```json
{ "id": "…", "type": "deal.won", "createdAt": "2026-10-21T10:00:00.000Z",
  "data": { "entity": "deal", "uuid": "…", "record": { … }, "changes": { "stage_id": { "from": 3, "to": 5 } } } }
```

Headers: `X-Webhook-Id`, `X-Webhook-Event`, `X-Webhook-Timestamp`, `X-Webhook-Signature`. Verify the signature:

```js
const expected =
  'sha256=' + crypto.createHmac('sha256', SECRET).update(`${timestamp}.${rawBody}`).digest('base64url');
// Compare with crypto.timingSafeEqual, and reject timestamps older than 5 minutes.
```

- Non-2xx responses are retried after 1, 5, 30, 120 and 720 minutes (6 attempts).
- An endpoint that fails 50 times in a row is switched off.
- URLs must be https and must not resolve to private addresses.

Events: `contact|organization|lead|deal.created|updated|deleted`, `deal.stage_changed|won|lost`, `lead.converted`, `activity.created|updated|completed`, `form.submitted`.

## Automations

**Settings → Automations.** Each automation has three parts:

- **When:** an event.
- **Only if:** the same filters as lists, plus _changed fields_ for updates.
- **Then:** one or more actions. Update a field, create a task, notify someone, send an email, or add tags.

Text can use the record, for example `{{record.title}}` or `{{record.owner.name}}`.

- Automations run in the background as the person who created them, with that person's permissions.
- Each run is logged with its outcome.
- Automations triggered by other automations stop after 3 levels, so rules cannot loop forever.

## Web forms

**Settings → Web forms.** Map form fields to core or custom fields, choose who gets the submissions, and add tags. Then share the link or embed it:

```html
<iframe src="https://crm.example/f/<form-id>?embed=1" style="width:100%;min-height:560px;border:0"></iframe>
```

Submissions need no session. They are protected by a per-IP rate limit, a hidden honeypot field and the same validation as the app.

## Email

**Settings → Email** connects a person's mailbox:

- **SMTP** sends as that person.
- **IMAP**, if configured, logs new inbox messages from known contacts every 5 minutes.

Without a mailbox, email goes out from the workspace address with replies to the sender. Every sent email is logged on the record's timeline. Passwords are encrypted at rest; use app passwords where providers require them.

## Background jobs

Imports, webhook deliveries and automations run as jobs.

- **Without `REDIS_URL`:** jobs run inside the API process. This is fine for one server.
- **With `REDIS_URL`:** they move to BullMQ, and scheduled tasks (reminders, webhook retries, mailbox sync) run on exactly one process even when several API processes are deployed.
