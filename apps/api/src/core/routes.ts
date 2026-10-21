import type { RouteGroup } from '../http/routes';
import { authRoutes, meRoutes } from './auth/auth.routes';
import { permissionsRoutes, rolesRoutes, teamsRoutes, usersRoutes } from './users/users.routes';
import { labelsRoutes, publicRoutes, settingsRoutes } from './settings/settings.routes';
import { metaRoutes } from './meta/meta.routes';
import { contactsRoutes, organizationsRoutes } from './contacts/contacts.routes';
import { dealsRoutes, leadsRoutes } from './deals/deals.routes';
import { activitiesRoutes } from './activities/activities.routes';
import { tagsRoutes } from './tags/tags.routes';
import { filesRoutes } from './files/files.routes';
import { searchRoutes } from './search/search.routes';
import { customFieldsRoutes, fieldGroupsRoutes, layoutsRoutes } from './custom-fields/custom-fields.routes';
import { pipelinesRoutes } from './pipelines/pipelines.routes';
import { notificationsRoutes } from './notifications/notifications.routes';
import { savedViewsRoutes } from './saved-views/saved-views.routes';
import { entityCollectionRoutes, importsRoutes } from './imports/imports.routes';
import { auditRoutes, dashboardRoutes } from './dashboard/dashboard.routes';
import { blueprintsRoutes, modulesRoutes } from './platform/platform.routes';
import { privacyRoutes } from './privacy/privacy.routes';
import { docsRoutes } from './platform/docs.routes';

/** All core route groups. Specific paths (e.g. /deals/board) are registered before /:uuid. */
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
    customFieldsRoutes,
    fieldGroupsRoutes,
    layoutsRoutes,
    pipelinesRoutes,
    tagsRoutes,
    filesRoutes,
    searchRoutes,
    notificationsRoutes,
    savedViewsRoutes,
    importsRoutes,
    dashboardRoutes,
    auditRoutes,
    blueprintsRoutes,
    modulesRoutes,
    privacyRoutes,
    docsRoutes,
    ...entityCollectionRoutes(),
    ...contactsRoutes,
    ...organizationsRoutes,
    ...leadsRoutes,
    ...dealsRoutes,
    ...activitiesRoutes,
  ];
}
