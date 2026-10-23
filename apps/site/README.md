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

In the CRM web form, map `firstName`, `lastName`, `email`, `companyName` and the custom fields
`cf.industry`, `cf.team_size`, `cf.message`, `cf.source`. Add the site's origin to the API's `CORS_ORIGINS`.

## Edit content

- Industries (pages, hero tape, tables, `llms.txt`): `src/data/industries.ts`
- Features, home FAQ, nav, placeholders: `src/data/site.ts`
- Live demo links per industry (placeholder, empty): `demoLinks` in `src/data/site.ts`
- Guides: `src/data/articles.ts`

Placeholders to replace before launch: testimonials and logos (`src/components/Proof.astro`), the
"three weeks" figure, demo links, office details, privacy and terms text, and `site.email`.

## Deploy

Serve `dist/` as static files from nginx on the marketing domain (`try_files $uri $uri.html $uri/ =404;`).

## Remove

Delete `apps/site`, the `dev:site` / `build:site` scripts in the root `package.json`, and its nginx site.
Nothing else depends on it.
