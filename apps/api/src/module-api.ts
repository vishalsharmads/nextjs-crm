/**
 * The public contract for module API code. Modules import from `@app/api/module-api` only,
 * never from API internals, so core can evolve without breaking modules.
 */
export { defineRoutes, type RouteGroup } from './http/routes';
export { systemContext, type AuthUser, type RequestContext } from './http/context';
export type { ApiModule } from './modules/types';
export type { Migration } from './db/migrations';
export { db, type Db } from './db/knex';
export { audit } from './core/audit/audit.service';
export { AppError, notFound } from './lib/errors';
export { newUuid } from './lib/ids';
export { applyScope, assertCan, can } from './core/rbac/access';
export { registerModuleWidget } from './modules/widgets';
export { notify } from './core/notifications/notifications.service';
export { getGroup as getSettingsGroup } from './core/settings/settings.service';
export { emit, onEvent, type DomainEvent } from './core/events/events';
export { enqueue, registerJob, every } from './lib/jobs';
export { scopeAllows } from './core/rbac/access';
export {
  documentColumns,
  lineItemColumns,
  linkRefs,
  loadLines,
  nextDocNumber,
  resolveLinks,
  saveLines,
  totalsColumns,
  todayIn,
  addDays,
  type LineDto,
  type LineInput,
  type LinkInput,
  type RecordRef,
} from './core/commerce/documents';
export { userRefs, iso } from './core/records/hydrate';
export { escapeLike } from './core/records/filters';
export { userIdFromRef } from './core/records/hydrate';
export { isModuleEnabled } from './modules/registry';
