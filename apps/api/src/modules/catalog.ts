import { compareVersions, moduleCatalogSchema, type ModuleCatalogEntry } from '@app/module-sdk';
import { env } from '../config/env';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';
import { assertSafeUrl } from '../core/webhooks/webhooks';
import { getModule } from './registry';

/**
 * The module catalog: modules a developer can add to this checkout with `module:add`.
 * Read from MODULE_CATALOG_URL, cached for an hour. Nothing here installs or runs code.
 */

const TTL = 60 * 60 * 1000;
const MAX_BYTES = 1024 * 1024;
let cached: { at: number; url: string; entries: ModuleCatalogEntry[] } | null = null;

export const clearCatalogCache = () => (cached = null);

export async function readCatalog(
  url: string,
  token = env.MODULE_CATALOG_TOKEN,
): Promise<ModuleCatalogEntry[]> {
  await assertSafeUrl(url, 'MODULE_CATALOG_URL');
  let text: string;
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    text = await res.text();
  } catch (err) {
    logger.warn({ err }, 'module catalog could not be read');
    throw new AppError('UPSTREAM_FAILED', 'The module catalog could not be reached. Try again later.');
  }
  if (text.length > MAX_BYTES) throw new AppError('UPSTREAM_FAILED', 'The module catalog is too large.');
  const parsed = moduleCatalogSchema.safeParse(
    (() => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return null;
      }
    })(),
  );
  if (!parsed.success)
    throw new AppError('UPSTREAM_FAILED', 'The module catalog is not in the expected format.');
  return parsed.data.modules;
}

/** Catalog entries for the marketplace, compared with the modules in this build. */
export async function catalogForMarketplace() {
  const url = env.MODULE_CATALOG_URL;
  if (!url) return { configured: false, data: [] };
  if (!cached || cached.url !== url || Date.now() - cached.at > TTL)
    cached = { at: Date.now(), url, entries: await readCatalog(url) };
  return {
    configured: true,
    data: cached.entries.map((e) => {
      const local = getModule(e.key)?.manifest;
      return {
        key: e.key,
        name: e.name,
        version: e.version,
        description: e.description,
        category: e.category,
        installed: !!local,
        updateAvailable: !!local && compareVersions(e.version, local.version) > 0,
        command: `npm run module:add -- ${e.key}`,
      };
    }),
  };
}
