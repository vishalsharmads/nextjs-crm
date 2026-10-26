# Compliance readiness

This CRM ships the technical controls that privacy and health-data laws expect. It does not make a workspace compliant by itself: the operator still needs the agreements (DPA, BAA), policies, hosting safeguards and staff training the law requires. This document describes what the software does. The operator decides how to use it.

## Profiles

An admin picks a profile under **Settings → Compliance**. Only admins can change the Security and Compliance settings, because they weaken or strengthen every account's protection. A profile sets minimum settings (floors). While it is active:

- the server applies the floors on every read, even if a stored value is lower;
- saving a setting below a floor is rejected with a validation error that names the field;
- switching to a stricter profile raises the stored values right away (and records it in the audit log).

| Profile     | For                                                                         | Floors                                                                                                                                                                                                                                                                 |
| ----------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Standard    | Workspaces with no special obligations                                      | None                                                                                                                                                                                                                                                                   |
| Privacy     | Personal data under GDPR, UK GDPR, DPDP (India), CCPA/CPRA, PIPEDA and LGPD | Added by later milestones of Phase 5 (consent capture, request tracking, retention)                                                                                                                                                                                    |
| Health data | Protected health information under HIPAA                                    | Everything in Privacy, plus: 2FA for every user, password of at least 12 characters with mixed case and a digit, lockout after at most 5 failures, sign-out after at most 15 minutes of inactivity, sessions of at most 12 hours, API keys that expire within 365 days |

## Controls

### Access and authentication

| Control                      | Where                                      | Notes                                                                                                                                                                 |
| ---------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unique user accounts         | Settings → Users                           | No shared logins; API keys are separate, hashed, and scoped by permission.                                                                                            |
| Password policy and lockout  | Settings → Security                        | argon2id hashes; minimum length, character mix, lockout threshold and duration.                                                                                       |
| Two-factor authentication    | Profile; Settings → Security / Compliance  | TOTP. Can be required for admins, for chosen roles, or for everyone. Users who must enrol are held on their profile page until they do.                               |
| Recovery codes               | Profile                                    | Ten single-use codes issued when 2FA is turned on, shown once and stored hashed. Using one is audited; users can replace them with their password.                    |
| Automatic logoff             | Settings → Compliance                      | Warning one minute before the limit, then sign-out. The server enforces the same limit, judged by the user's last keyboard or pointer input, not background requests. |
| Maximum session length       | Settings → Compliance                      | Forces a new sign-in after a fixed number of hours, active or not.                                                                                                    |
| API key lifetime             | Settings → Compliance, Settings → API keys | Optional maximum age. New keys must expire within it, and older keys stop working once they pass it. Keys are not subject to idle or session limits.                  |
| Sign-in notice               | Settings → Compliance                      | Free text under the sign-in form, for example an authorized-use warning.                                                                                              |
| Role-based access and scopes | Settings → Roles                           | Permissions per action; record scope own / team / all; per-role field visibility for custom fields.                                                                   |
| Audit log                    | Settings → Audit log                       | Every change, sign-in, failed sign-in, 2FA event, session expiry and export. Append-only (database triggers).                                                         |

Later Phase 5 milestones add access logging, data subject requests and consent, retention and encryption of sensitive fields. This document grows with them.
