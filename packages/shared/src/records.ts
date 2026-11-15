import { toPatch } from './patch';
import { recurrenceSchema, type Recurrence } from './recurrence';
import { z } from 'zod';
import {
  ACTIVITY_TYPES,
  RELATED_TYPES,
  type ActivityType,
  type DealStatus,
  type RelatedType,
} from './entities';

export interface UserRef {
  uuid: string;
  name: string;
}

export interface TagDto {
  uuid: string;
  name: string;
  slug: string;
  color: string | null;
}

interface RecordBase {
  uuid: string;
  owner: UserRef | null;
  tags: TagDto[];
  custom: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ContactOrgLink {
  uuid: string;
  organization: { uuid: string; name: string };
  relationshipType: string;
  jobTitle: string | null;
  isPrimary: boolean;
}

export interface ContactDto extends RecordBase {
  firstName: string;
  lastName: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  jobTitle: string | null;
  source: string | null;
  lifecycleStatus: string | null;
  organizations: ContactOrgLink[];
  /** Privacy: processing restricted (GDPR Art. 18) and marketing opt-out. Read-only here. */
  processingRestricted: boolean;
  marketingOptOut: boolean;
}

export interface OrganizationDto extends RecordBase {
  name: string;
  website: string | null;
  domain: string | null;
  industry: string | null;
  email: string | null;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  contactCount: number;
}

export const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'unqualified', 'converted'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export interface LeadDto extends RecordBase {
  firstName: string;
  lastName: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  companyName: string | null;
  jobTitle: string | null;
  source: string | null;
  status: LeadStatus;
  convertedAt: string | null;
  converted: { contactUuid: string | null; organizationUuid: string | null; dealUuid: string | null } | null;
  processingRestricted: boolean;
  marketingOptOut: boolean;
  /** Set while the lead pipeline feature is on and the lead has been placed on a stage. */
  pipeline: { uuid: string; name: string } | null;
  stage: LeadStageRef | null;
  stageEnteredAt: string | null;
  rotting: boolean;
  position: number | null;
}

export interface LeadStageRef {
  uuid: string;
  key: string;
  name: string;
  color: string | null;
  isWon: boolean;
  isLost: boolean;
}

export interface DealDto extends RecordBase {
  reference: string | null;
  title: string;
  contact: { uuid: string; name: string } | null;
  organization: { uuid: string; name: string } | null;
  pipeline: { uuid: string; name: string };
  stage: {
    uuid: string;
    key: string;
    name: string;
    isWon: boolean;
    isLost: boolean;
    probability: number;
    color: string | null;
  };
  value: number;
  currency: string;
  expectedClose: string | null;
  status: DealStatus;
  wonAt: string | null;
  lostAt: string | null;
  lostReason: string | null;
  stageEnteredAt: string;
  /** Sat in the current stage longer than the stage's rotting threshold. */
  rotting: boolean;
  position: number;
}

export interface ActivityDto {
  uuid: string;
  type: ActivityType;
  subject: string;
  body: string | null;
  dueAt: string | null;
  startAt: string | null;
  endAt: string | null;
  allDay: boolean;
  completedAt: string | null;
  priority: 'low' | 'normal' | 'high';
  outcome: string | null;
  assignee: UserRef | null;
  owner: UserRef | null;
  related: { type: RelatedType; uuid: string; title: string } | null;
  reminderAt: string | null;
  custom: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  overdue: boolean;
  /** Status stage when the task pipeline is on. */
  stage: LeadStageRef | null;
  /** How the task repeats; completing it creates the next occurrence. */
  recurrence: Recurrence | null;
  /** Checklist progress; total 0 when the task has no checklist. */
  checklist: { done: number; total: number };
  /** People and colleagues involved besides the related record (meeting attendees, email recipients). */
  participants: ParticipantDto[];
  /** Emails: the conversation this message belongs to, and how many messages it has. */
  thread?: { id: string; count: number } | null;
  /** Emails sent with tracking: opens (approximate: some mail apps load images on their own) and clicks. */
  tracking?: {
    opens: number;
    lastOpenedAt: string | null;
    clicks: number;
    lastClickedAt: string | null;
  } | null;
}

export const PARTICIPANT_KINDS = ['contact', 'lead', 'organization', 'user'] as const;
export type ParticipantKind = (typeof PARTICIPANT_KINDS)[number];
export const PARTICIPANT_ROLES = ['attendee', 'organizer', 'from', 'to', 'cc'] as const;
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

export interface ParticipantDto {
  kind: ParticipantKind;
  uuid: string;
  name: string;
  role: ParticipantRole;
  /** Their email address, for replies (absent when hidden from the viewer or unknown). */
  email?: string | null;
}

export const participantInputSchema = z.object({
  kind: z.enum(PARTICIPANT_KINDS),
  uuid: z.uuid(),
  role: z.enum(PARTICIPANT_ROLES).default('attendee'),
});

// ---------- Inputs (shared by API validation and web forms) ----------

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));
const userRef = z.union([z.uuid(), z.literal('@me')]).nullish();
const customInput = z.record(z.string(), z.unknown()).optional();
const tagsInput = z.array(z.string().trim().min(1).max(64)).max(50).optional();

export const contactInputSchema = z.object({
  firstName: z.string().trim().max(100).default(''),
  lastName: z.string().trim().max(100).default(''),
  email: z
    .union([z.email().max(255), z.literal('')])
    .nullish()
    .transform((v) => (v ? v : null)),
  phone: optText(50),
  jobTitle: optText(150),
  source: optText(100),
  lifecycleStatus: optText(50),
  ownerUuid: userRef,
  organizationUuid: z.uuid().nullish(),
  tags: tagsInput,
  custom: customInput,
});
export const contactCreateSchema = contactInputSchema.refine(
  (c) => !!(c.firstName || c.lastName || c.email),
  {
    message: 'Enter a name or an email',
    path: ['firstName'],
  },
);
export const contactPatchSchema = toPatch(contactInputSchema);

export const organizationInputSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(200),
  website: z
    .union([z.url().max(500), z.literal('')])
    .nullish()
    .transform((v) => (v ? v : null)),
  industry: optText(100),
  email: z
    .union([z.email().max(255), z.literal('')])
    .nullish()
    .transform((v) => (v ? v : null)),
  phone: optText(50),
  addressLine1: optText(200),
  addressLine2: optText(200),
  city: optText(100),
  region: optText(100),
  postalCode: optText(20),
  country: z
    .string()
    .length(2)
    .toUpperCase()
    .nullish()
    .or(z.literal('').transform(() => null)),
  ownerUuid: userRef,
  tags: tagsInput,
  custom: customInput,
});
export const organizationPatchSchema = toPatch(organizationInputSchema);

export const leadInputSchema = z.object({
  firstName: z.string().trim().max(100).default(''),
  lastName: z.string().trim().max(100).default(''),
  email: z
    .union([z.email().max(255), z.literal('')])
    .nullish()
    .transform((v) => (v ? v : null)),
  phone: optText(50),
  companyName: optText(200),
  jobTitle: optText(150),
  source: optText(100),
  status: z.enum(LEAD_STATUSES).exclude(['converted']).default('new'),
  pipelineUuid: z.uuid().optional(),
  stageUuid: z.uuid().optional(),
  ownerUuid: userRef,
  tags: tagsInput,
  custom: customInput,
});
export const leadCreateSchema = leadInputSchema.refine(
  (l) => !!(l.firstName || l.lastName || l.email || l.companyName),
  {
    message: 'Enter a name, email or company',
    path: ['firstName'],
  },
);
export const leadPatchSchema = toPatch(leadInputSchema);

export const leadConvertSchema = z.object({
  createOrganization: z.boolean().default(true),
  organizationUuid: z.uuid().nullish(),
  createDeal: z.boolean().default(true),
  dealTitle: z.string().trim().max(255).optional(),
  dealValue: z.number().min(0).optional(),
  pipelineUuid: z.uuid().optional(),
});

export const dealInputSchema = z.object({
  title: z.string().trim().min(1, 'Enter a title').max(255),
  contactUuid: z.uuid().nullish(),
  organizationUuid: z.uuid().nullish(),
  pipelineUuid: z.uuid().optional(),
  stageUuid: z.uuid().optional(),
  value: z.coerce.number().min(0).max(1e13).default(0),
  currency: z.string().length(3).toUpperCase().optional(),
  expectedClose: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish()
    .or(z.literal('').transform(() => null)),
  lostReason: optText(255),
  ownerUuid: userRef,
  tags: tagsInput,
  custom: customInput,
});
export const dealPatchSchema = toPatch(dealInputSchema);

/** Moving a deal or a lead on its board. Leads ignore `lostReason`. */
export const dealMoveSchema = z.object({
  stageUuid: z.uuid(),
  /** Neighbours in the target column, for ordering. */
  beforeUuid: z.uuid().nullish(),
  afterUuid: z.uuid().nullish(),
  lostReason: z.string().trim().max(255).optional(),
});

const isoDateTime = z.iso.datetime({ offset: true }).nullish();
export const activityInputSchema = z.object({
  type: z.enum(ACTIVITY_TYPES),
  subject: z.string().trim().max(255).default(''),
  body: z.string().max(100_000).nullish(),
  dueAt: isoDateTime,
  startAt: isoDateTime,
  endAt: isoDateTime,
  allDay: z.boolean().default(false),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
  outcome: optText(100),
  assigneeUuid: userRef,
  related: z.object({ type: z.enum(RELATED_TYPES), uuid: z.uuid() }).nullish(),
  reminderAt: isoDateTime,
  recurrence: recurrenceSchema.nullish(),
  pipelineUuid: z.uuid().optional(),
  stageUuid: z.uuid().optional(),
  completed: z.boolean().optional(),
  /** Replaces the participant list when given. */
  participants: z.array(participantInputSchema).max(50).optional(),
  /** Meetings: email invitations (.ics) to the participants; later changes send updates. */
  invite: z.boolean().optional(),
  custom: customInput,
});
export const activityCreateSchema = activityInputSchema.refine(
  (a) => (a.type === 'note' ? !!a.body : !!a.subject),
  {
    message: 'Add a subject',
    path: ['subject'],
  },
);
export const activityPatchSchema = toPatch(activityInputSchema);

/** A comment on a task, call or meeting. `mentions` are the users notified, by uuid. */
export interface ActivityCommentDto {
  uuid: string;
  body: string;
  author: UserRef | null;
  mentions: UserRef[];
  createdAt: string;
  editedAt: string | null;
  /** The viewer wrote it (or is an admin), so may edit and delete it. */
  canEdit: boolean;
}
export const activityCommentSchema = z.object({
  body: z.string().trim().min(1).max(20_000),
  mentions: z.array(z.uuid()).max(20).default([]),
});
export interface ChecklistItemDto {
  uuid: string;
  label: string;
  done: boolean;
  doneAt: string | null;
  doneBy: UserRef | null;
}
export const checklistItemSchema = z.object({ label: z.string().trim().min(1).max(500) });
export const checklistItemPatchSchema = z.object({
  label: z.string().trim().min(1).max(500).optional(),
  done: z.boolean().optional(),
});
export const checklistOrderSchema = z.object({ uuids: z.array(z.uuid()).min(1).max(200) });
export const activityCommentPatchSchema = z.object({ body: z.string().trim().min(1).max(20_000) });

/** Comments on any record use the same shape as task comments. */
export type RecordCommentDto = ActivityCommentDto;
export const recordCommentSchema = activityCommentSchema;
export const recordCommentPatchSchema = activityCommentPatchSchema;

export const BULK_ACTIONS = [
  'delete',
  'restore',
  'assign',
  'add_tags',
  'remove_tags',
  'update_field',
  'move_stage',
] as const;
export const bulkSchema = z.object({
  action: z.enum(BULK_ACTIONS),
  /** Explicit uuids, or `all` with the current list filter. */
  uuids: z.array(z.uuid()).max(5000).optional(),
  all: z.boolean().optional(),
  filter: z.unknown().optional(),
  q: z.string().max(200).optional(),
  view: z.uuid().optional(),
  ownerUuid: z.uuid().optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  field: z.string().max(80).optional(),
  value: z.unknown().optional(),
  stageUuid: z.uuid().optional(),
});
export type BulkInput = z.infer<typeof bulkSchema>;

export interface TimelineItem {
  id: string;
  kind: 'activity' | 'change' | 'created' | 'stage' | 'file' | 'merged' | 'email' | 'comment';
  at: string;
  actor: UserRef | null;
  title: string;
  detail?: unknown;
  activity?: ActivityDto;
  comment?: ActivityCommentDto;
}

export interface DuplicateCandidate {
  uuid: string;
  title: string;
  subtitle: string | null;
  reasons: string[];
  score: number;
  /** Set when the match is another record type (a lead matching a contact). */
  entity?: string;
}

/** Record types with duplicate rules, and the fields a rule can compare. `cf:<key>` adds a filterable custom field. */
export const DUPLICATE_ENTITIES = ['contact', 'organization', 'lead'] as const;
export type DuplicateEntity = (typeof DUPLICATE_ENTITIES)[number];
export const DUPLICATE_FIELDS: Record<DuplicateEntity, { key: string; label: string }[]> = {
  contact: [
    { key: 'email', label: 'Email' },
    { key: 'phone', label: 'Phone' },
    { key: 'name', label: 'Name' },
    { key: 'organization', label: 'Organization' },
  ],
  organization: [
    { key: 'domain', label: 'Website' },
    { key: 'name', label: 'Name' },
  ],
  lead: [
    { key: 'email', label: 'Email' },
    { key: 'phone', label: 'Phone' },
    { key: 'name', label: 'Name' },
    { key: 'company', label: 'Company' },
  ],
};

export const duplicateRuleSchema = z.object({
  entity: z.enum(DUPLICATE_ENTITIES),
  name: z.string().trim().min(1).max(100),
  fields: z
    .array(z.string().regex(/^(email|phone|name|organization|domain|company|cf:[a-z][a-z0-9_]{0,48})$/))
    .min(1)
    .max(4),
  action: z.enum(['warn', 'block']).default('warn'),
  active: z.boolean().default(true),
});

export interface DuplicateRuleDto {
  uuid: string;
  entity: DuplicateEntity;
  name: string;
  fields: string[];
  action: 'warn' | 'block';
  active: boolean;
}

/** What a create form learns about possible duplicates. */
export interface DuplicateCheckResult {
  data: DuplicateCandidate[];
  /** Matches the person cannot open: counted, never described. */
  hidden: number;
  /** A blocking rule matched: saving will be refused. */
  blocked: boolean;
}

export interface DuplicatePairDto {
  uuid: string;
  entity: 'contact' | 'organization';
  rule: string | null;
  a: { uuid: string; title: string; subtitle: string | null };
  b: { uuid: string; title: string; subtitle: string | null };
  createdAt: string;
}

/** One record opened to one more person or team (on top of role scope). */
export interface RecordShareDto {
  uuid: string;
  user: UserRef | null;
  team: { uuid: string; name: string } | null;
  level: 'view' | 'edit';
  sharedBy: UserRef | null;
  createdAt: string;
}

export const recordShareSchema = z
  .object({
    userUuid: z.uuid().optional(),
    teamUuid: z.uuid().optional(),
    level: z.enum(['view', 'edit']).default('view'),
  })
  .refine((v) => !!v.userUuid !== !!v.teamUuid, 'Choose one person or one team');

/** Shares on a record, and whether the viewer may change them. */
export interface RecordSharesResult {
  data: RecordShareDto[];
  canManage: boolean;
}
