/**
 * The public contract for module API code. Modules import from `@app/api/module-api` only,
 * never from API internals, so core can evolve without breaking modules.
 */
export { defineRoutes, type RouteGroup } from './http/routes';
export type { AuthUser, RequestContext } from './http/context';
export type { ApiModule } from './modules/types';
export type { Migration } from './db/migrations';
export { db, type Db } from './db/knex';
export { audit } from './core/audit/audit.service';
export { AppError, notFound } from './lib/errors';
export { newUuid } from './lib/ids';
export { applyScope, assertCan, can } from './core/rbac/access';
export { registerModuleWidget } from './modules/widgets';
export { notify } from './core/notifications/notifications.service';
