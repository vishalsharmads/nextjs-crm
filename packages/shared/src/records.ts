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
}

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
  kind: 'activity' | 'change' | 'created' | 'stage' | 'file' | 'merged' | 'email';
  at: string;
  actor: UserRef | null;
  title: string;
  detail?: unknown;
  activity?: ActivityDto;
}

export interface DuplicateCandidate {
  uuid: string;
  title: string;
  subtitle: string | null;
  reasons: string[];
  score: number;
}
