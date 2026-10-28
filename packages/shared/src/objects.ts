import { z } from 'zod';
import { ENTITY_KEY_PATTERN } from './entities';
import { toPatch } from './patch';

/**
 * Admin-defined objects (Settings → Objects) run on the records engine as record types of this
 * reserved key. No module may use it. Their API and web paths are `/o/<route>`.
 */
export const CUSTOM_OBJECTS_KEY = 'custom';

/** At most this many objects, archived ones included (each has its own table). */
export const MAX_CUSTOM_OBJECTS = 20;

/**
 * Core records an object can link to. Objects can also link to other objects by key. Each link
 * is a column on the object's records.
 */
export const OBJECT_LINK_TARGETS = ['contact', 'organization', 'deal', 'lead'] as const;
/** A core target or another object's key. */
export type ObjectLinkTarget = string;

/** Icons an object may use in the navigation (the same curated set as module menu items). */
export const OBJECT_ICONS = [
  'box',
  'calendar',
  'clipboard-list',
  'credit-card',
  'file-text',
  'key',
  'life-buoy',
  'mail',
  'map-pin',
  'notebook',
  'package',
  'receipt',
  'ticket',
] as const;

const label = z.string().trim().min(1).max(60);

export const customObjectInputSchema = z.object({
  /** Entity key, e.g. `vehicle`. Fixed once created. */
  key: z.string().regex(ENTITY_KEY_PATTERN, 'Use lowercase letters, digits and underscores'),
  singular: label,
  plural: label,
  icon: z.enum(OBJECT_ICONS).default('box'),
  description: z.string().trim().max(500).nullish(),
  /** Core records this object links to. Links can be added later, never removed. */
  links: z.array(z.string().regex(ENTITY_KEY_PATTERN)).max(6).default([]),
});
export type CustomObjectInput = z.infer<typeof customObjectInputSchema>;

export const customObjectPatchSchema = toPatch(customObjectInputSchema.omit({ key: true }));

export interface CustomObjectDto {
  uuid: string;
  key: string;
  /** URL segment: `/o/<route>`. */
  route: string;
  singular: string;
  plural: string;
  icon: string;
  description: string | null;
  links: ObjectLinkTarget[];
  archived: boolean;
  /** Seeded by a blueprint and not edited since. */
  fromBlueprint: string | null;
  createdAt: string;
}

/** URL segment of an object, from its key: `service_visit` → `service-visit`. */
export function objectRoute(key: string): string {
  return key.replace(/_/g, '-');
}

/** Path of a module record type or object, without the leading slash (API and web share it). */
export function recordTypePath(meta: { moduleKey: string; route: string }): string {
  return meta.moduleKey === CUSTOM_OBJECTS_KEY ? `o/${meta.route}` : `m/${meta.moduleKey}/${meta.route}`;
}
