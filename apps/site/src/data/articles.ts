/** Resource articles. Answer-first, question-led sections for search and answer engines. */
export interface Article {
  slug: string;
  title: string;
  description: string;
  date: string;
  /** 40–60-word direct answer shown first. */
  answer: string;
  sections: { heading: string; body: string[] }[];
}

export const articles: Article[] = [
  {
    slug: 'how-to-choose-a-crm-for-a-service-business',
    title: 'How to choose a CRM for a service business',
    description:
      'A practical checklist for choosing a CRM when you sell services, not products: vocabulary, workflow, documents, client access, data ownership and total cost.',
    date: '2026-10-01',
    answer:
      'Choose a CRM that already speaks your industry’s language, runs your real workflow from enquiry to invoice, lets clients sign and upload documents themselves, keeps your data in a database you control, and has a predictable total cost. Test it with your own stages and documents before you commit.',
    sections: [
      {
        heading: 'Does it use your words?',
        body: [
          'If your team says “patients”, “matters” or “listings”, a CRM that insists on “contacts” and “opportunities” adds friction to every click. Adoption is the biggest predictor of CRM success, and vocabulary is the cheapest win.',
          'Ask the vendor to rename the core records and pipeline stages during the demo. If that needs a consultant, expect the same cost every time your process changes.',
        ],
      },
      {
        heading: 'Does it cover the whole job, or just sales?',
        body: [
          'Service businesses rarely stop at “deal won”. You still quote, schedule, collect documents, sign agreements, invoice and support the client. Every handover to another tool is a place where details get re-typed or lost.',
          'List your steps from first enquiry to final invoice and check each one off in the demo.',
        ],
      },
      {
        heading: 'Can your clients help themselves?',
        body: [
          'A client portal where people accept quotes, sign documents, upload files and raise requests removes most of the chasing that eats admin time.',
        ],
      },
      {
        heading: 'Who owns the data?',
        body: [
          'Find out where data is stored, whether it shares a database with other customers, and how you export everything if you leave. For regulated work, ask for an audit log that cannot be edited.',
        ],
      },
      {
        heading: 'What will it really cost?',
        body: [
          'Add up licences per seat, add-ons for quotes, portals or e-signature, consultant time to configure it, and the cost of changes later. A fixed price with no per-seat fees is easier to plan for as you hire.',
        ],
      },
    ],
  },
  {
    slug: 'generic-vs-custom-vs-configured-crm',
    title: 'Generic CRM, custom build or configured CRM: which is right?',
    description:
      'The trade-offs between an off-the-shelf CRM, a custom-built CRM and a CRM configured for your industry, in time, cost, fit and long-term upkeep.',
    date: '2026-10-08',
    answer:
      'A generic CRM is fast to start but rarely fits a specialist workflow. A custom build fits perfectly but takes months and needs ongoing development. A configured CRM such as Bespoq starts from an industry template and is tailored without new code, so it fits in weeks and still receives product updates.',
    sections: [
      {
        heading: 'When does a generic CRM make sense?',
        body: [
          'If your process looks like classic B2B sales and your team is happy with standard terms, a mainstream CRM is a reasonable start. The cost shows up later, in workarounds and per-seat licences as you grow.',
        ],
      },
      {
        heading: 'When is a custom build worth it?',
        body: [
          'When your workflow is truly unique and is your competitive advantage, and you can fund a development team to maintain it for years. Most service businesses find their process is specialised, but not unique.',
        ],
      },
      {
        heading: 'What a configured CRM changes',
        body: [
          'Configuration covers vocabulary, stages, fields, roles, documents and modules. Because nothing is forked, updates and security fixes keep arriving. Industry-specific features ship as modules that sit alongside the core product.',
        ],
      },
    ],
  },
  {
    slug: 'why-crm-data-ownership-matters',
    title: 'Why owning your CRM data matters',
    description:
      'What “owning your data” means for a CRM: your own database, where it is hosted, exports, audit trails and what happens if you change vendor.',
    date: '2026-10-15',
    answer:
      'Owning your CRM data means it sits in a database dedicated to your business, hosted where you choose, exportable in full at any time, and protected by access controls and an audit log you can rely on. It reduces vendor lock-in and makes privacy obligations easier to meet.',
    sections: [
      {
        heading: 'Shared cloud or your own database?',
        body: [
          'Most CRMs store every customer’s records in one shared system, separated by software rules. A dedicated instance gives your business its own database, which simplifies questions about where data lives and who can reach it.',
        ],
      },
      {
        heading: 'Can you leave with everything?',
        body: [
          'Check that you can export records, custom fields, files and history, not just a contact list. A CRM you cannot leave is a CRM you cannot negotiate with.',
        ],
      },
      {
        heading: 'Can you prove who changed what?',
        body: [
          'An append-only audit log records every create, change and delete, and cannot be edited even by administrators. For advisers, clinics and law firms, that is often a compliance requirement rather than a nice-to-have.',
        ],
      },
    ],
  },
];
