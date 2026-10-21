# Deploying an instance

Each client gets their own instance: a directory (or server), a MySQL database, an `.env`, a systemd unit and an nginx server block. No containers are used.

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
2. Copy `deploy/nginx.conf.example` to a server block, set `server_name` and certificates, reload nginx.
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

## Security checklist

- Production refuses to start with default or short secrets.
- Cookies are `Secure` in production; serve over HTTPS only.
- Keep `CORS_ORIGINS` empty (same-origin deployment).
- Admins can require two-factor authentication for all admins (Settings → Security).
- Privacy requests: Settings → Privacy (anonymize, or permanently delete with a confirmation code).
