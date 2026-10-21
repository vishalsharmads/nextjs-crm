import type { RouteGroup } from '../http/routes';
import { authRoutes, meRoutes } from './auth/auth.routes';
import { permissionsRoutes, rolesRoutes, teamsRoutes, usersRoutes } from './users/users.routes';
import { labelsRoutes, publicRoutes, settingsRoutes } from './settings/settings.routes';
import { metaRoutes } from './meta/meta.routes';

/** All core route groups. Order matters only for overlapping paths (specific before generic). */
export function coreRouteGroups(): RouteGroup[] {
  return [
    publicRoutes,
    authRoutes,
    meRoutes,
    usersRoutes,
    rolesRoutes,
    permissionsRoutes,
    teamsRoutes,
    settingsRoutes,
    labelsRoutes,
    metaRoutes,
  ];
}
