import type { RouteGroup } from '../../http/routes';
import { collectionRoutes } from '../imports/imports.routes';
import { recordRoutes } from './routes';
import type { ResourceDef } from './types';

/**
 * Route groups of module record types. Collection paths (`/bulk`, `/export`) are mounted before
 * the module's own routes, and the `/:uuid` record routes after them, so nothing is shadowed.
 */
export function recordTypeRouteGroups(defs: ResourceDef[], part: 'collection' | 'records'): RouteGroup[] {
  return defs.map((def) =>
    part === 'collection' ? collectionRoutes(def) : recordRoutes(def, def.moduleKey!),
  );
}
