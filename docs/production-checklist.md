# Production checklist

Use this before the first client goes live, and for each new client instance. Detailed steps are in [deployment.md](deployment.md).

## Already in the product

- Passwords hashed with argon2id; optional or required 2FA; account lockout; idle session expiry.
- Sessions in httpOnly cookies only, with CSRF protection on every change. API keys are scoped to a role.
- Role permissions and own/team/all record access, enforced on every list, record, export, search, widget and linked record name.
- Append-only audit log, protected by database triggers.
- Uploads checked by content (not file name), stored under random names, and only parsed after access checks.
- Rate limits on sign-in, public forms, the client portal and the whole API (`API_RATE_LIMIT_PER_MIN`).
- Customer portal sessions kept separate from staff sessions. Sign-in links are single-use, expire, and are cleaned up every 6 hours.
- Health checks: `/api/v1/health` (process) and `/api/v1/health/ready` (process and database).
- Backups: `deploy/backup.sh` (database dump + uploaded files, 14-day retention). `deploy/release.sh` backs up before every schema change. Restore with `deploy/restore.sh`.
- Load: about 300 requests/s with 20,000 contacts on one unoptimized development process, 95th percentile under 210 ms and no errors (`scripts/load-test.mjs`).

## Before the first client (one time)

1. **Staging server.** Deploy to a server that matches production (Ubuntu LTS, Node 24, MySQL 8.4, nginx) using `deploy/` and [deployment.md](deployment.md). Run `npm run doctor` there.
2. **MySQL 8.4 on staging.** Development uses a newer MySQL. Run the full test suite once against 8.4 (`DATABASE_URL_TEST` pointing at the staging server's MySQL).
3. **Load test on staging.** `npm run cli -w @app/api -- seed:volume --contacts=50000`, then `node scripts/load-test.mjs` from another machine. Expect better numbers than in development (built code, production mode).
4. **Penetration test.** Before handling client data and payments, have an independent tester check the staging instance, especially sign-in, the client portal and uploads.
5. **Restore drill.** Take a backup on staging, restore it into an empty database with `deploy/restore.sh`, start the API and confirm `/api/v1/health/ready` and a few records.
6. **Pilot.** One friendly client, or your own team, uses staging for a week. Fix what they hit before onboarding more clients.

## For every client instance

- [ ] Own checkout, database, `.env`, storage folder, systemd unit and nginx vhost (see `deploy/`).
- [ ] `.env`: new random `JWT_SECRET`, `CSRF_SECRET`, `FILE_URL_SECRET` and a 64-hex `ENCRYPTION_KEY`; `APP_URL` with https; `TRUST_PROXY=1` behind nginx; `COOKIE_SECURE` on. **No `DEMO_MODE`.**
- [ ] HTTPS certificate (for example Let's Encrypt) and HTTP redirected to HTTPS.
- [ ] Email: SMTP account for the client's domain, with **SPF, DKIM and DMARC** records published. Send a test (invite a user) and check it lands in the inbox, not spam.
- [ ] `npm run install:instance -- --blueprint=<industry> --admin-email=... --admin-password=...` (no `--sample-data`).
- [ ] Nightly backup scheduled (cron or systemd timer running `deploy/backup.sh`), copied off the server (another region or provider).
- [ ] Uptime monitor on `https://<domain>/api/v1/health/ready` with alerts to you.
- [ ] Log retention: `journalctl` for the unit, or ship logs to your logging service.
- [ ] Admin account has 2FA turned on, and **Settings → Security** has "Require 2FA for admins" on.
- [ ] **Settings → Compliance** has the right profile for the data you hold (Privacy for personal data under GDPR-style laws, Health data for HIPAA). See [compliance/overview.md](compliance/overview.md).
- [ ] Every admin has saved their 2FA recovery codes somewhere other than the device that runs the authenticator app.
- [ ] Branding, business details (**Settings → Sales documents**) and vocabulary checked with the client.

## Demo instances

One industry per instance. For each: an empty database, then `deploy/setup-demo.sh <blueprint>` (installs sample data and one demo user per role), then run it with `DEMO_MODE=true`. Keep demo instances on their own hostnames, never on a client's server.
