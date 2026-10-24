# Single-server setup (website + demo app on one port)

For a demo server or a shared-hosting account without nginx, one Node process serves everything:

| Path   | Serves                                          |
| ------ | ----------------------------------------------- |
| `/`    | The marketing site (`apps/site/dist`)           |
| `/app` | The CRM app (`apps/web/dist`, built for `/app`) |
| `/api` | The API, unchanged                              |

Client instances do **not** use this: they keep the app at their own domain root behind nginx
([deployment.md](deployment.md)). The mode is off unless `WEB_DIR` / `SITE_DIR` are set.

## Requirements on the host

Check these before relying on a host; `npm run doctor` checks the database ones on the server.

- **Node 22+** and a process that stays running (cPanel "Setup Node.js App" / Passenger works).
- **MySQL 8.4+** (not MariaDB), with the `TRIGGER` privilege. With binary logging on, also
  `log_bin_trust_function_creators=1`. The audit log is append-only through triggers, so installs
  fail without them. Shared hosts often refuse both; ask support before buying.
- **One database per live demo.** Each instance is one industry; a second industry needs a second
  database and a second app process (its own port or subdomain).

## Build

On your machine or the host:

```
npm ci
npm run build:single      # app built for /app, API bundle, marketing site
```

`build:single` sets `APP_BASE_PATH=/app` for the app build. Set `SITE_URL=https://yourdomain.com` too,
so the site's canonical links and sitemap use the real domain.

## Configure

In the host's environment settings (or `.env` in the repo root):

```
NODE_ENV=production
PORT=3000                             # or the port the host assigns
APP_URL=https://yourdomain.com/app    # its path must match APP_BASE_PATH
WEB_DIR=../web/dist                   # relative to apps/api
SITE_DIR=../site/dist
DATABASE_URL=mysql://user:pass@host:3306/dbname
DEMO_MODE=true                        # demo server only, never a client instance
# plus the secrets from env-reference.md
```

`npm run start:single` sets `WEB_DIR` and `SITE_DIR` for you. On Passenger, set the application root to
`apps/api`, the startup file to `dist/server.js`, and the variables above in the panel.

## Install the demo

```
DATABASE_URL=... deploy/setup-demo.sh coworking
```

This installs the industry template with sample data and one demo user per role (password
`DemoAccess2026!` unless `ADMIN_PASSWORD` is set). With `DEMO_MODE=true` the sign-in screen lists them.

## Start and check

```
npm run start:single
```

- `https://yourdomain.com/` shows the website; "Sign in" opens `/app`.
- `https://yourdomain.com/app` shows the sign-in screen with the demo accounts.
- `https://yourdomain.com/api/v1/health/ready` answers `{"status":"ok","database":"ok"}`.

Lead forms on the site can post to a web form on this same app
(`PUBLIC_LEAD_ENDPOINT=/api/v1/public/forms/<form-uuid>/submit` at site build time); no CORS needed.

## Security

The server sends the same page security policy as the nginx example (CSP `default-src 'self'`).
Serve over HTTPS (the host's TLS); secure cookies are on in production.
