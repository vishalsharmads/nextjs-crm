# Quotes, invoices, contracts and the client portal

Five modules cover the commercial side. Each one is turned on separately in **Settings → Modules**, so a workspace only gets what it uses. A blueprint can list them too; dependencies are enabled automatically.

| Module        | Needs    | What it adds                                                               |
| ------------- | -------- | -------------------------------------------------------------------------- |
| Products      | none     | A catalog with prices, units and tax rates                                 |
| Quotes        | Products | Priced proposals: draft → sent → accepted, declined or expired             |
| Invoices      | Products | Invoices, payments, overdue tracking. Accepted quotes convert in one click |
| Contracts     | none     | Agreements with start and end dates, renewal reminders and auto-renewal    |
| Client portal | none     | Customers sign in by email link to see documents and accept quotes         |

Business details and defaults (legal name, address, tax number, number prefixes, payment terms, default tax rate, renewal reminder) are set in **Settings → Sales documents**.

## How documents behave

- **Numbers** are sequential with no gaps (`Q-0001`, `INV-0001`, `C-0001`). Only drafts can be deleted. Issued invoices are voided instead, so the sequence stays intact.
- **Totals are always calculated by the server.** Each line is rounded, then lines are summed, so printed lines always add up to the printed total. Tax is shown per rate.
- **Drafts are editable. Sent and issued documents are not.**
  - To change a sent quote, _revise_ it, which returns it to draft.
  - To correct an issued invoice, void it and issue a new one.
  - An active contract's dates and value are fixed: renew or cancel it instead.
- **Access** follows the same own, team or all rules as deals, per document type. Configure it on each role. People can only link documents to records they can see.
- **Printing:** every document has a Print button. The page prints without the app around it, and the browser's "Save as PDF" produces the PDF.

## Payments

Record payments against issued invoices, as many partial payments as needed. The invoice moves from issued to partly paid to paid on its own. Payments larger than the balance are refused. A payment recorded by mistake can be removed, which recalculates the balance. Invoices with payments cannot be voided.

## Background jobs

These run every hour:

- **Quotes:** sent quotes past their valid-until date become expired.
- **Invoices:** open invoices past their due date are flagged overdue once. The owner is notified and `invoice.overdue` fires.
- **Contracts:**
  - Once a contract is inside its reminder window, the owner is notified and `contract.renewal_due` fires (once per term).
  - On the end date, auto-renew contracts start their next term. Others become expired.

Every status change emits an event (`quote.accepted`, `invoice.paid`, `contract.renewed`, …), so automations and webhooks can react. For example, an automation can mark a deal as won when its quote is accepted.

## Client portal

1. **Settings → Client portal → Invite** a contact. They need an email address.
2. They receive a sign-in link that works for 7 days. Later sign-ins use a new link each time from `/p/portal/login`. Those links work once, for 15 minutes.
3. In the portal they see quotes, invoices and contracts addressed to them. Drafts are never shown.
4. Tick **Their organization's documents too** for billing contacts who should see everything for their company.
5. They can accept a sent quote by typing their name, or decline it with an optional reason. The owner is notified, and the acceptance is recorded in the audit log.

Removing access signs the customer out immediately. Portal sessions are separate from staff sessions, so neither can be used for the other. The sign-in form answers the same way whether or not an address has access.
