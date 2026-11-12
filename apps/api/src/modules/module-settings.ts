import { z } from 'zod';
import type { ModuleSettingField } from '@app/module-sdk';
import { db, type Db } from '../db/knex';
import { decrypt, encrypt } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { getModule } from './registry';

/**
 * Module settings: the fields a manifest declares, stored in `module_states.settings`.
 * Secrets are encrypted at rest and leave the API only as `{ set: true }`.
 */

export type SettingValue = string | number | boolean;
export type SecretState = { set: boolean };

export const secretAad = (moduleKey: string, field: string) => `module_states.settings.${moduleKey}.${field}`;

function fieldsOf(key: string): ModuleSettingField[] {
  const mod = getModule(key);
  if (!mod) throw new AppError('NOT_FOUND', `Module "${key}" is not installed`);
  return mod.manifest.settings;
}

function valueSchema(f: ModuleSettingField) {
  switch (f.type) {
    case 'boolean':
      return z.boolean();
    case 'number':
      return z.number().finite();
    case 'select':
      return z.enum(f.options!.map((o) => o.value) as [string, ...string[]]);
    case 'url':
      return z.url({ protocol: /^https?$/ }).max(2000);
    case 'secret':
      return z.string().min(1).max(4000);
    default:
      return z.string().max(2000);
  }
}

/** PATCH body: a missing field keeps its value, `null` clears it. */
export function settingsPatchSchema(fields: ModuleSettingField[]) {
  return z
    .object(Object.fromEntries(fields.map((f) => [f.key, valueSchema(f).nullable().optional()])))
    .strict();
}

async function readStored(key: string, conn: Db): Promise<Record<string, SettingValue>> {
  const row = await conn('module_states').where({ module_key: key }).first('settings');
  const raw: unknown = row?.settings;
  const obj = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  return obj && typeof obj === 'object' ? (obj as Record<string, SettingValue>) : {};
}

const cache = new Map<string, { value: Record<string, SettingValue>; at: number }>();
export const clearModuleSettingsCache = () => cache.clear();

/** Values with defaults applied and secrets decrypted. For module code only; never send this to a client. */
export async function getModuleSettings(key: string, conn: Db = db): Promise<Record<string, SettingValue>> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 5000) return hit.value;
  const stored = await readStored(key, conn);
  const out: Record<string, SettingValue> = {};
  for (const f of fieldsOf(key)) {
    const v = stored[f.key];
    if (v === undefined) {
      if (f.default !== undefined) out[f.key] = f.default;
    } else out[f.key] = f.type === 'secret' ? decrypt(String(v), secretAad(key, f.key)) : v;
  }
  cache.set(key, { value: out, at: Date.now() });
  return out;
}

/** What admins see: values with defaults, secrets as `{ set }`. */
export async function moduleSettingsDto(key: string, conn: Db = db) {
  const fields = fieldsOf(key);
  const stored = await readStored(key, conn);
  const values: Record<string, SettingValue | SecretState | null> = {};
  for (const f of fields) {
    const v = stored[f.key];
    values[f.key] = f.type === 'secret' ? { set: v !== undefined } : (v ?? f.default ?? null);
  }
  const missing = fields.filter((f) => f.required && f.default === undefined && stored[f.key] === undefined);
  return { fields, values, configured: missing.length === 0 };
}

/**
 * Apply a PATCH. Returns the audit diff: changed keys with old and new values, secrets as `[changed]`.
 * Required fields must have a value once saved.
 */
export async function saveModuleSettings(conn: Db, key: string, body: unknown) {
  const fields = fieldsOf(key);
  const patch = settingsPatchSchema(fields).parse(body) as Record<string, SettingValue | null | undefined>;
  const stored = await readStored(key, conn);
  const next = { ...stored };
  const diff: Record<string, { from: unknown; to: unknown } | '[changed]'> = {};
  for (const f of fields) {
    const v = patch[f.key];
    if (v === undefined) continue;
    if (v === null) {
      if (stored[f.key] === undefined) continue;
      Reflect.deleteProperty(next, f.key);
    } else if (f.type === 'secret') next[f.key] = encrypt(String(v), secretAad(key, f.key));
    else if (v === stored[f.key]) continue;
    else next[f.key] = v;
    diff[f.key] = f.type === 'secret' ? '[changed]' : { from: stored[f.key] ?? null, to: v };
  }
  const missing = fields.filter((f) => f.required && f.default === undefined && next[f.key] === undefined);
  if (missing.length)
    throw new AppError('VALIDATION_FAILED', `${missing.map((f) => f.label).join(', ')} is required`, {
      fields: missing.map((f) => f.key),
    });
  await conn('module_states')
    .insert({ module_key: key, enabled: false, settings: JSON.stringify(next) })
    .onConflict('module_key')
    .merge({ settings: JSON.stringify(next) });
  cache.delete(key);
  return diff;
}

/** Stored values with an unsaved PATCH laid over them (for Test connection before saving). */
export async function previewModuleSettings(key: string, body: unknown) {
  const fields = fieldsOf(key);
  const patch = settingsPatchSchema(fields).parse(body) as Record<string, SettingValue | null | undefined>;
  cache.delete(key);
  const out = { ...(await getModuleSettings(key)) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) Reflect.deleteProperty(out, k);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}
