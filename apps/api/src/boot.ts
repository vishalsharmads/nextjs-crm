import type { Express } from 'express';
import { createApp } from './http/app';
import { db } from './db/knex';
import { syncPermissions } from './core/rbac/catalog';
import { isInstalled } from './core/settings/settings.service';
import { logger } from './lib/logger';
import { every, startJobWorker, stopJobWorker, stopSchedules } from './lib/jobs';
import { sendDueReminders } from './core/notifications/notifications.service';
import { env, isTest } from './config/env';
import './core/imports/import-export';
import { startWebhookRetries } from './core/webhooks/webhooks';
import { startMailSync } from './core/email/email';
import { maintainAuditLogs } from './core/audit/integrity';
import { remindDueRequests } from './core/privacy/requests.service';
import { runRetention } from './core/privacy/retention.service';
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
  const app = createApp({
    extraGroups: moduleRouteGroups(),
    static: { webDir: env.WEB_DIR, siteDir: env.SITE_DIR, appPath: new URL(env.APP_URL).pathname },
  });
  if (!isTest) {
    startJobWorker();
    every(60_000, 'activity-reminders', () => sendDueReminders());
    startWebhookRetries();
    startMailSync();
    every(60 * 60_000, 'audit.maintain', maintainAuditLogs);
    every(60 * 60_000, 'privacy.reminders', remindDueRequests);
    every(6 * 60 * 60_000, 'privacy.retention', () => runRetention());
    for (const m of loadModules()) m.api?.start?.();
  }
  return {
    app,
    shutdown: async () => {
      stopSchedules();
      await stopJobWorker();
      await db.destroy();
    },
  };
}
