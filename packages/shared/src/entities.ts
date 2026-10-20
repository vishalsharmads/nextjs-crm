/** Core business entities. Fixed tables with real foreign keys; extended through custom fields. */
export const CORE_ENTITIES = ['contact', 'organization', 'lead', 'deal', 'activity'] as const;
export type CoreEntity = (typeof CORE_ENTITIES)[number];

/** Entities that carry a `custom` JSON column and support custom fields. */
export const CUSTOMIZABLE_ENTITIES = CORE_ENTITIES;
export type CustomizableEntity = CoreEntity;

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
