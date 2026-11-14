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

```bash
BLUEPRINT=coworking deploy/release.sh /srv/crm/acme crm-acme
```

This checks out the release, builds, runs `doctor` and migrations, re-applies the blueprint (a no-op unless a newer version shipped, and never overwriting client edits), restarts the service and checks `/api/v1/health`.

## Backups

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
