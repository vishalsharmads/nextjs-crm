import { entityKeySchema, isCoreEntity, type CoreEntity, type RecordEntity } from '@app/shared';
import type { ResourceDef } from './types';
import { moduleTablePrefix } from './paths';
import { contactsDef } from '../contacts/contacts.def';
import { organizationsDef } from '../organizations/organizations.def';
import { leadsDef } from '../leads/leads.def';
import { dealsDef } from '../deals/deals.def';
import { activitiesDef } from '../activities/activities.def';
import { AppError, notFound } from '../../lib/errors';
import { registerEntityTable, unregisterEntityTable } from '../custom-fields/definitions';
import { registerDefaultLabels } from '../labels/labels.service';
import { registerRecordTypeEvents } from '../events/events';
import { registerScopedResource } from '../rbac/scoped';

export const recordDefs: Record<CoreEntity, ResourceDef> = {
  contact: contactsDef as ResourceDef,
  organization: organizationsDef as ResourceDef,
  lead: leadsDef as ResourceDef,
  deal: dealsDef as ResourceDef,
  activity: activitiesDef as ResourceDef,
};

/** Record types registered by modules, keyed by entity. Registered whether or not the module is enabled. */
const moduleDefs = new Map<string, ResourceDef>();

/** Set by the module registry (avoids an import cycle); true when a module is enabled. */
let moduleEnabled: (key: string) => boolean = () => false;

export function setRecordTypeGate(fn: (key: string) => boolean) {
  moduleEnabled = fn;
}

export function registerRecordType(def: ResourceDef) {
  if (!def.moduleKey) throw new Error(`Record type "${def.entity}" must name its module`);
  if (isCoreEntity(def.entity) || moduleDefs.has(def.entity)) {
    throw new Error(`Record type "${def.entity}" is already registered`);
  }
  const prefix = moduleTablePrefix(def.moduleKey);
  if (!def.table.startsWith(prefix)) {
    throw new Error(`Record type "${def.entity}" must use a table named ${prefix}*`);
  }
  moduleDefs.set(def.entity, def);
  registerEntityTable(def.entity, def.table);
  if (def.labels) registerDefaultLabels(def.entity, def.labels);
  registerRecordTypeEvents(def.entity);
  registerScopedResource(def.resource);
}

/** Test helper: forget a registered type. */
export function unregisterRecordType(entity: string) {
  moduleDefs.delete(entity);
  unregisterEntityTable(entity);
}

/** A core entity or a record type of an enabled module; undefined otherwise. */
export function findRecordDef(entity: string): ResourceDef | undefined {
  if (isCoreEntity(entity)) return recordDefs[entity];
  const def = moduleDefs.get(entity);
  return def && moduleEnabled(def.moduleKey!) ? def : undefined;
}

/** Like `findRecordDef`, but an unknown or disabled type is a 404. */
export function getRecordDef(entity: string): ResourceDef {
  const def = findRecordDef(entity);
  if (!def) throw notFound('Record type');
  return def;
}

/** Validates an entity key from a request names a usable record type. */
export function assertRecordEntity(entity: string): RecordEntity {
  if (!findRecordDef(entity)) throw new AppError('VALIDATION_FAILED', `Unknown record type "${entity}"`);
  return entity;
}

/** Record types of enabled modules. */
export function moduleRecordDefs(): ResourceDef[] {
  return [...moduleDefs.values()].filter((d) => moduleEnabled(d.moduleKey!));
}

/** Every registered module record type, enabled or not (DDL reconcile, privacy). */
export function allModuleRecordDefs(): ResourceDef[] {
  return [...moduleDefs.values()];
}

/** Entities that support custom fields, views and layouts: core plus enabled module types. */
export function customizableEntities(): RecordEntity[] {
  return [...Object.keys(recordDefs), ...moduleRecordDefs().map((d) => d.entity)];
}

/** Entity key from a request: well formed and naming a core entity or an enabled module type. */
export const recordEntitySchema = entityKeySchema.refine((e) => !!findRecordDef(e), 'Unknown record type');
