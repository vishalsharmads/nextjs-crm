import type { InstalledModuleSource } from './types';
import bookings from '../../../../modules/bookings/manifest.json' with { type: 'json' };
import { bookings as bookingsApi } from '../../../../modules/bookings/api';
import invoices from '../../../../modules/invoices/manifest.json' with { type: 'json' };
import tickets from '../../../../modules/tickets/manifest.json' with { type: 'json' };
import { tickets as ticketsApi } from '../../../../modules/tickets/api';
import documents from '../../../../modules/documents/manifest.json' with { type: 'json' };
import { documents as documentsApi } from '../../../../modules/documents/api';
import notesDemo from '../../../../modules/notes-demo/manifest.json' with { type: 'json' };
import { notesDemo as notesDemoApi } from '../../../../modules/notes-demo/api';
import products from '../../../../modules/products/manifest.json' with { type: 'json' };
import { products as productsApi } from '../../../../modules/products/api';
import quotes from '../../../../modules/quotes/manifest.json' with { type: 'json' };
import { quotes as quotesApi } from '../../../../modules/quotes/api';
import { invoices as invoicesApi } from '../../../../modules/invoices/api';
import contracts from '../../../../modules/contracts/manifest.json' with { type: 'json' };
import { contracts as contractsApi } from '../../../../modules/contracts/api';
import portal from '../../../../modules/portal/manifest.json' with { type: 'json' };
import { portal as portalApi } from '../../../../modules/portal/api';
import assets from '../../../../modules/assets/manifest.json' with { type: 'json' };
import { assets as assetsApi } from '../../../../modules/assets/api';

/**
 * Modules compiled into this build. Adding a module means adding it here (a test checks that
 * every /modules/<key>/manifest.json is listed). Enabling or disabling is a runtime setting.
 */
export const installedModuleSources: InstalledModuleSource[] = [
  { manifest: bookings, api: bookingsApi },
  { manifest: invoices, api: invoicesApi },
  { manifest: tickets, api: ticketsApi },
  { manifest: documents, api: documentsApi },
  { manifest: notesDemo, api: notesDemoApi },
  { manifest: products, api: productsApi },
  { manifest: quotes, api: quotesApi },
  { manifest: contracts, api: contractsApi },
  { manifest: portal, api: portalApi },
  { manifest: assets, api: assetsApi },
];
