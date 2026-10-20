import type { Express } from 'express';
import { createApp } from './http/app';
import { db } from './db/knex';
import { syncPermissions } from './core/rbac/catalog';
import { isInstalled } from './core/settings/settings.service';
import { logger } from './lib/logger';
import { installModuleGate, loadModules, moduleRouteGroups, refreshModuleStates } from './modules/registry';

export async function bootstrap(): Promise<{ app: Express; shutdown: () => Promise<void> }> {
  loadModules();
  installModuleGate();
  if (await isInstalled()) {
    await syncPermissions();
    await refreshModuleStates();
  } else {
    logger.warn('This instance is not installed yet. Run: npm run install:instance -- --blueprint=<key>');
  }
  const app = createApp({ extraGroups: moduleRouteGroups() });
  return {
    app,
    shutdown: async () => {
      await db.destroy();
    },
  };
}
