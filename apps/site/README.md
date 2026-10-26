# Bespoq marketing site

The public website for Bespoq: home page, nine industry landing pages, features, agencies, pricing,
demo booking, the admin cost calculator and guides. Static HTML built with Astro, animated with GSAP.

It is independent of the CRM app (`apps/web`, `apps/api`): it shares no code or styles with the
white-label product, and the product never shows the Bespoq name.

## Run

```bash
npm run dev:site      # http://localhost:4321 (and your LAN IP), live reload
npm run build:site    # static output in apps/site/dist
npm run typecheck -w @app/site
```

## Configure

| Variable               | Purpose                                                                                                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SITE_URL`             | Public URL, used for canonical links, sitemap, Open Graph and `llms.txt` (default `https://bespoq.example`)                                                                                     |
| `PUBLIC_LEAD_ENDPOINT` | Where lead forms post: the CRM's public web form submit URL, e.g. `https://crm.bespoq.example/api/v1/public/forms/<form-uuid>/submit`. Unset: forms show success but send nothing (placeholder) |
| `PUBLIC_APP_URL`       | The demo app's sign-in page, linked from "Sign in" and the coworking demo (default `/app`, the single-server setup)                                                                             |

In the CRM web form, map `firstName`, `lastName`, `email`, `companyName` and the custom fields
`cf.industry`, `cf.team_size`, `cf.message`, `cf.source`. When the site is served by the demo app's server
(single-server setup) the endpoint is same-origin (`/api/v1/public/forms/<form-uuid>/submit`) and needs no CORS;
otherwise add the site's origin to the API's `CORS_ORIGINS`.

Pages run under a strict CSP (`script-src 'self'`), so every script is a file: no inline `<script>` code
(`vite.build.assetsInlineLimit: 0` in `astro.config.mjs`; the motion flag is `public/motion-flag.js`).

## Edit content

- Industries (pages, hero tape, tables, `llms.txt`): `src/data/industries.ts`
- Features, home FAQ, nav, placeholders: `src/data/site.ts`
- Live demo links per industry (coworking points at the demo app; add others as they go live): `demoLinks` in `src/data/site.ts`
- Guides: `src/data/articles.ts`

Placeholders to replace before launch: testimonials and logos (`src/components/Proof.astro`), the
"three weeks" figure, demo links, office details, privacy and terms text, and `site.email`.

## Deploy

Either serve `dist/` as static files from nginx on the marketing domain (`try_files $uri $uri.html $uri/ =404;`),
or let the demo app's server serve it at `/` with the app at `/app` (`npm run build:single` and
`npm run start:single`; see `docs/deploy-single-server.md`).

## Remove

Delete `apps/site`, the `dev:site` / `build:site` scripts in the root `package.json`, and its nginx site.
In the single-server setup, also drop the site step from `build:single` and `SITE_DIR` from `start:single`.
Nothing else depends on it.
