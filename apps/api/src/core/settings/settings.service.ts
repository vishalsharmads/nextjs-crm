import { env } from '../../config/env';
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

export interface DemoAccount {
  label: string;
  email: string;
  password: string;
}

/** The industry a demo instance shows (set by `demo:reset`), only while DEMO_MODE=true. */
export async function getDemoIndustry(conn: Db = db): Promise<string | null> {
  if (!env.DEMO_MODE) return null;
  const v = (await getRaw('demo', conn)) as { industry?: string } | undefined;
  return v?.industry ?? null;
}

/**
 * Demo accounts for the sign-in screen. Two switches must both be on:
 * `DEMO_MODE=true` in the environment, and accounts stored by `npm run cli -- demo:seed` (or `demo:enable`).
 * Flipping the env off hides them without touching the database.
 */
export async function getDemoAccounts(conn: Db = db): Promise<DemoAccount[]> {
  if (!env.DEMO_MODE) return [];
  const v = (await getRaw('demo_login', conn)) as
    { accounts?: DemoAccount[]; enabled?: boolean; email?: string; password?: string } | undefined;
  if (!v) return [];
  if (Array.isArray(v.accounts)) return v.accounts.filter((a) => a.email && a.password);
  // Single-account shape written by earlier versions of demo:enable.
  return v.enabled && v.email && v.password ? [{ label: 'Admin', email: v.email, password: v.password }] : [];
}
