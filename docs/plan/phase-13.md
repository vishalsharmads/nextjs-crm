# Phase 13: inbox and calendar

Source: row 13 of the [roadmap](../roadmap.md) and the feature-gap table in the [production-readiness review](../review/production-readiness-2026-11.md). Status: **approved by delegation (2026-11-16)**; built milestone by milestone.

## Goal

Salespeople live in their inbox and calendar. Their conversations and meetings with customers should land on the right records without copying, replies should be possible from the CRM in the same thread, and customers should be able to book time without email ping-pong.

## What exists today

| Area       | Today                                                                                                                                                                                 | Gap                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Mailboxes  | Per-user IMAP/SMTP account with a password (`mail_accounts`), sending through it, inbound sync every 5 minutes logging mail from known people (`email_messages`, an `email` activity) | No sign-in without a password, sent mail written in the CRM is not in the mailbox's Sent folder, no threads, no reply from the record |
| Activities | One related record per activity (`related_type`, `related_id`)                                                                                                                        | A meeting with three people from two companies appears on one record only; colleagues who attend are not linked                       |
| Tracking   | None                                                                                                                                                                                  | No open or click information                                                                                                          |
| Calendar   | Meetings are activities with a time; a calendar view of them                                                                                                                          | Nothing goes to or comes from people's own calendars; no invitations                                                                  |
| Booking    | Bookings module for resources (rooms, desks)                                                                                                                                          | No personal scheduling link for meetings                                                                                              |

## Milestones

| Milestone | Scope                                                                                                          |
| --------- | -------------------------------------------------------------------------------------------------------------- |
| 13a       | Activity participants and email threads                                                                        |
| 13b       | Two-way mailbox: Sent-folder sync, reply from the record, sign-in with OAuth providers the operator configures |
| 13c       | Email open and click tracking (off by default, never under the privacy or health-data profiles)                |
| 13d       | Calendar: two-way CalDAV sync, a private iCalendar feed, invitations with `.ics`                               |
| 13e       | Scheduling links: a public page where customers book a meeting in someone's free time                          |

### 13a: Participants and threads

- `activity_participants` (activity, kind `contact | lead | organization | user`, record id, role `attendee | organizer | to | cc`). The existing `related` record stays the activity's home; participants add it to more timelines. Timelines show an activity when the record is the related record **or** a participant. Scope: participants never widen access to the activity beyond the existing rule (whoever sees a record sees its activities, D9).
- Meetings and calls get a participants field (people and colleagues). Emails logged by sync add every known address in From/To/Cc as participants, so a message to two customers shows on both.
- `email_messages.thread_id`: from `References`/`In-Reply-To` (or the normalised subject plus the same people when headers are missing). The timeline groups an email thread into one item with its messages; the record page has a Conversations view.
- Privacy: participants are personal data links; export lists them, erasure removes the person's participant rows.

### 13b: Two-way mailbox

- Mail sent from the CRM through a connected mailbox is appended to its Sent folder (IMAP `APPEND`), so it appears in the person's mail program.
- **Reply** on an email in the timeline: the composer prefills To, subject and quotes; the message carries `In-Reply-To` and `References`, so it lands in the same thread on both sides.
- Sync also reads the Sent folder (messages the person wrote in their mail program to known people are logged), with a per-mailbox choice of folders.
- **Sign in instead of a password:** OAuth 2.0 with `XOAUTH2` for IMAP and SMTP. Which providers are offered comes from an operator file (`MAIL_OAUTH_PROVIDERS_FILE`: name, authorize and token URLs, scopes, IMAP/SMTP hosts, client id and secret) read at run time and never shipped in the repository, so the product stays white-label (decision D1). Tokens are stored encrypted (rotated by `crypto:rotate`) and refreshed in the background; a failed refresh asks the person to reconnect.

### 13c: Tracking

- Per message, optional: an open pixel and rewritten links through `/t/<token>` (signed, no record ids in the URL). Opens and clicks are stored on the message and shown on the email in the timeline ("opened 3 times, last 2 h ago").
- Off by default (setting `email.tracking`), and forced off under the privacy and health-data profiles (a new compliance floor) and for anyone who opted out of marketing. Tracking data is erased with the person and never sent in webhooks.

### 13d: Calendar

- **CalDAV two-way sync** per person (standard protocol supported by the common calendar services and servers; app password or the OAuth sign-in from 13b where the provider offers CalDAV). Meetings created in the CRM are written to the chosen calendar; events in that calendar with known people as attendees are logged as meetings with participants; time changes and cancellations flow both ways (last change wins, by `ETag`/`LAST-MODIFIED`).
- **Private iCalendar feed** per person (a secret URL, revocable) of their CRM meetings and tasks with times, for calendars that only subscribe.
- **Invitations:** saving a meeting with external participants can email them an `.ics` invitation (`METHOD:REQUEST`), updates and cancellations; replies (`METHOD:REPLY`) received by sync set each attendee's status.

### 13e: Scheduling links

- Each person may publish a link (`/book/<slug>`, public, rate-limited, no sign-in) with meeting types (duration, buffer, notice period, how far ahead), working hours in their time zone, and questions.
- Free time = working hours minus CRM meetings and, when connected, CalDAV busy times. The visitor picks a slot in their own time zone, enters name and email (and answers), and gets an invitation.
- The booking creates a meeting with the person as organizer and the visitor as participant, matched to an existing contact or lead by email (or creates a lead, as web forms do, with the same consent and restriction rules), and fires `meeting.booked` for automations. Cancel and reschedule links are in the invitation.
- Team links (round robin) wait for phase 14's routing rules.

## Decisions

| #   | Decision                                                                                                                                      | Why                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| D1  | Standards only (IMAP, SMTP, CalDAV, iCalendar, OAuth 2.0 with XOAUTH2); provider names and endpoints come from an operator file, not the code | White-label: no vendor names in the product; works with any mail and calendar service that speaks the standards |
| D2  | Participants add an activity to more timelines but do not change who may see it                                                               | Keeps the visibility rule from phase 11 (D9)                                                                    |
| D3  | Tracking is opt-in per workspace, per message, and impossible under privacy profiles                                                          | Tracking pixels are personal-data processing many customers must avoid                                          |
| D4  | Calendar conflicts: last modification wins, the losing version is kept in the activity history                                                | Simple and predictable; no merge dialogs for times                                                              |
| D5  | Scheduling links create leads like web forms do                                                                                               | One intake path with consent, restriction and duplicate rules                                                   |

## Out of scope (stays on the roadmap)

Vendor-specific mail and calendar APIs, shared team inboxes, email sequences (phase 14), round-robin booking (phase 14), video-meeting links (an integration module can add them).

## Verification

- API tests: participants on timelines and in scope, thread grouping from headers and from subjects, reply headers, IMAP `APPEND` against a local test IMAP double, OAuth token refresh with a stub provider, tracking pixel and link redirect (and refusal under profiles), CalDAV sync against a stub server, iCalendar feed contents, booking slot computation across time zones and daylight-saving changes, booking creates a lead with consent.
- Web tests: participants picker, thread view, reply composer, tracking badges, booking page.
- E2E: log a meeting with two contacts and see it on both; book a meeting through a public link and see it on the calendar.

Estimate: about 5–6 weeks, in the order 13a → 13e.

## Progress

**13a built (2026-11-16).** `activity_participants` (contact, lead, organization or colleague, with a role) put an activity on every participant's timeline and record activity list (`whereOnRecord`); participants are checked against the writer's scope and replaced as a list. Meetings and calls take participants in the composer. Sent and synced email adds every known address as a participant, and synced mail is logged when anyone on it (not only the sender) is a known contact or lead. `email_messages.thread_id` comes from In-Reply-To/References or a recent same-subject message between the same people (`threadFor`); the timeline shows one item per conversation with its size, and `GET /email/threads/:id?type&uuid` lists the messages on that record. Privacy export lists participations; erasure removes them; merges move them. Decision kept (D2): colleagues added as participants see the meeting in their calendar filter, but participation does not widen who can open the activity. Also fixed: the test helper that restores settings now keeps blueprint columns, which was the cause of the intermittent blueprint test failure.

