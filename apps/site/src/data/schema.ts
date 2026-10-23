/** JSON-LD builders (schema.org) for search engines and answer engines. */
import { site } from './site';

const abs = (path: string) => new URL(path, site.url).toString();

export const faqSchema = (items: { q: string; a: string }[]) => ({
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: items.map((f) => ({
    '@type': 'Question',
    name: f.q,
    acceptedAnswer: { '@type': 'Answer', text: f.a },
  })),
});

export const breadcrumbSchema = (trail: { name: string; path: string }[]) => ({
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: trail.map((t, n) => ({
    '@type': 'ListItem',
    position: n + 1,
    name: t.name,
    item: abs(t.path),
  })),
});

export const softwareSchema = (opts: { name?: string; description: string; audience?: string }) => ({
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: opts.name ?? site.name,
  applicationCategory: 'BusinessApplication',
  applicationSubCategory: 'CRM',
  operatingSystem: 'Web',
  description: opts.description,
  ...(opts.audience ? { audience: { '@type': 'BusinessAudience', name: opts.audience } } : {}),
  offers: {
    '@type': 'Offer',
    availability: 'https://schema.org/InStock',
    priceSpecification: {
      '@type': 'PriceSpecification',
      priceCurrency: 'USD',
      description: 'Fixed quote, no per-seat fees',
    },
  },
});

export const howToSchema = (name: string, steps: string[]) => ({
  '@context': 'https://schema.org',
  '@type': 'HowTo',
  name,
  step: steps.map((s, n) => ({ '@type': 'HowToStep', position: n + 1, name: s })),
});

export const articleSchema = (a: { title: string; description: string; path: string; date: string }) => ({
  '@context': 'https://schema.org',
  '@type': 'Article',
  headline: a.title,
  description: a.description,
  datePublished: a.date,
  mainEntityOfPage: abs(a.path),
  author: { '@type': 'Organization', name: site.name },
  publisher: { '@type': 'Organization', name: site.name },
});
