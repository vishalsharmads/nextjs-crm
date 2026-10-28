import { z } from 'zod';

/** Core business entities. Fixed tables with real foreign keys; extended through custom fields. */
export const CORE_ENTITIES = ['contact', 'organization', 'lead', 'deal', 'activity'] as const;
export type CoreEntity = (typeof CORE_ENTITIES)[number];

/**
 * Key of any record type: a core entity, or a record type a module registers (for example
 * `property`). Module keys are validated at registration and checked against the registry at
 * runtime, so this type is open.
 */
export type RecordEntity = CoreEntity | (string & {});

export const ENTITY_KEY_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;

/** Well-formed entity key. The API still checks it names a registered, enabled record type. */
export const entityKeySchema = z.string().regex(ENTITY_KEY_PATTERN, 'Invalid entity');

/** Core entities that carry a `custom` JSON column. Module record types are added at runtime. */
export const CUSTOMIZABLE_ENTITIES = CORE_ENTITIES;
export type CustomizableEntity = RecordEntity;

export const isCoreEntity = (entity: string): entity is CoreEntity =>
  (CORE_ENTITIES as readonly string[]).includes(entity);

/** Entities whose display name can be overridden by vocabulary (labels table). */
export const LABEL_ENTITY_KEYS = [...CORE_ENTITIES, 'pipeline', 'stage', 'tag', 'user', 'team'] as const;
export type LabelEntityKey = (typeof LABEL_ENTITY_KEYS)[number];

/** Default (English) vocabulary used until labels are configured. */
export const DEFAULT_LABELS: Record<LabelEntityKey, { singular: string; plural: string }> = {
  contact: { singular: 'Contact', plural: 'Contacts' },
  organization: { singular: 'Organization', plural: 'Organizations' },
  lead: { singular: 'Lead', plural: 'Leads' },
  deal: { singular: 'Deal', plural: 'Deals' },
  activity: { singular: 'Activity', plural: 'Activities' },
  pipeline: { singular: 'Pipeline', plural: 'Pipelines' },
  stage: { singular: 'Stage', plural: 'Stages' },
  tag: { singular: 'Tag', plural: 'Tags' },
  user: { singular: 'User', plural: 'Users' },
  team: { singular: 'Team', plural: 'Teams' },
};

/** URL segment (plural, kebab) for each core entity. */
export const ENTITY_ROUTE: Record<CoreEntity, string> = {
  contact: 'contacts',
  organization: 'organizations',
  lead: 'leads',
  deal: 'deals',
  activity: 'activities',
};

/** Permission resource key for each core entity. */
export const ENTITY_RESOURCE: Record<CoreEntity, string> = {
  contact: 'core.contacts',
  organization: 'core.organizations',
  lead: 'core.leads',
  deal: 'core.deals',
  activity: 'core.activities',
};

export const ACTIVITY_TYPES = ['task', 'call', 'meeting', 'note', 'email'] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const RELATED_TYPES = ['contact', 'organization', 'deal', 'lead'] as const;
export type RelatedType = (typeof RELATED_TYPES)[number];

export const DEAL_STATUSES = ['open', 'won', 'lost'] as const;
export type DealStatus = (typeof DEAL_STATUSES)[number];
