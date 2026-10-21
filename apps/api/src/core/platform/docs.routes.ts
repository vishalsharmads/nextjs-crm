import { defineRoutes } from '../../http/routes';
import { buildOpenApi } from '../../http/openapi';
import { getBranding } from '../settings/settings.service';

export const docsRoutes = defineRoutes('/openapi.json', ['platform']).add({
  method: 'get',
  path: '/',
  permission: 'core.settings.manage',
  summary: 'OpenAPI document for this instance',
  handler: async () => buildOpenApi((await getBranding()).appName),
});
