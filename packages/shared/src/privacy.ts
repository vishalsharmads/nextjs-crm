import { z } from 'zod';

/** GDPR Art. 6 lawful bases (other privacy laws map onto these). */
export const LAWFUL_BASES = [
  'consent',
  'contract',
  'legal_obligation',
  'vital_interests',
  'public_task',
  'legitimate_interests',
] as const;
export type LawfulBasis = (typeof LAWFUL_BASES)[number];

export const consentPurposeSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,48}$/),
  label: z.string().trim().min(1).max(100),
  /** The exact wording shown next to the checkbox. Its hash is stored with every consent. */
  text: z.string().trim().min(1).max(2000),
  lawfulBasis: z.enum(LAWFUL_BASES).default('consent'),
  /** Marketing purposes: withdrawing (or unsubscribing) also sets the marketing opt-out. */
  marketing: z.boolean().default(false),
  active: z.boolean().default(true),
});
export type ConsentPurpose = z.infer<typeof consentPurposeSchema>;

/** The people privacy requests and consent are recorded for. */
export const DATA_SUBJECT_ENTITIES = ['contact', 'lead'] as const;
export type DataSubjectEntity = (typeof DATA_SUBJECT_ENTITIES)[number];

export const CONSENT_SOURCES = ['form', 'manual', 'import', 'portal', 'unsubscribe', 'api'] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

export interface ConsentDto {
  purposeKey: string;
  purposeLabel: string;
  status: 'granted' | 'withdrawn';
  lawfulBasis: LawfulBasis;
  source: ConsentSource;
  textSnapshot: string;
  textHash: string;
  recordedBy: { uuid: string; name: string } | null;
  createdAt: string;
}

/** Current state per purpose plus the full history, newest first. */
export interface ConsentSummaryDto {
  current: { purposeKey: string; purposeLabel: string; status: 'granted' | 'withdrawn' | 'none' }[];
  history: ConsentDto[];
  marketingOptOut: boolean;
  processingRestricted: boolean;
}

export const consentChangeSchema = z.object({
  purposeKey: z.string().regex(/^[a-z][a-z0-9_]{0,48}$/),
  status: z.enum(['granted', 'withdrawn']),
  /** How the person gave or withdrew it, for the record (for example "Phone call 3 May"). */
  note: z.string().trim().max(500).optional(),
});

/** Data subject rights across GDPR, UK GDPR, DPDP, CCPA/CPRA, PIPEDA and LGPD. */
export const PRIVACY_REQUEST_TYPES = [
  'access',
  'portability',
  'rectification',
  'erasure',
  'restriction',
  'objection',
  'opt_out_sale_share',
] as const;
export type PrivacyRequestType = (typeof PRIVACY_REQUEST_TYPES)[number];

export const PRIVACY_REQUEST_STATUSES = ['open', 'in_progress', 'completed', 'rejected'] as const;
export type PrivacyRequestStatus = (typeof PRIVACY_REQUEST_STATUSES)[number];

export const privacyRequestCreateSchema = z.object({
  type: z.enum(PRIVACY_REQUEST_TYPES),
  subjectEntity: z.enum(DATA_SUBJECT_ENTITIES).optional(),
  subjectUuid: z.uuid().optional(),
  /** For requests from people not (yet) matched to a record. */
  requesterName: z.string().trim().max(200).default(''),
  requesterEmail: z.union([z.email().max(254), z.literal('')]).default(''),
  channel: z.string().trim().max(50).default('email'),
  receivedAt: z.iso.date().optional(),
  notes: z.string().trim().max(5000).default(''),
  assigneeUuid: z.uuid().nullable().optional(),
});
export const privacyRequestUpdateSchema = z.object({
  status: z.enum(PRIVACY_REQUEST_STATUSES).optional(),
  notes: z.string().trim().max(5000).optional(),
  resolution: z.string().trim().max(5000).optional(),
  assigneeUuid: z.uuid().nullable().optional(),
  subjectEntity: z.enum(DATA_SUBJECT_ENTITIES).optional(),
  subjectUuid: z.uuid().optional(),
});

export interface PrivacyRequestDto {
  uuid: string;
  type: PrivacyRequestType;
  status: PrivacyRequestStatus;
  subject: { entity: DataSubjectEntity; uuid: string; name: string } | null;
  requesterName: string;
  requesterEmail: string;
  channel: string;
  receivedAt: string;
  dueAt: string;
  overdue: boolean;
  notes: string;
  resolution: string;
  assignee: { uuid: string; name: string } | null;
  completedAt: string | null;
  createdAt: string;
}

/** What an erasure did, and what it had to keep (legal holds such as issued invoices). */
export interface ErasureReportDto {
  mode: 'anonymize' | 'delete';
  cleared: Record<string, number>;
  retained: { area: string; reason: string }[];
}
