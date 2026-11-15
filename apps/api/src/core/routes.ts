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
import { duplicateRoutes } from './duplicates/duplicates.routes';
import { pushRoutes } from './push/push';
import { trackingRoutes } from './email/tracking';
import { calendarFeedRoutes, publicCalendarRoutes } from './calendar/feed';
import { calendarAccountRoutes } from './calendar/sync';
import { customFieldsRoutes, fieldGroupsRoutes, layoutsRoutes } from './custom-fields/custom-fields.routes';
import { pipelinesRoutes } from './pipelines/pipelines.routes';
import { notificationsRoutes } from './notifications/notifications.routes';
import { savedViewsRoutes } from './saved-views/saved-views.routes';
import { entityCollectionRoutes, importsRoutes } from './imports/imports.routes';
import { dashboardRoutes } from './dashboard/dashboard.routes';
import { accessLogRoutes, auditRoutes } from './audit/audit.routes';
import { blueprintsRoutes, modulesRoutes } from './platform/platform.routes';
import { privacyRoutes, publicPrivacyRoutes } from './privacy/privacy.routes';
import { docsRoutes } from './platform/docs.routes';
import { apiKeysRoutes } from './api-keys/api-keys';
import { webhooksRoutes } from './webhooks/webhooks';
import { automationsRoutes } from './automations/automations';
import { formsRoutes, publicFormsRoutes } from './forms/forms';
import { templatesRoutes } from './templates/templates';
import { emailRoutes } from './email/email';
import { objectRecordRoutes, objectsRoutes } from './objects/objects.routes';
import { tokensRoutes } from './tokens/tokens';
import { connectedAppsRoutes, oauthRoutes } from './oauth/oauth';
import { mcpRoutes } from './mcp/mcp.routes';
import { exchangeRatesRoutes, reportsRoutes } from './reports/reports.routes';
import { reportBuilderRoutes } from './reports/builder';
import { toolsRoutes } from './tools/tools.routes';

/** All core route groups. Specific paths (e.g. /deals/board) are registered before /:uuid. */
export function coreRouteGroups(): RouteGroup[] {
  return [
    publicRoutes,
    publicFormsRoutes,
    authRoutes,
    tokensRoutes,
    connectedAppsRoutes,
    oauthRoutes,
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
    duplicateRoutes,
    pushRoutes,
    trackingRoutes,
    calendarFeedRoutes,
    publicCalendarRoutes,
    calendarAccountRoutes,
    notificationsRoutes,
    savedViewsRoutes,
    importsRoutes,
    dashboardRoutes,
    auditRoutes,
    accessLogRoutes,
    blueprintsRoutes,
    modulesRoutes,
    privacyRoutes,
    publicPrivacyRoutes,
    docsRoutes,
    apiKeysRoutes,
    webhooksRoutes,
    automationsRoutes,
    formsRoutes,
    templatesRoutes,
    emailRoutes,
    objectsRoutes,
    mcpRoutes,
    reportBuilderRoutes,
    reportsRoutes,
    exchangeRatesRoutes,
    toolsRoutes,
    objectRecordRoutes,
    ...entityCollectionRoutes(),
    ...contactsRoutes,
    ...organizationsRoutes,
    ...leadsRoutes,
    ...dealsRoutes,
    ...activitiesRoutes,
  ];
}
