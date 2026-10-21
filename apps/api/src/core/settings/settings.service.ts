import type { z } from 'zod';
import {
  brandingSchema,
  DEFAULT_BRANDING,
  SETTINGS_GROUPS,
  type Branding,
  type SettingsGroup,
} from '@app/shared';
import { db, type Db } from '../../db/knex';

/**
 * Settings are stored one row per group (`<group>` key) with a JSON value.
 * Reads are cached in-process for a few seconds; writes clear the cache.
 */
const TTL_MS = 3000;
const cache = new Map<string, { value: unknown; at: number }>();

export function clearSettingsCache() {
  cache.clear();
}

export async function getRaw(key: string, conn: Db = db): Promise<unknown> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const row = await conn('settings').where({ key }).first('value');
  const value = row ? (row.value as unknown) : undefined;
  cache.set(key, { value, at: Date.now() });
  return value;
}

export async function setRaw(
  key: string,
  group: string,
  value: unknown,
  opts: { isPublic?: boolean; userId?: number | null; conn?: Db } = {},
) {
  const conn = opts.conn ?? db;
  const json = JSON.stringify(value);
  await conn('settings')
    .insert({ key, group, value: json, is_public: opts.isPublic ?? false, updated_by: opts.userId ?? null })
    .onConflict('key')
    .merge({ value: json, updated_by: opts.userId ?? null, customized: true });
  cache.delete(key);
}

export async function getGroup<G extends SettingsGroup>(
  group: G,
  conn: Db = db,
): Promise<z.output<(typeof SETTINGS_GROUPS)[G]>> {
  const raw = (await getRaw(group, conn)) ?? {};
  return SETTINGS_GROUPS[group].parse(raw) as z.output<(typeof SETTINGS_GROUPS)[G]>;
}

export async function getBranding(conn: Db = db): Promise<Branding> {
  const raw = (await getRaw('branding', conn)) as Partial<Branding> | undefined;
  const merged = { ...DEFAULT_BRANDING, ...(raw ?? {}) };
  const parsed = brandingSchema.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULT_BRANDING;
}

export async function getBrandingAssets(conn: Db = db): Promise<Record<string, string>> {
  return ((await getRaw('branding.assets', conn)) as Record<string, string> | undefined) ?? {};
}

export async function isInstalled(conn: Db = db): Promise<boolean> {
  try {
    return (await getRaw('install', conn)) !== undefined;
  } catch {
    return false;
  }
}
