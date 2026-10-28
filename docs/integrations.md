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

## AI clients (MCP)

AI assistants that support the Model Context Protocol can work with the workspace on a person's behalf.

1. An admin turns it on in **Settings → AI clients**, chooses which tools clients may call, and sets a per-token rate limit (default 60 calls a minute).
2. Each person creates a token in **Profile → Access tokens**: read only, or read and write, expiring within a year (or sooner under the compliance profile's key limit). The secret is shown once.
3. The client connects to `POST https://<host>/api/v1/mcp` (Streamable HTTP, JSON responses) with `Authorization: Bearer pat_…`. Clients that only launch local commands use the stdio bridge:

   ```
   MCP_URL=https://<host>/api/v1/mcp MCP_TOKEN=pat_… npx tsx apps/api/src/cli/mcp-stdio.ts
   ```

Every call runs as the token's person, through the same permission, record-scope, field-visibility, access-log and audit paths as the app; audit rows show `mcp` as the actor type. Hidden fields never leave the API and sensitive values stay masked. Tokens authenticate only the MCP endpoint, never the REST API, and a person who must enrol in two-factor authentication cannot use one until they do.

Tools: `describe_schema`, `search_records`, `list_records`, `get_record`, `get_timeline`, `list_pipelines` (read) and `create_record`, `update_record`, `add_note`, `create_task`, `log_activity`, `move_deal_stage` (write; not offered to read-only tokens). Resources: `crm://schema` and `crm://record/{entity}/{uuid}`.

## Assistant

The `assistant` module adds an in-app chat that answers questions about records, summarises history, drafts notes and emails, and proposes changes. Enable it in **Settings → Modules**, then set it up on its **Settings** tab (permission `assistant.settings.manage`):

- **API format**: "Messages API" (native tool-use blocks; the base URL is the host, `/v1/messages` is added) or "Chat completions API" (the widely used format; the base URL includes `/v1`, then `/chat/completions` is added). Self-hosted and cloud-hosted models that speak either format work. The base URL must use https and resolve to a public address (set `WEBHOOKS_ALLOW_PRIVATE=true` for a model on your own network); redirects are not followed, and changing the URL or format clears the saved key, so it is never sent to a new address.
- **Model**, **API key** (stored encrypted, never shown again, rotated by `crypto:rotate`) and any **extra request headers** the provider requires, for example an API version header.
- **Assistant name**: what people see. No provider name appears anywhere in the product.
- **Limits**: tokens per month for the workspace and per person per day (0 is no limit). **Retention**: conversations are deleted after this many days (30 by default).
- **Never send these to the provider**: record types the assistant may not read or change.
- Under the `hipaa` compliance profile the assistant stays off until an admin confirms an agreement with the provider covers health information.

The assistant runs the same tools as MCP clients, as the signed-in person: their permissions, record scope and field visibility apply, hidden fields are never sent and sensitive values stay masked. Read tools run on their own. Every change (create, update, note, task, stage move) is shown to the person, who confirms or declines it; confirmed changes are audited with actor type `assistant`. Conversation text is not written to the audit log. Each conversation is visible only to the person who started it. Usage per person per month is on the Settings tab. Conversations that mention a person (by id or email, in any letter case) are exported for access requests and deleted on erasure. Starting and deleting a conversation, and each confirmed or declined change, are audited without the conversation text. One conversation step runs per person at a time, so usage caps are not overshot by parallel requests; providers that report no usage are charged an estimate.

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

- **When:** an event, optionally after a wait (minutes, hours or days), or **on a schedule** (daily or weekly at a time in the workspace time zone) for every record of one type that matches.
- **Only if:** the same filters as lists, plus _changed fields_ for updates. After a wait the conditions are checked again against the record as it is then, so "three days after a deal is created, if it is still open" works; a deleted record, or one the rule's owner can no longer see, is skipped.
- **Then:** one or more actions. Update a field, create a task, notify someone, send an email, add or remove tags, add a note, or assign the record to one of a list of people in turn.

Text can use the record, for example `{{record.title}}` or `{{record.owner.name}}`.

- Automations run in the background as the person who created them, with that person's permissions.
- Each run is logged with its outcome.
- Automations triggered by other automations stop after 3 levels, so rules cannot loop forever.
- Waiting runs are kept in the database, so a restart does not lose them. A scheduled rule visits at most 500 records per run. Erasing a person drops runs waiting for them.

## Reports and dashboards

**Reports** (permission `core.reports.view`) has four tabs: a forecast of open value by expected close month weighted by stage probability; monthly **quotas** with attainment (set them with `core.quotas.manage`); **velocity** (win rate, average won value, cycle length and time in each stage); and **custom** reports. A custom report takes one record type, groups it by a field (a choice, a person, a stage or pipeline, or a date by day, week, month, quarter or year), measures a count, total or average of a number field, applies list filters, and shows bars, a line, a pie or a table. A second grouping (**Break down by**) splits each group, shown as stacked bars or a matrix table (the 8 largest columns, the rest as Other). Reports run as the viewer, so record scope and field visibility apply; grouping by a linked record (a contact, say) is not offered, so names outside someone's scope never appear. Reports can be shared with everyone (`core.saved_views.share`).

**Currencies.** Reports are in one currency by default. Turn on **All currencies** (sales reports) or **Convert all currencies** (custom reports with a total or average) to convert every deal into the workspace currency with the rates in **Settings → Currencies** (`core.settings.manage`). Currencies without a rate are left out and named above the report. Records keep their own currency; only reports convert.

**Dashboards.** Anyone can edit their home dashboard: add built-in widgets or saved reports, resize, reorder and remove them. The first save creates a personal copy; **Reset to shared** goes back to the workspace dashboard, which only people with `core.dashboard.manage` can change.

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
