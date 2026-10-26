import type { Migration } from '../db/migrations';
import type { RouteGroup } from '../http/routes';
import type { PrivacyHandler } from '../core/privacy/handlers';

/** What a module's `api_entry` exports. Routes mount under /api/v1/m/<key>. */
export interface ApiModule {
  routes?: () => RouteGroup[];
  migrations?: Record<string, Migration>;
  /** Start recurring work (called once at boot, outside tests). Tasks must no-op while the module is disabled. */
  start?: () => void;
  /** Required when the module stores data about contacts or leads: data subject export and erasure. */
  privacy?: PrivacyHandler;
}

export interface InstalledModuleSource {
  manifest: unknown;
  api?: ApiModule;
}
