# Bookings, tickets, documents, inventory and the front desk

Operational modules are switched on per workspace in **Settings → Modules**, or listed in a blueprint.

| Module               | What it adds                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| Bookings             | Rooms, desks and equipment booked by the hour, with clash checks and opening hours             |
| Tickets              | A support desk with priorities, response targets, internal notes and customer replies          |
| Documents            | Letters and agreements generated from templates, signed online; files collected from customers |
| Inventory and assets | Equipment and keys lent to people with a full history; stock levels with reorder alerts        |
| Front desk check-ins | Coworking: members and visitors checked in and out; hosts emailed when guests arrive           |

## Bookings

- **Resources** have a type, capacity, location, optional hourly rate and optional opening hours and days. Opening hours are in the workspace time zone.
- **The day board** shows every resource against the hours of the day, in the workspace time zone, so everyone sees the same times wherever they are. Click a free slot to book it.
- **Clashes:** a resource cannot be double-booked, and back-to-back bookings are fine. The check locks the resource, so two people clicking the same slot at the same moment cannot both get it.
- Bookings longer than 31 days are refused. Cancelling frees the slot and keeps the record.

## Tickets

- **Priorities set response targets:**

  | Priority | First response | Resolution |
  | -------- | -------------- | ---------- |
  | Urgent   | 4 hours        | 24 hours   |
  | High     | 8 hours        | 48 hours   |
  | Normal   | 24 hours       | 72 hours   |
  | Low      | 48 hours       | 5 days     |

  Changing the priority recalculates both targets from when the ticket was opened.

- **Replies and notes:** a reply is visible to the customer in the client portal. An internal note is for your team only. The first reply records the response time.
- **Visibility:** people see tickets assigned to them or created by them, or more if their role grants team or all access. New assignees are notified.
- **From the portal:** customers can raise requests and reply. A customer reply reopens the ticket and tells the assignee.

## Documents

- **Templates** are HTML with placeholders such as `{{contact.firstName}}`, `{{organization.name}}`, `{{business.name}}`, `{{user.name}}`, `{{today}}` and `{{contact.custom.<field>}}`.
  - Values are escaped.
  - Scripts, styles and event handlers are removed.
  - Hidden custom fields are never filled in. A document only shows what the person generating it can see.
- **Lifecycle:** generate a draft for a contact, edit it, then _share_ it. It appears in their client portal and can no longer be edited. If the template needs a signature, the customer signs by typing their name. The signing time, IP address and a fingerprint (SHA-256) of the content are kept.
- **File requests:** ask a contact for one or more files, such as a passport copy or proof of address, each with an optional due date.
  - **Upload:** they upload each file in the portal.
  - **Review:** you approve it, or reject it with a note, which asks them to upload again.
  - **Storage:** uploaded files also appear in the contact's files.
- **Access** follows the contact. If you cannot see the contact, you cannot see their documents or requests.

## Inventory and assets

- **Assets** have a unique tag (for example `KEY-014`), a category, a serial number and a location.
  - **Lending:** lend an asset to a contact with an optional due-back date. Overdue items are flagged.
  - **Returning:** on return, you can send it to maintenance. Retired assets drop out of the default list.
  - **History:** every change is kept on the asset.
- **Stock items** track a quantity, with three kinds of movement:
  - _Add_ increases the quantity.
  - _Use_ decreases it. Stock never goes below zero.
  - _Count_ records an actual count.

  Falling to the reorder level fires `stock.low` once and notifies the person who made the change.

## Front desk check-ins (coworking)

- **Members:** check in a member, with an optional badge. A member cannot be checked in twice.
- **Visitors:** check in a visitor with who they are visiting. The host gets an email that their guest has arrived.
- **In the building** shows everyone checked in, and **Today** is the day's visit log in the workspace time zone.

## Events for automations and webhooks

`booking.created|updated|cancelled`, `ticket.created|updated|replied|resolved`, `document.shared|signed`, `document_request.submitted|reviewed`, `asset.assigned|returned`, `stock.low`.
