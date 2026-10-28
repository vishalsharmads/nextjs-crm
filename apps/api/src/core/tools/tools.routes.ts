import { defineRoutes } from '../../http/routes';
import { allTools } from './registry';
import './core-tools';

/** The tool catalog, for Settings → AI clients (choosing which tools clients may call). */
export const toolsRoutes = defineRoutes('/tools', ['mcp']).add({
  method: 'get',
  path: '/',
  permission: 'core.settings.manage',
  handler: () => ({ data: allTools() }),
});
