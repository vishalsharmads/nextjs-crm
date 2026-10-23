/**
 * Every industry page, the hero "tape" and the industries table are generated from this file.
 * The vocabulary and stages mirror what an industry template configures in the product.
 */

export interface Industry {
  slug: string;
  name: string;
  /** Short label for the measuring tape. */
  short: string;
  /** What this industry calls the people it serves, and the work it wins. */
  vocab: { contact: string; contacts: string; deal: string; deals: string; company: string };
  stages: string[];
  /** 40–60 words that answer "what is a CRM for <industry>" directly (AEO). */
  answer: string;
  metaTitle: string;
  metaDescription: string;
  pains: { title: string; body: string }[];
  modules: { name: string; use: string }[];
  day: { time: string; what: string }[];
  faq: { q: string; a: string }[];
  /** Sample records for the live mockup, by stage index. */
  cards: { name: string; detail: string; stage: number }[];
}

export const industries: Industry[] = [
  {
    slug: 'real-estate',
    name: 'Real estate',
    short: 'Real estate',
    vocab: { contact: 'Buyer', contacts: 'Buyers', deal: 'Listing', deals: 'Listings', company: 'Agency' },
    stages: ['Appraisal', 'Listed', 'Open homes', 'Under offer', 'Settled'],
    answer:
      'Bespoq is a CRM for real estate agencies that tracks every buyer, vendor and listing from appraisal to settlement. Agents get a listings board in their own terms, open-home check-ins, offer tracking, vendor reports in a client portal, and commission invoices, without paying for a custom build.',
    metaTitle: 'CRM for real estate agencies | Bespoq',
    metaDescription:
      'A real estate CRM that runs appraisals, listings, open homes, offers and settlements in your agency’s own terms. US and Australia.',
    pains: [
      {
        title: 'Leads die between open homes',
        body: 'Buyer details sit on sign-in sheets and phones. By Monday nobody remembers who wanted a second look.',
      },
      {
        title: 'Vendors chase you for updates',
        body: 'Every vendor wants weekly numbers. Building that report by hand eats an afternoon per listing.',
      },
      {
        title: 'Generic CRMs speak sales, not property',
        body: 'You sell homes, not “opportunities”. Software that fights your vocabulary never gets used.',
      },
    ],
    modules: [
      { name: 'Listings pipeline', use: 'Appraisal to settled, with days-on-market per stage' },
      { name: 'Bookings', use: 'Open homes and private inspections with buyer check-in' },
      { name: 'Client portal', use: 'Vendors see enquiries, inspections and offers live' },
      { name: 'Documents', use: 'Agency agreements generated and e-signed' },
      { name: 'Invoices', use: 'Commission and marketing invoices with payment tracking' },
    ],
    day: [
      {
        time: '8:30',
        what: 'The dashboard shows two listings stuck in “Under offer” for 10 days. One call each.',
      },
      {
        time: '11:00',
        what: 'Saturday’s open home: 14 buyers checked in on a tablet, each tagged to the listing.',
      },
      {
        time: '14:00',
        what: 'An automation sends every attendee the contract-of-sale pack and books follow-up calls.',
      },
      {
        time: '17:00',
        what: 'The vendor opens their portal and sees inspections, feedback and the two offers.',
      },
    ],
    faq: [
      {
        q: 'Can buyers and vendors be tracked separately?',
        a: 'Yes. Both are people records with a role, so one person can be a buyer today and a vendor next year without duplicates.',
      },
      {
        q: 'Does it handle open-home sign-ins?',
        a: 'Yes. The bookings and front-desk tools check visitors in against a listing and turn them into buyer records automatically.',
      },
      {
        q: 'Can vendors see progress without calling us?',
        a: 'Yes. Share a listing to the client portal and the vendor sees inspections, enquiries and offers as they happen.',
      },
    ],
    cards: [
      { name: '14 Wattle Cres', detail: 'Appraisal booked Thu', stage: 0 },
      { name: '3/88 Harbour Rd', detail: '$1.24M guide', stage: 1 },
      { name: '7 Elm Street', detail: '22 inspections', stage: 2 },
      { name: '201 Bay Pde', detail: '2 offers', stage: 3 },
      { name: '5 Oak Lane', detail: 'Settles 14 Nov', stage: 4 },
    ],
  },
  {
    slug: 'healthcare-clinics',
    name: 'Healthcare clinics',
    short: 'Clinics',
    vocab: {
      contact: 'Patient',
      contacts: 'Patients',
      deal: 'Treatment plan',
      deals: 'Treatment plans',
      company: 'Referrer',
    },
    stages: ['Enquiry', 'Consult booked', 'Plan proposed', 'In treatment', 'Completed'],
    answer:
      'Bespoq is a CRM for private clinics, from dental and physio to cosmetic practices, that follows each patient from first enquiry to completed treatment. It tracks referrals, consult bookings, treatment-plan quotes, consent forms and follow-ups, and keeps patient data on your own server rather than a shared cloud.',
    metaTitle: 'CRM for private clinics and practices | Bespoq',
    metaDescription:
      'A clinic CRM for enquiries, consults, treatment plans, consent forms and recalls. Patient data stays on your own server. US and Australia.',
    pains: [
      {
        title: 'Enquiries never become consults',
        body: 'Web and phone enquiries land in different inboxes. Half are never called back the same day.',
      },
      {
        title: 'Treatment plans stall after the quote',
        body: 'Patients take the plan home to “think about it”, and nobody follows up.',
      },
      {
        title: 'Paper consent and intake forms',
        body: 'Staff retype forms, chase signatures and scan PDFs into a shared drive.',
      },
    ],
    modules: [
      { name: 'Patient pipeline', use: 'Enquiry to completed treatment, by practitioner' },
      { name: 'Bookings', use: 'Consult rooms and chairs with clash-free scheduling' },
      { name: 'Quotes', use: 'Itemised treatment plans patients accept online' },
      { name: 'Documents', use: 'Intake and consent forms collected through the portal' },
      { name: 'Automations', use: 'Recall and post-treatment follow-ups on schedule' },
    ],
    day: [
      {
        time: '8:00',
        what: 'Overnight web-form enquiries are already patients, assigned to the front desk.',
      },
      {
        time: '10:30',
        what: 'A consult ends; the practitioner sends a treatment-plan quote from the record.',
      },
      { time: '15:00', what: 'The patient accepts the plan and signs consent in the portal on their phone.' },
      { time: 'Every week', what: 'Plans quoted but not accepted after 7 days get a gentle follow-up task.' },
    ],
    faq: [
      {
        q: 'Is this a practice-management or clinical records system?',
        a: 'No. Bespoq handles enquiries, bookings, plans, forms and follow-ups. Clinical notes stay in your clinical system.',
      },
      {
        q: 'Where is patient data stored?',
        a: 'Each clinic gets its own instance and database, hosted where you choose, so data never shares a system with other businesses.',
      },
      {
        q: 'Can patients sign consent forms online?',
        a: 'Yes. Generate the form from a template, share it to the client portal, and the patient signs by typing their name.',
      },
    ],
    cards: [
      { name: 'Maya Chen', detail: 'Web enquiry, implants', stage: 0 },
      { name: 'Tom Riley', detail: 'Consult Tue 10:30', stage: 1 },
      { name: 'Ana Ruiz', detail: '$4,800 plan', stage: 2 },
      { name: 'Sam Patel', detail: 'Session 3 of 6', stage: 3 },
      { name: 'Lee Park', detail: 'Recall in 6 months', stage: 4 },
    ],
  },
  {
    slug: 'law-firms',
    name: 'Law firms',
    short: 'Law firms',
    vocab: { contact: 'Client', contacts: 'Clients', deal: 'Matter', deals: 'Matters', company: 'Company' },
    stages: ['Intake', 'Conflict check', 'Engaged', 'In progress', 'Closed'],
    answer:
      'Bespoq is a CRM for law firms that manages client intake, conflict checks, engagement letters and matters in one place. Firms track every enquiry to a signed engagement, collect documents through a secure client portal, issue fee estimates and invoices, and see which matters need attention.',
    metaTitle: 'Legal CRM for law firms and practices | Bespoq',
    metaDescription:
      'A law firm CRM for intake, conflict checks, engagement letters, matters, client portals and fee estimates. US and Australia.',
    pains: [
      {
        title: 'Intake lives in email',
        body: 'New enquiries arrive by phone, email and web form, and nobody owns them until a partner asks.',
      },
      {
        title: 'Chasing clients for documents',
        body: 'Paralegals spend hours asking for IDs and statements, then filing attachments by hand.',
      },
      {
        title: 'Engagement letters are copy-paste',
        body: 'Every letter starts from an old Word file, with old client names still in it.',
      },
    ],
    modules: [
      { name: 'Matters pipeline', use: 'Intake to closed, with owner and practice area' },
      { name: 'Documents', use: 'Engagement letters from templates, signed online' },
      { name: 'File requests', use: 'IDs and evidence uploaded by clients in the portal' },
      { name: 'Quotes and invoices', use: 'Fee estimates, retainers and payments' },
      { name: 'Tickets', use: 'Client questions handled with response targets' },
    ],
    day: [
      { time: '9:00', what: 'Three web enquiries are in Intake. One is flagged for a conflict check.' },
      {
        time: '11:00',
        what: 'The engagement letter is generated with the client’s details and sent for signature.',
      },
      {
        time: '13:30',
        what: 'The client uploads their ID and documents to the portal; the paralegal approves them.',
      },
      { time: '16:00', what: 'A fee estimate goes out as a quote and converts to an invoice when accepted.' },
    ],
    faq: [
      {
        q: 'Does Bespoq replace our practice-management software?',
        a: 'It covers intake, client communication, documents and billing workflows. Many firms run it alongside a trust-accounting system.',
      },
      {
        q: 'Can clients upload documents securely?',
        a: 'Yes. You request specific files; clients upload them through their own portal sign-in, and you approve or reject each one.',
      },
      {
        q: 'Who can see a matter?',
        a: 'Access is set by role and by ownership, so a lawyer can be limited to their own matters while partners see everything.',
      },
    ],
    cards: [
      { name: 'Hughes v. Marlow', detail: 'Web enquiry', stage: 0 },
      { name: 'Okafor estate', detail: 'Check pending', stage: 1 },
      { name: 'Brandt lease', detail: 'Letter signed', stage: 2 },
      { name: 'Tanaka visa appeal', detail: 'Hearing 3 Dec', stage: 3 },
      { name: 'Silva purchase', detail: 'Billed in full', stage: 4 },
    ],
  },
  {
    slug: 'financial-advisers',
    name: 'Financial advisers and mortgage brokers',
    short: 'Advisers & brokers',
    vocab: {
      contact: 'Client',
      contacts: 'Clients',
      deal: 'Application',
      deals: 'Applications',
      company: 'Lender',
    },
    stages: ['Discovery', 'Fact find', 'Recommendation', 'Lodged', 'Settled'],
    answer:
      'Bespoq is a CRM for financial advisers and mortgage brokers that runs the client journey from discovery meeting to settlement and annual review. It collects fact-find documents through a secure portal, tracks applications by lender and stage, produces fee quotes and keeps an audit trail of every change for compliance.',
    metaTitle: 'CRM for financial advisers and mortgage brokers | Bespoq',
    metaDescription:
      'An adviser and broker CRM for fact finds, document collection, applications, settlements, reviews and a full audit trail.',
    pains: [
      {
        title: 'Fact finds take weeks',
        body: 'Payslips, statements and IDs trickle in over email, and someone has to track what is still missing.',
      },
      {
        title: 'Reviews slip through the cracks',
        body: 'Annual reviews and rate check-ins are a spreadsheet nobody trusts.',
      },
      {
        title: 'Compliance wants a paper trail',
        body: 'Who changed what, and when? Most CRMs cannot answer that properly.',
      },
    ],
    modules: [
      { name: 'Applications pipeline', use: 'Discovery to settled, by lender and value' },
      { name: 'File requests', use: 'A document checklist clients complete in the portal' },
      { name: 'Automations', use: 'Review reminders and settlement anniversaries' },
      { name: 'Audit log', use: 'An append-only record of every change' },
      { name: 'Quotes', use: 'Advice fees accepted online' },
    ],
    day: [
      {
        time: '9:00',
        what: 'A new client finishes the online fact find; the checklist shows 2 documents missing.',
      },
      {
        time: '12:00',
        what: 'The client uploads the last payslip from their phone. The application moves to Recommendation.',
      },
      {
        time: '15:00',
        what: 'The application is lodged; the lender and expected settlement date are tracked on the record.',
      },
      {
        time: 'In 12 months',
        what: 'An automation creates the annual review task and emails the client to book in.',
      },
    ],
    faq: [
      {
        q: 'Is there an audit trail for compliance?',
        a: 'Yes. Every create, change and delete is written to an append-only audit log that cannot be edited, even by administrators.',
      },
      {
        q: 'Can clients send documents securely?',
        a: 'Yes. Send a file request; clients upload through the client portal and you approve each document.',
      },
      {
        q: 'Does it integrate with aggregator or lender systems?',
        a: 'Bespoq has a full REST API and webhooks, so integrations can be built for your aggregator. Ask us about your stack.',
      },
    ],
    cards: [
      { name: 'Rossi family', detail: 'First home, $780k', stage: 0 },
      { name: 'J. Kim', detail: '2 docs missing', stage: 1 },
      { name: 'Novak refinance', detail: 'Rate 5.89%', stage: 2 },
      { name: 'Haddad SMSF', detail: 'Lodged Mon', stage: 3 },
      { name: 'Brown investment', detail: 'Review due Mar', stage: 4 },
    ],
  },
  {
    slug: 'construction-trades',
    name: 'Construction and trades',
    short: 'Construction & trades',
    vocab: { contact: 'Customer', contacts: 'Customers', deal: 'Job', deals: 'Jobs', company: 'Builder' },
    stages: ['Enquiry', 'Site visit', 'Quoted', 'Scheduled', 'Invoiced'],
    answer:
      'Bespoq is a CRM for builders and trade businesses that takes every job from enquiry to site visit, quote, schedule and invoice. Teams quote from a product price list, win jobs with online acceptance, book crews and equipment without clashes, and chase overdue invoices automatically.',
    metaTitle: 'CRM for builders and trade businesses | Bespoq',
    metaDescription:
      'A trades and construction CRM for enquiries, site visits, quotes from your price list, crew scheduling, equipment and invoicing.',
    pains: [
      {
        title: 'Quotes are slow and inconsistent',
        body: 'Every estimator prices differently, and quotes go out days after the site visit.',
      },
      {
        title: 'Double-booked crews and gear',
        body: 'The whiteboard says one thing, the group chat says another.',
      },
      {
        title: 'Cash stuck in unpaid invoices',
        body: 'Nobody notices an invoice is 30 days overdue until the accountant asks.',
      },
    ],
    modules: [
      { name: 'Jobs pipeline', use: 'Enquiry to invoiced, with job value by stage' },
      { name: 'Products and quotes', use: 'Consistent pricing from one price list' },
      { name: 'Bookings', use: 'Crews, vehicles and equipment scheduled without clashes' },
      { name: 'Inventory', use: 'Tools lent to crews and consumables restocked' },
      { name: 'Invoices', use: 'Progress invoices, payments and overdue alerts' },
    ],
    day: [
      { time: '7:00', what: 'The day board shows both crews and the excavator booked across three sites.' },
      {
        time: '10:00',
        what: 'After a site visit, the estimator builds a quote from the price list on a tablet.',
      },
      { time: '13:00', what: 'The customer accepts online; the job converts to an invoice schedule.' },
      { time: '17:00', what: 'Two invoices pass their due date; the owner gets an overdue alert.' },
    ],
    faq: [
      {
        q: 'Can we quote from our own price list?',
        a: 'Yes. Add products and services with prices and tax, then build quotes from them so pricing stays consistent.',
      },
      {
        q: 'Does it schedule crews and equipment?',
        a: 'Yes. Bookings treat crews, vehicles and machines as resources and refuse double bookings.',
      },
      {
        q: 'Can we track tools lent to staff?',
        a: 'Yes. The inventory module records who has each asset, when it is due back, and its full history.',
      },
    ],
    cards: [
      { name: 'Deck rebuild', detail: 'Phone enquiry', stage: 0 },
      { name: 'Kitchen, Lee St', detail: 'Visit Wed 2pm', stage: 1 },
      { name: 'Roof restoration', detail: '$18,400 quote', stage: 2 },
      { name: 'Bathroom reno', detail: 'Crew B, Mon', stage: 3 },
      { name: 'Retaining wall', detail: '50% paid', stage: 4 },
    ],
  },
  {
    slug: 'education-training',
    name: 'Education and training',
    short: 'Education',
    vocab: {
      contact: 'Student',
      contacts: 'Students',
      deal: 'Enrolment',
      deals: 'Enrolments',
      company: 'Agent',
    },
    stages: ['Enquiry', 'Applied', 'Offer sent', 'Enrolled', 'Completed'],
    answer:
      'Bespoq is a CRM for colleges, training providers and tutoring businesses that manages student enquiries, applications, offers and enrolments. It collects application documents through a student portal, tracks agents and referrers, issues offer letters and fee invoices, and handles student questions with a support desk.',
    metaTitle: 'CRM for colleges and training providers | Bespoq',
    metaDescription:
      'An education CRM for enquiries, applications, offer letters, enrolments, agent tracking and student support. US and Australia.',
    pains: [
      {
        title: 'Applications arrive incomplete',
        body: 'Transcripts and IDs are missing, and admissions staff chase them one email at a time.',
      },
      {
        title: 'Agents send students you cannot track',
        body: 'Commission disputes start because nobody recorded who referred whom.',
      },
      {
        title: 'Student questions get lost',
        body: 'The same question goes to three inboxes and gets three different answers.',
      },
    ],
    modules: [
      { name: 'Enrolments pipeline', use: 'Enquiry to completed, by course and intake' },
      { name: 'File requests', use: 'Transcripts and IDs uploaded by applicants' },
      { name: 'Documents', use: 'Offer letters generated and accepted online' },
      { name: 'Invoices', use: 'Tuition fees and payment plans' },
      { name: 'Tickets', use: 'A student support desk with response targets' },
    ],
    day: [
      { time: '9:00', what: 'The intake dashboard shows 40 applications; 6 are waiting on documents.' },
      {
        time: '11:00',
        what: 'Admissions approves uploaded transcripts and generates offer letters in bulk.',
      },
      { time: '14:00', what: 'Students sign their offers in the portal; fee invoices go out automatically.' },
      {
        time: '16:00',
        what: 'A student asks about their timetable through the portal; it is answered within the hour.',
      },
    ],
    faq: [
      {
        q: 'Can we track education agents?',
        a: 'Yes. Agents are organizations linked to each student, so referrals and commissions are clear.',
      },
      {
        q: 'Can applicants upload documents?',
        a: 'Yes. Send a checklist; applicants upload each document in their portal and you approve or reject them.',
      },
      {
        q: 'Does it replace our student management system?',
        a: 'Bespoq covers recruitment, admissions and support. Academic records stay in your SMS, connected through the API if needed.',
      },
    ],
    cards: [
      { name: 'Priya S.', detail: 'Diploma of IT', stage: 0 },
      { name: 'Jun Wei', detail: 'Transcript pending', stage: 1 },
      { name: 'Fatima K.', detail: 'Offer sent Mon', stage: 2 },
      { name: 'Omar H.', detail: 'Feb intake', stage: 3 },
      { name: 'Ada N.', detail: 'Graduated', stage: 4 },
    ],
  },
  {
    slug: 'recruitment-staffing',
    name: 'Recruitment and staffing',
    short: 'Recruitment',
    vocab: {
      contact: 'Candidate',
      contacts: 'Candidates',
      deal: 'Placement',
      deals: 'Placements',
      company: 'Client',
    },
    stages: ['Sourced', 'Screened', 'Submitted', 'Interview', 'Placed'],
    answer:
      'Bespoq is a CRM for recruitment and staffing agencies that tracks candidates, client companies and placements in one system. Recruiters move candidates through screening, submission and interview stages, collect right-to-work documents through a portal, and invoice placement fees when a candidate starts.',
    metaTitle: 'Recruitment CRM for agencies | Bespoq',
    metaDescription:
      'A recruitment CRM for candidates, clients, placements, right-to-work documents and placement-fee invoicing. US and Australia.',
    pains: [
      {
        title: 'Two systems for one job',
        body: 'Candidates live in an ATS, clients in a CRM, and placements in a spreadsheet.',
      },
      {
        title: 'Compliance documents everywhere',
        body: 'Right-to-work checks and certificates are scattered across email.',
      },
      {
        title: 'Fees invoiced late',
        body: 'Placement fees go out weeks after the start date, or not at all.',
      },
    ],
    modules: [
      { name: 'Placements pipeline', use: 'Sourced to placed, per client role' },
      { name: 'File requests', use: 'Right-to-work and certificates via the portal' },
      { name: 'Quotes and invoices', use: 'Placement fees and payment tracking' },
      { name: 'Contracts', use: 'Temp and contract terms with renewal reminders' },
      { name: 'Automations', use: 'Interview reminders and start-date follow-ups' },
    ],
    day: [
      { time: '8:30', what: 'Five candidates are in Screened for the senior developer role.' },
      { time: '11:00', what: 'Two are submitted to the client; interviews are scheduled from the record.' },
      { time: '14:00', what: 'The placed candidate uploads their right-to-work documents in the portal.' },
      { time: 'Start day', what: 'The placement fee invoice is issued automatically.' },
    ],
    faq: [
      {
        q: 'Is Bespoq an ATS?',
        a: 'It covers the core ATS workflow (candidates, stages and documents) together with client CRM and fee invoicing in one system.',
      },
      {
        q: 'Can we track contractor renewals?',
        a: 'Yes. The contracts module tracks end dates and sends renewal reminders before each contract ends.',
      },
      {
        q: 'Can candidates update their own details?',
        a: 'Candidates use the client portal to upload documents and reply to messages.',
      },
    ],
    cards: [
      { name: 'Chen Wu', detail: 'Senior developer', stage: 0 },
      { name: 'Dara Novak', detail: 'Phone screen done', stage: 1 },
      { name: 'Eli Brown', detail: 'Sent to Fable', stage: 2 },
      { name: 'Hana Kim', detail: 'Final round Thu', stage: 3 },
      { name: 'Kofi Mensah', detail: 'Starts 2 Dec', stage: 4 },
    ],
  },
  {
    slug: 'immigration-visa',
    name: 'Immigration and visa consultancies',
    short: 'Immigration',
    vocab: { contact: 'Applicant', contacts: 'Applicants', deal: 'Case', deals: 'Cases', company: 'Sponsor' },
    stages: ['Consultation', 'Collecting documents', 'Final review', 'Lodged', 'Granted'],
    answer:
      'Bespoq is a CRM for immigration and visa consultancies that manages every case from consultation to grant. Consultants collect passports and evidence through a secure applicant portal, track visa type, destination and decision dates, quote professional fees, and get engagement agreements signed online.',
    metaTitle: 'CRM for immigration and visa consultancies | Bespoq',
    metaDescription:
      'A visa CRM for consultations, document checklists, case stages, decision dates, fee quotes and signed agreements. US and Australia.',
    pains: [
      {
        title: 'Document chasing never ends',
        body: 'Every visa needs dozens of documents, and each applicant sends them in a different way.',
      },
      {
        title: 'Deadlines live in heads',
        body: 'Passport expiries and decision dates are tracked on sticky notes.',
      },
      {
        title: 'Fees and agreements on paper',
        body: 'Engagement agreements are printed, signed, scanned and lost.',
      },
    ],
    modules: [
      { name: 'Cases pipeline', use: 'Consultation to granted, by visa type and destination' },
      { name: 'File requests', use: 'Per-visa document checklists in the applicant portal' },
      { name: 'Documents', use: 'Engagement agreements signed online' },
      { name: 'Quotes and invoices', use: 'Professional and government fees' },
      { name: 'Dashboard', use: 'Decisions expected in the next 30 days' },
    ],
    day: [
      {
        time: '9:00',
        what: 'A consultation becomes a case; the student-visa checklist goes to the applicant.',
      },
      { time: '12:00', what: 'The applicant uploads their passport and bank statements in the portal.' },
      {
        time: '15:00',
        what: 'The case manager rejects a blurry scan with a note; a new one arrives within an hour.',
      },
      { time: 'Monday', what: 'The dashboard lists every decision due in the next 30 days.' },
    ],
    faq: [
      {
        q: 'Can applicants upload documents from their phones?',
        a: 'Yes. The applicant portal works on any phone, and each requested document is uploaded and reviewed separately.',
      },
      {
        q: 'Can we track visa types and decision dates?',
        a: 'Yes. The immigration template adds visa type, destination, authority reference, lodgement and decision dates to every case.',
      },
      {
        q: 'Is applicant data kept private?',
        a: 'Each consultancy runs its own instance and database, with role-based access and an audit log of every change.',
      },
    ],
    cards: [
      { name: 'Ana Ribeiro', detail: 'Student, UK', stage: 0 },
      { name: 'Omar Haddad', detail: '4 of 9 docs', stage: 1 },
      { name: 'Mei Tanaka', detail: 'Skilled, Australia', stage: 2 },
      { name: 'Lukas Brandt', detail: 'Lodged 2 Oct', stage: 3 },
      { name: 'Priya Rao', detail: 'Granted', stage: 4 },
    ],
  },
  {
    slug: 'coworking',
    name: 'Coworking and flexible workspace',
    short: 'Coworking',
    vocab: {
      contact: 'Member',
      contacts: 'Members',
      deal: 'Membership',
      deals: 'Memberships',
      company: 'Company',
    },
    stages: ['Enquiry', 'Tour booked', 'Proposal', 'Active', 'Renewal due'],
    answer:
      'Bespoq is a CRM for coworking and flexible workspace operators that runs member enquiries, tours, memberships and renewals alongside day-to-day operations. It books meeting rooms and desks without clashes, checks members and visitors in at the front desk, handles member tickets and invoices memberships.',
    metaTitle: 'CRM for coworking spaces and flexible workspace | Bespoq',
    metaDescription:
      'A coworking CRM for enquiries, tours, memberships, room bookings, front-desk check-ins, member tickets and invoicing.',
    pains: [
      {
        title: 'Tours booked, never followed up',
        body: 'Prospects tour on Tuesday and hear nothing until they have signed elsewhere.',
      },
      { title: 'Room booking chaos', body: 'Double-booked meeting rooms and a calendar nobody updates.' },
      { title: 'Renewals sneak up', body: 'Memberships lapse because nobody saw the end date coming.' },
    ],
    modules: [
      { name: 'Memberships pipeline', use: 'Enquiry to active, with renewals' },
      { name: 'Bookings', use: 'Meeting rooms and desks with opening hours' },
      { name: 'Front desk', use: 'Member and visitor check-in, host notified by email' },
      { name: 'Tickets', use: 'Wifi, access cards and facilities requests' },
      { name: 'Contracts and invoices', use: 'Membership terms, renewals and billing' },
    ],
    day: [
      {
        time: '8:45',
        what: 'The front desk checks in 31 members and 4 visitors; hosts are emailed on arrival.',
      },
      { time: '10:00', what: 'A tour converts to a proposal for 4 dedicated desks.' },
      { time: '14:00', what: 'A member raises a wifi ticket from the portal; it is resolved in 20 minutes.' },
      { time: 'Monthly', what: 'Contracts due for renewal in 30 days appear on the dashboard.' },
    ],
    faq: [
      {
        q: 'Can members book meeting rooms?',
        a: 'Staff book rooms on a day board with clash checks and opening hours. Member self-booking in the portal is on the roadmap.',
      },
      {
        q: 'Does it handle visitor check-in?',
        a: 'Yes. The front desk checks visitors in against a member, who is emailed when their guest arrives.',
      },
      {
        q: 'Can we track access cards and keys?',
        a: 'Yes. Lend them from inventory against a member, with due-back dates and a full history.',
      },
    ],
    cards: [
      { name: 'Northwind Studio', detail: '4 desks', stage: 0 },
      { name: 'Fable Analytics', detail: 'Tour Thu 11:00', stage: 1 },
      { name: 'Mei Tanaka', detail: 'Hot desk, monthly', stage: 2 },
      { name: 'Amara Okafor', detail: 'Private office', stage: 3 },
      { name: 'Lukas Brandt', detail: 'Ends 10 Nov', stage: 4 },
    ],
  },
];

export const industryBySlug = (slug: string) => industries.find((i) => i.slug === slug);
