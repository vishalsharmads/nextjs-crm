# Deploying an instance

Each client gets their own instance: a directory (or server), a MySQL database, an `.env`, a systemd unit and an nginx server block. No containers are used.

Demo servers and hosts without nginx (shared hosting) can run the website and the app from one Node process on one port instead: see [deploy-single-server.md](deploy-single-server.md). Client instances use the setup below.

## Requirements

|               | Minimum                                                                                                                                               |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node          | 22 (24 LTS recommended)                                                                                                                               |
| MySQL         | 8.4 LTS, `STRICT_TRANS_TABLES`, InnoDB, utf8mb4                                                                                                       |
| Database user | Full rights on the instance database, plus `TRIGGER`. With binary logging on, either `SUPER`/`SET_ANY_DEFINER` or `log_bin_trust_function_creators=1` |
| SMTP          | Any relay. Set the sender name and address in Settings → Branding                                                                                     |
| nginx         | Terminates TLS and serves web and API on one origin                                                                                                   |

## First install

```bash
git clone <repo> /srv/crm/acme && cd /srv/crm/acme
cp .env.example .env          # fill in DATABASE_URL, secrets (openssl rand -hex 32), SMTP, APP_URL
npm ci && npm run build
npm run doctor                # fix anything marked ✖
npm run install:instance -- --blueprint=coworking --app-name="Acme Workspace" \
  --admin-email=owner@acme.example --admin-name="Owner Name"
```

The installer creates the database, runs migrations, seeds defaults and the blueprint, and creates the admin. Without `--admin-password` it prints a temporary password. Running it again is safe: it changes nothing that exists.

Then:

1. Copy `deploy/crm-api.service.example` to `/etc/systemd/system/crm-acme.service`, adjust paths, `systemctl enable --now crm-acme`.
2. Copy `deploy/nginx-security-headers.conf` to `/etc/nginx/snippets/crm-security-headers.conf` and `deploy/nginx.conf.example` to a server block, set `server_name` and certificates, then run `nginx -t` and reload nginx. Every `location` includes the header snippet, because nginx drops inherited `add_header` lines in any block that sets its own. The example also rate-limits sign-in (`/api/auth/`, 10 a minute per address) and the API as a whole.
3. Set `TRUST_PROXY=1` in `.env` (nginx is one proxy hop). `doctor` fails in production without it.
4. Sign in, then set branding, invite users and review fields.

## Releases

Each release is built in its own folder and the service is switched to it only once it is ready, so a bad release can be undone in seconds.

```
/srv/crm/acme/
  .env                      shared by every release
  storage/                  uploaded files (STORAGE_DIR)
  repo/                     git clone the releases are taken from
  releases/<utc>-<sha>/     one built release per folder (the newest 5 are kept, KEEP_RELEASES)
  current -> releases/…     the release that runs; the systemd unit uses current/apps/api
```

```bash
REPO_URL=<git url> BLUEPRINT=coworking deploy/release.sh /srv/crm/acme crm-acme   # REPO_URL only the first time
deploy/rollback.sh /srv/crm/acme crm-acme            # back to the previous release
deploy/rollback.sh /srv/crm/acme crm-acme <folder>   # or to a named one
```

`release.sh` exports the commit (`RELEASE_REF`, default `origin/main`) into a new folder, links the shared `.env`, runs `npm ci`, the build and `doctor`, takes a backup, runs migrations, re-applies the blueprint (a no-op unless a newer version shipped, never overwriting client edits), switches `current` and restarts the service. If `/api/v1/health/ready` does not answer within 30 seconds it switches back to the previous release by itself and exits with an error.

A switch back does not undo migrations. Migrations only add tables and columns, so the older code keeps running; if a migration itself damaged data, restore the backup the release took (`deploy/restore.sh`).

**Moving an existing in-place instance to release folders (once):** stop the service; `mkdir -p /srv/crm/acme/releases`; move the checkout to `/srv/crm/acme/repo` and keep `.env` and `storage/` at the instance root (adjust `STORAGE_DIR`); update the systemd unit from `deploy/crm-api.service.example` (`WorkingDirectory=…/current/apps/api`) and run `systemctl daemon-reload`; then run `release.sh`.

## Processes, connections and health

- Run **one API process per instance** (the systemd unit does). Rate limits and the short-lived settings and permission caches live in process memory; a second process would count limits separately and see setting changes a few seconds late. `REDIS_URL` moves background jobs and scheduled work to Redis, not these.
- `DB_POOL_MAX` (default 10) sets database connections per process. Keep it below MySQL's `max_connections` together with everything else that connects.
- `/api/v1/health` answers while the process runs (for restarts). `/api/v1/health/ready` also checks the database, that `STORAGE_DIR` is writable and, with `REDIS_URL`, that Redis answers; it returns `{ status, database, storage, redis }` and 503 when something is down. Use it for uptime monitoring.
- Push notifications and installing the app need HTTPS (browsers refuse service workers on plain http, except localhost). The VAPID key pair is created on first use and kept encrypted (`crypto:rotate` re-encrypts it); push messages go out from the API to the browsers' push services over the internet. `sw.js` must be served with `no-cache`, as the nginx example does for everything outside `/assets/`.
- Settings → Email → **Send test email** (admins) checks the SMTP settings end to end.

## Backups

Schedule `deploy/backup.sh` nightly with the systemd timer in `deploy/crm-backup.service.example` and `deploy/crm-backup.timer.example` (`systemctl enable --now crm-backup-acme.timer`), and copy the backup folder off the server. Set `BACKUP_DIR` in `.env` to that folder and `npm run doctor` warns when the newest backup is more than 26 hours old.

- `mysqldump --single-transaction --routines --triggers <db>`: the triggers keep the audit log append-only after a restore.
- `STORAGE_DIR` (uploaded files). Files are stored under random keys and are only reachable through signed links.
- Set `BACKUP_ENCRYPTION_KEY_FILE` to encrypt both (required in practice for personal or health data). Keep the key away from the server: a backup without its key cannot be restored.

## Security checklist

- Production refuses to start with default or short secrets, and when `APP_URL`, `DATABASE_URL`, `SMTP_HOST`, `SMTP_PORT` or `MAIL_FROM` is missing or `APP_URL` points at localhost, so development defaults are never used by accident.
- A crash (uncaught error) is logged as fatal and the process exits, so systemd starts a clean one. Set `ERROR_WEBHOOK_URL` to receive a JSON report (`kind`, `at`, `app`, `error.name`, `error.message`, `error.stack`, no request data) for each crash and each unexpected server error.
- On stop, the API finishes open requests for up to 15 seconds, then closes them. Jobs left running by a stopped process are marked failed after an hour (and, without Redis, queued jobs after ten minutes) with "This stopped because the server restarted"; webhook deliveries whose first attempt was lost are retried.
- Job errors shown to people are plain messages; the details are in the server log.
- An `X-Request-Id` header is kept only when it is up to 64 plain characters; otherwise a new id is used.
- Cookies are `Secure` in production; serve over HTTPS only.
- Keep `CORS_ORIGINS` empty (same-origin deployment).
- Settings → Compliance sets the profile (Standard, Privacy, Health data) and its enforced minimums: 2FA, session limits, logging, retention and encryption.
- Privacy requests: Settings → Privacy (track requests, export a person's data, restrict, erase or permanently delete).
- For personal or health data, follow [compliance/operator-guide.md](compliance/operator-guide.md).

Before going live, work through the [production checklist](production-checklist.md).
