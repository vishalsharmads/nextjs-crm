/** Site-wide copy, navigation and placeholders. Replace PLACEHOLDER values before launch. */
export const site = {
  name: 'Bespoq',
  tagline: 'The CRM, tailored.',
  description:
    'Bespoq is a CRM configured around your industry: your words, your workflow and your data. Built for service businesses in the US and Australia, live in weeks without a custom build.',
  url: import.meta.env.SITE ?? 'https://bespoq.example',
  email: 'hello@bespoq.example',
  /** The demo app's sign-in page. Served at /app when the site and app share one server. */
  signInUrl: import.meta.env.PUBLIC_APP_URL ?? '/app',
  /** Where lead forms post. Set PUBLIC_LEAD_ENDPOINT to the CRM web form submit URL. */
  leadEndpoint: import.meta.env.PUBLIC_LEAD_ENDPOINT ?? '',
};

/** Live demo links per industry. PLACEHOLDER: add each industry as its demo instance goes live. */
export const demoLinks: Record<string, string> = { coworking: site.signInUrl };

export const nav = [
  { href: '/industries', label: 'Industries' },
  { href: '/features', label: 'Features' },
  { href: '/white-label', label: 'For agencies' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/resources', label: 'Resources' },
];

export const features = [
  {
    slug: 'pipelines',
    name: 'Pipelines in your words',
    short: 'Pipelines',
    body: 'Stages, fields and labels match how your industry actually works. A real estate agency sees Listings; a clinic sees Treatment plans.',
  },
  {
    slug: 'quotes-invoices',
    name: 'Quotes, invoices and payments',
    short: 'Quotes to cash',
    body: 'Quote from your price list, let clients accept online, convert to an invoice in one click and record payments as they arrive.',
  },
  {
    slug: 'client-portal',
    name: 'A portal for your clients',
    short: 'Client portal',
    body: 'Clients sign in with an email link to see quotes, invoices and documents, sign agreements, upload files and raise requests.',
  },
  {
    slug: 'bookings',
    name: 'Bookings without clashes',
    short: 'Bookings',
    body: 'Rooms, crews, chairs and equipment booked on a day board that refuses double bookings and respects opening hours.',
  },
  {
    slug: 'documents',
    name: 'Documents and e-signatures',
    short: 'Documents',
    body: 'Letters and agreements generated from templates, signed online, plus document checklists clients complete themselves.',
  },
  {
    slug: 'support',
    name: 'A support desk built in',
    short: 'Tickets',
    body: 'Client requests with priorities and response targets, internal notes and replies the client sees in their portal.',
  },
  {
    slug: 'automations',
    name: 'Automations and integrations',
    short: 'Automations',
    body: 'When a quote is accepted, mark the deal won, create the task and send the email. Webhooks and a full API connect the rest.',
  },
  {
    slug: 'security',
    name: 'Your data, on your terms',
    short: 'Data ownership',
    body: 'Every business gets its own instance and database, role-based access, two-factor sign-in and an audit log nobody can edit.',
  },
];

/** Shown on the home page and pricing. Proof is placeholder until real customers are published. */
export const placeholderStats = [
  { value: '3 weeks', label: 'typical time to go live', placeholder: true },
  { value: '9', label: 'industry templates ready', placeholder: false },
  { value: '0', label: 'per-seat licence fees', placeholder: false },
];

export const homeFaq = [
  {
    q: 'What is Bespoq?',
    a: 'Bespoq is a CRM that is configured for your industry before you start: your terms for clients and work, your pipeline stages, your fields and the modules you need, from quotes and invoices to bookings and a client portal.',
  },
  {
    q: 'How is Bespoq different from Salesforce or HubSpot?',
    a: 'Those are general platforms you shape yourself, usually with consultants and per-seat pricing. Bespoq starts from a template for your industry, runs as your own instance with your own database, and has no per-seat licence fees.',
  },
  {
    q: 'How is it different from a custom-built CRM?',
    a: 'A custom build takes months and you maintain it forever. Bespoq gives you the same fit through configuration, so you go live in weeks and still get every product update.',
  },
  {
    q: 'Who owns our data?',
    a: 'You do. Each business gets its own instance and database, hosted where you choose. You can export everything at any time.',
  },
  {
    q: 'How long does setup take?',
    a: 'Most businesses go live in two to four weeks: one week to configure the template, then importing data and training the team.',
  },
  {
    q: 'Can agencies resell Bespoq under their own brand?',
    a: 'Yes. Every instance is fully white-label: your client sees their own name, logo, colors and domain, never ours.',
  },
  {
    q: 'What does it cost?',
    a: 'Pricing depends on hosting, the modules you need and how much setup help you want. There are no per-seat fees. Book a call and we will give you a fixed quote.',
  },
];
