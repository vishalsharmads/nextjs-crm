import type { InstalledModuleSource } from './types';
import bookings from '../../../../modules/bookings/manifest.json' with { type: 'json' };
import invoices from '../../../../modules/invoices/manifest.json' with { type: 'json' };
import tickets from '../../../../modules/tickets/manifest.json' with { type: 'json' };
import documents from '../../../../modules/documents/manifest.json' with { type: 'json' };

/**
 * Modules compiled into this build. Adding a module means adding it here (a test checks that
 * every /modules/<key>/manifest.json is listed). Enabling or disabling is a runtime setting.
 */
export const installedModuleSources: InstalledModuleSource[] = [
  { manifest: bookings },
  { manifest: invoices },
  { manifest: tickets },
  { manifest: documents },
];
