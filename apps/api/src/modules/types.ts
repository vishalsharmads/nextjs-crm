import type { Migration } from '../db/migrations';
import type { RouteGroup } from '../http/routes';
import type { PrivacyHandler } from '../core/privacy/handlers';
import type { ResourceDef } from '../core/records/types';

/** What a module's `api_entry` exports. Routes mount under /api/v1/m/<key>. */
export interface ApiModule {
  routes?: () => RouteGroup[];
  migrations?: Record<string, Migration>;
  /** Start recurring work (called once at boot, outside tests). Tasks must no-op while the module is disabled. */
  start?: () => void;
  /** Required when the module stores data about contacts or leads: data subject export and erasure. */
  privacy?: PrivacyHandler;
  /**
   * Record types built with `defineRecordType`. Each gets the standard record routes under
   * `/m/<key>/<route>`, custom fields, saved views, search, import/export, bulk actions, trash,
   * automations and audit.
   */
  recordTypes?: ResourceDef[];
  /**
   * Check the module's settings against the outside service (Settings → Modules → Test connection).
   * Receives the values being saved merged over the stored ones, secrets decrypted. Throw an
   * `AppError('UPSTREAM_FAILED', …)` with a message for people; never pass a provider's own error text on.
   * Check outbound URLs with `assertSafeUrl` first.
   */
  testConnection?: (settings: Record<string, string | number | boolean>) => Promise<{ message: string }>;
}

export interface InstalledModuleSource {
  manifest: unknown;
  api?: ApiModule;
}
