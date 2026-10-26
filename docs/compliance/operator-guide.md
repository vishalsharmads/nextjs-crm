# Operator guide

For the people who run an instance for a client who holds personal or health data. The product provides the controls in [overview.md](overview.md); this guide covers what you must set up and do around them. It is not legal advice: have the client's counsel or data protection officer confirm what applies to them.

## 1. Before go-live

1. **Pick the profile.** Settings → Compliance: **Privacy** for personal data under GDPR, UK GDPR, DPDP, CCPA/CPRA, PIPEDA or LGPD; **Health data** for HIPAA. The profile's minimums cannot be lowered while it is active.
2. **Agreements.** Sign a data processing agreement (GDPR Art. 28) with the client, and with each provider that touches the data: hosting, email delivery (SMTP), off-site backup storage, log shipping. For health data, sign business associate agreements (HIPAA §164.314) with the client and with each of those providers. Use only providers that will sign one.
3. **Hosting safeguards** the software cannot enforce. `npm run doctor` reports them under a compliance profile:
   - HTTPS only (HSTS on in nginx, as in `deploy/nginx.conf.example`) and TLS on any database connection that leaves the server.
   - nginx access logs without query strings (the `crm_minimal` log format in the example).
   - Full-disk encryption on the server and on backup storage.
   - MySQL encryption at rest: install a keyring component, then `SET PERSIST default_table_encryption = ON`, `ALTER TABLE … ENCRYPTION = 'Y'` for existing tables, and `SET PERSIST binlog_encryption = ON`.
   - Encrypted backups: create a key file (`openssl rand -hex 32 > /etc/crm/backup.key`, `chmod 600`), set `BACKUP_ENCRYPTION_KEY_FILE` for `deploy/backup.sh`, and store a copy of the key away from the server. A backup without its key cannot be restored.
   - Turn on **Encrypt uploaded files** (forced by the Health data profile) and run `npm run cli -w @app/api -- files:encrypt-existing` once.
4. **Mark sensitive data.** Create health or other special-category custom fields with Data protection: **Sensitive**. It cannot change later. Mark other personal custom fields **Personal** so they show in the data map.
5. **Consent purposes.** Settings → Compliance → Consent purposes. Write the exact wording people will tick, choose the lawful basis, and tick Marketing for marketing purposes. Add them to every web form that collects personal data.
6. **Retention.** Agree retention periods with the client and add rules (Settings → Compliance → Data retention). Check them under Settings → Privacy → Retention before relying on them.
7. **Roles.** Give each role only what it needs. Only roles that need it get `core.privacy.manage` (privacy requests, export, erasure), `core.audit.view` / `core.audit.export`, and `core.fields.reveal` (sensitive values).
8. **Emergency access.** Keep one admin account for emergencies: strong password and 2FA, its recovery codes sealed offline (for example in a safe), used only when normal admins cannot sign in. Every use shows in the audit log; review it afterwards.
9. **Logs off the server.** Ship the application log (journald) to separate storage. It carries the daily audit digests, so an attacker who alters the database cannot also alter the evidence.
10. **Record of processing.** Settings → Data map lists what the workspace holds, how long it keeps it and who receives it. Add hosting and backup providers, and give it to the client for their record of processing activities (GDPR Art. 30, LGPD Art. 37).

## 2. Answering a privacy request

1. Log it in Settings → Privacy the day it arrives. The due date follows from it: GDPR and UK GDPR one month, CCPA 45 days, HIPAA access 30 days, PIPEDA 30 days.
2. Verify the requester's identity before acting, and note how in the request.
3. Link the request to the person's record, then act from the request:
   - **Access or portability:** Download their data and send the ZIP securely (for example an encrypted, expiring link; not a plain email attachment).
   - **Correction:** edit the record.
   - **Erasure:** Erase personal data (keeps the record for reports) or Delete permanently. Keep the erasure report with the request. Data listed as kept (invoices, signed documents) stays for the legal reason shown.
   - **Restriction or objection:** Restrict processing. Automations, webhooks and CRM email then skip the person until you lift it.
   - **Do not sell or share / marketing opt-out:** withdraw the marketing consents on the record's Privacy tab. The unsubscribe link does this on its own.
4. Data outside the CRM (exports people downloaded, email inboxes, other systems that received webhooks) is yours to handle: the audit and access logs show where exports went.
5. Mark the request Completed with a resolution, and reply to the person.

## 3. Ongoing

| When                                 | What                                                                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Weekly                               | Settings → Audit log → **Check integrity** (or `audit:verify` from cron). Investigate any mismatch immediately.                                                                            |
| Monthly                              | Review overdue privacy requests and the retention preview.                                                                                                                                 |
| Quarterly                            | Access review: export the audit and access logs, check who has admin, privacy, audit and reveal permissions, and disable leavers (then erase them with Users → Erase or `user:anonymize`). |
| Quarterly                            | Restore drill from an encrypted backup into an empty database.                                                                                                                             |
| Yearly, or when a key may be exposed | Rotate keys: add a new key first in `ENCRYPTION_KEYS` (`new:<hex>,old:<hex>`), restart, run `crypto:rotate`, and remove the old key only once no backup that needs it is kept.             |
| Yearly                               | Penetration test; review the risk analysis or DPIA; refresh staff training.                                                                                                                |

## 4. Incidents and breaches

1. **Contain:** disable affected accounts, revoke API keys, rotate secrets and keys if they may be exposed.
2. **Investigate:** export the audit and access logs for the period (filter by user, IP address and date) and run the integrity check. The access log shows which records were viewed or exported.
3. **Notify on time:**
   - GDPR and UK GDPR: the supervisory authority within 72 hours of becoming aware, and affected people without undue delay when the risk is high.
   - HIPAA: affected individuals without unreasonable delay and no later than 60 days after discovery; HHS (and the media for 500 or more people in a state).
   - DPDP: the Data Protection Board and each affected person.
   - LGPD: the ANPD and affected people.
   - PIPEDA: the Privacy Commissioner and affected people when there is a real risk of significant harm, and keep a record of every breach for 24 months.
   - US states: follow each state's breach law (California: Civil Code 1798.82).
4. **Record** what happened, what data was affected and what you did, even when no notification is required.

## 5. What the product does not do

- It does not make the client compliant on its own, and it is not certified under any scheme.
- It does not sign agreements, run your servers, encrypt your disks or database tablespaces, or send breach notifications.
- Modules other than the core record types do not log record views yet (they do take part in export and erasure).
- Sensitive fields cannot be filtered, sorted or searched: they are encrypted.
- Sensitivity is fixed when a field is created. To change it, create a new field and move the values.
- Holders of `core.privacy.manage` see everything about a person in a data export, including fields hidden from their role: give that permission only to the people who answer privacy requests.
- The audit and access logs are not limited by record scope: `core.audit.view` shows every record's history. Give it only to people who may see all records.
- Audit entries a former staff member made keep their IP address and user agent after the staff member is erased, as evidence of who did what.
- Staff can record consent manually (phone, paper) even after someone unsubscribed: only do so when the person asked, and write how in the note.
- A web form submission is saved before its consent; if recording the consent fails, the record exists without it (the error is logged). Check the record's Privacy tab if a submission reports an error.
- nginx's own access log is outside the app: use the `crm_minimal` log format from `deploy/nginx.conf.example`, which leaves out query strings (search terms and filters).
