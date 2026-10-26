# Control matrix

Which product control supports which requirement. "Operator" means the organization running the instance must do it; the software cannot. A control that "supports" a requirement helps you meet it. Meeting it also depends on how you configure and use the product (see [overview.md](overview.md) and [operator-guide.md](operator-guide.md)).

References: GDPR and UK GDPR articles (same numbering), HIPAA 45 CFR Part 164, SOC 2 Trust Services Criteria (2017, revised 2022), ISO/IEC 27001:2022 Annex A, CCPA/CPRA (Cal. Civ. Code), India DPDP Act 2023, Brazil LGPD, Canada PIPEDA (Schedule 1 principles and sections).

## Access control and authentication

| Control                                                                                | GDPR / UK GDPR       | HIPAA                                      | SOC 2        | ISO 27001             | Others                                                                             |
| -------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------ | ------------ | --------------------- | ---------------------------------------------------------------------------------- |
| Unique user accounts, no shared logins; API keys per integration                       | Art. 32(1)(b)        | §164.312(a)(2)(i)                          | CC6.1, CC6.2 | A.5.16, A.8.5         | DPDP s.8(5); LGPD Art. 46; PIPEDA 4.7                                              |
| Role permissions and own / team / all record scope                                     | Art. 25, 32          | §164.308(a)(4), §164.312(a)(1)             | CC6.1, CC6.3 | A.5.15, A.5.18, A.8.3 | LGPD Art. 46; PIPEDA 4.7.3                                                         |
| Field visibility per role; sensitive fields masked with logged reveal                  | Art. 5(1)(c), 25, 32 | §164.502(b) minimum necessary, §164.514(d) | CC6.1, C1.1  | A.8.3, A.8.11         | CPRA 1798.121; LGPD Art. 46                                                        |
| Password policy (argon2id hashes), lockout                                             | Art. 32              | §164.308(a)(5)(ii)(D)                      | CC6.1        | A.5.17, A.8.5         |                                                                                    |
| Two-factor authentication, required by role or for everyone; single-use recovery codes | Art. 32              | §164.312(d)                                | CC6.1        | A.8.5                 |                                                                                    |
| Automatic logoff (idle) and maximum session length                                     | Art. 32              | §164.312(a)(2)(iii)                        | CC6.1        | A.8.5                 |                                                                                    |
| Admin-only security and compliance settings; profile floors enforced by the server     | Art. 25(2), 32       | §164.308(a)(3)                             | CC6.3, CC8.1 | A.8.2, A.8.9          |                                                                                    |
| Sign-in notice                                                                         | —                    | —                                          | CC2.3        | A.5.10                |                                                                                    |
| API key maximum age                                                                    | Art. 32              | §164.312(d)                                | CC6.1, CC6.2 | A.5.18                |                                                                                    |
| Emergency access                                                                       | Art. 32(1)(c)        | §164.312(a)(2)(ii)                         | A1.2         | A.5.29                | **Operator**: keep a sealed admin account with recovery codes (see operator guide) |

## Accountability, logging and integrity

| Control                                                                 | GDPR / UK GDPR                    | HIPAA                                 | SOC 2        | ISO 27001      | Others                                      |
| ----------------------------------------------------------------------- | --------------------------------- | ------------------------------------- | ------------ | -------------- | ------------------------------------------- |
| Audit log of every change, sign-in, 2FA event and export                | Art. 5(2), 30, 32                 | §164.312(b)                           | CC7.2, CC4.1 | A.8.15         | DPDP s.8(5); LGPD Art. 37, 46; PIPEDA 4.1.4 |
| Access log of record views, downloads, exports, reveals and audit reads | Art. 5(2), 32                     | §164.312(b), §164.308(a)(1)(ii)(D)    | CC7.2        | A.8.15, A.8.16 |                                             |
| Append-only storage (database triggers)                                 | Art. 5(1)(f), 32                  | §164.312(c)(1)                        | CC7.2        | A.5.33, A.8.15 |                                             |
| Daily chained SHA-256 digests; integrity check                          | Art. 5(1)(f), 32(1)(b)            | §164.312(c)(1), (c)(2)                | CC7.2, PI1.4 | A.5.33, A.8.15 |                                             |
| Audit and access log export for access reviews and investigations       | Art. 33(5) (documenting breaches) | §164.308(a)(1)(ii)(D), §164.308(a)(6) | CC4.1, CC7.3 | A.5.25, A.5.28 |                                             |
| Log retention with a floor (Privacy 1 year; Health data 6 years)        | Art. 5(1)(e)                      | §164.316(b)(2)(i)                     | C1.2         | A.5.33         |                                             |

## Data subject rights and consent

| Control                                                                | GDPR / UK GDPR    | HIPAA                                          | CCPA / CPRA              | DPDP   | LGPD                  | PIPEDA           |
| ---------------------------------------------------------------------- | ----------------- | ---------------------------------------------- | ------------------------ | ------ | --------------------- | ---------------- |
| Privacy request tracker with due dates and reminders                   | Art. 12(3)        | §164.524(b)(2) (30 days)                       | 1798.130(a)(2) (45 days) | s.13   | Art. 18, 19           | s.8(3) (30 days) |
| Data export (JSON plus files)                                          | Art. 15, 20       | §164.524                                       | 1798.100, 1798.110       | s.11   | Art. 18 II, V         | 4.9              |
| Correction (record editing, audited)                                   | Art. 16           | §164.526                                       | 1798.106                 | s.12   | Art. 18 III           | 4.9.5            |
| Erasure everywhere, with legal holds reported                          | Art. 17, 17(3)    | — (retention rules apply)                      | 1798.105                 | s.12   | Art. 18 IV, VI        | 4.5.3            |
| Restriction of processing                                              | Art. 18           | §164.522(a) (restriction requests)             | —                        | —      | Art. 18 IV (blocking) | —                |
| Objection and marketing opt-out; unsubscribe link and one-click header | Art. 21(2), 21(3) | §164.508(a)(3) (marketing needs authorization) | 1798.120                 | s.6(4) | Art. 18 §2            | 4.3.8            |
| Do not sell or share                                                   | —                 | —                                              | 1798.120, 1798.135       | —      | —                     | —                |
| Consent ledger: purpose, lawful basis, wording, hash, time, IP         | Art. 6, 7(1)      | —                                              | 1798.100(a) notice       | s.6    | Art. 7, 8             | 4.3              |
| Opt-in checkboxes on web forms; required consents enforced             | Art. 7, 25(2)     | —                                              | —                        | s.6    | Art. 8                | 4.3              |
| Erasure of former staff                                                | Art. 17           | —                                              | 1798.105                 | s.12   | Art. 18               | 4.5.3            |

## Storage limitation, minimization and encryption

| Control                                                                  | GDPR / UK GDPR    | HIPAA                                     | SOC 2            | ISO 27001      | Others                                                           |
| ------------------------------------------------------------------------ | ----------------- | ----------------------------------------- | ---------------- | -------------- | ---------------------------------------------------------------- |
| Retention rules (erase or delete people after a period)                  | Art. 5(1)(e)      | §164.530(j) (documentation only)          | C1.2, P4.2, P4.3 | A.5.33, A.8.10 | CPRA 1798.100(a)(3); DPDP s.8(7); LGPD Art. 15, 16; PIPEDA 4.5.3 |
| Housekeeping of sessions, jobs, webhook deliveries, notifications, files | Art. 5(1)(c), (e) | §164.310(d)(2)(i)                         | C1.2             | A.8.10         |                                                                  |
| Minimal webhooks and notification email                                  | Art. 5(1)(c), 25  | §164.502(b), §164.312(e)(1)               | C1.1, CC6.7      | A.8.12         | LGPD Art. 6 III                                                  |
| Request logs mask query values; mail failures log a hash                 | Art. 5(1)(c), 32  | §164.312(b)                               | CC6.1            | A.8.11, A.8.15 |                                                                  |
| Sensitive field encryption (AES-256-GCM), masking and logged reveal      | Art. 9, 32(1)(a)  | §164.312(a)(2)(iv)                        | C1.1             | A.8.11, A.8.24 | CPRA 1798.121; LGPD Art. 11                                      |
| Upload encryption                                                        | Art. 32(1)(a)     | §164.312(a)(2)(iv)                        | C1.1             | A.8.24         |                                                                  |
| Key ring and rotation                                                    | Art. 32           | §164.312(a)(2)(iv)                        | CC6.1            | A.8.24         |                                                                  |
| Encrypted backups with checksums                                         | Art. 32(1)(c)     | §164.308(a)(7)(ii)(A), §164.312(a)(2)(iv) | A1.2             | A.8.13, A.8.24 |                                                                  |
| Data map (records, sensitivity, retention, recipients)                   | Art. 30           | §164.316                                  | P1.1             | A.5.9, A.5.34  | LGPD Art. 37                                                     |

## Operator responsibilities

| Requirement                                                        | GDPR / UK GDPR         | HIPAA                                                      | Others                                                 |
| ------------------------------------------------------------------ | ---------------------- | ---------------------------------------------------------- | ------------------------------------------------------ |
| Agreements with every processor (hosting, email delivery, backups) | Art. 28                | §164.308(b), §164.314 (BAAs)                               | DPDP s.8(2); LGPD Art. 39                              |
| TLS for all traffic; HTTPS only                                    | Art. 32                | §164.312(e)(1), (e)(2)(ii)                                 | PIPEDA 4.7                                             |
| Encrypted disks, database tablespaces and binary logs              | Art. 32                | §164.312(a)(2)(iv), §164.310(d)                            |                                                        |
| Breach detection, assessment and notification                      | Art. 33 (72 hours), 34 | §164.400–414 (without unreasonable delay, at most 60 days) | CCPA 1798.82; DPDP s.8(6); LGPD Art. 48; PIPEDA s.10.1 |
| Risk analysis / data protection impact assessment                  | Art. 35                | §164.308(a)(1)(ii)(A), (B)                                 | LGPD Art. 38                                           |
| Policies, training, access reviews, sanctions                      | Art. 24, 39            | §164.308(a)(1)(ii)(C), (a)(5)                              | SOC 2 CC1, CC2                                         |
| Privacy notice telling people how to exercise their rights         | Art. 13, 14            | §164.520                                                   | CCPA 1798.100(b), 1798.130; DPDP s.5                   |
| Data protection officer or privacy contact                         | Art. 37–39             | §164.530(a)                                                | DPDP s.8(9), s.10; LGPD Art. 41                        |
| Physical security of servers                                       | Art. 32                | §164.310                                                   |                                                        |
| Penetration testing and vulnerability management                   | Art. 32(1)(d)          | §164.308(a)(8)                                             | SOC 2 CC7.1                                            |
