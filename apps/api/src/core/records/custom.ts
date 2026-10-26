import { SENSITIVE_MASK, buildCustomSchema, type CustomFieldDef, type VisibilityLevel } from '@app/shared';
import { AppError } from '../../lib/errors';
import { decrypt, encrypt } from '../../lib/crypto';

/** Stored form of a special (sensitive) value: an encrypted string with a recognizable prefix. */
const ENC_PREFIX = 'enc:';
export const isEncryptedValue = (v: unknown): v is string =>
  typeof v === 'string' && v.startsWith(ENC_PREFIX);
export const encryptValue = (v: unknown) => `${ENC_PREFIX}${encrypt(JSON.stringify(v))}`;
export const decryptValue = (v: string): unknown => JSON.parse(decrypt(v.slice(ENC_PREFIX.length)));

/** Plain values for privileged paths (data subject export, lead conversion). */
export function decryptCustom(custom: unknown): Custom {
  const src = (custom && typeof custom === 'object' ? custom : {}) as Custom;
  return Object.fromEntries(
    Object.entries(src).map(([k, v]) => {
      if (!isEncryptedValue(v)) return [k, v];
      try {
        return [k, decryptValue(v)];
      } catch {
        return [k, '[unreadable]'];
      }
    }),
  );
}

type Custom = Record<string, unknown>;

/**
 * Validate and merge a `custom` patch for a write.
 * - fields the user cannot write → FIELD_FORBIDDEN
 * - values validated with the runtime schema (create: required + defaults for writable fields)
 * - null / empty clears a value by removing the key (JSON null is never stored)
 */
export function prepareCustom(
  defs: CustomFieldDef[],
  levels: Record<string, VisibilityLevel>,
  input: Custom | undefined,
  mode: 'create' | 'patch',
  existing: Custom = {},
): Custom {
  const special = new Set(defs.filter((d) => d.sensitivity === 'special').map((d) => d.key));
  // The mask comes back from forms that loaded a masked value: it means "unchanged".
  const patch = Object.fromEntries(
    Object.entries(input ?? {}).filter(([k, v]) => !(special.has(k) && v === SENSITIVE_MASK)),
  );
  for (const key of Object.keys(patch)) {
    const def = defs.find((d) => d.key === key);
    if (def && levels[key] !== 'write') {
      throw new AppError('FIELD_FORBIDDEN', `You cannot change ${def.label}`, [
        { path: `custom.${key}`, message: 'Read-only for your role' },
      ]);
    }
  }
  if (mode === 'create') {
    for (const def of defs) {
      if (patch[def.key] === undefined && def.defaultValue !== null && def.defaultValue !== undefined)
        patch[def.key] = def.defaultValue;
    }
  }
  // Treat empty strings and empty arrays as "clear".
  for (const [k, v] of Object.entries(patch)) {
    if (v === '' || (Array.isArray(v) && v.length === 0)) patch[k] = null;
  }
  // The `enc:` prefix marks stored ciphertext, so people cannot type it into ordinary fields.
  for (const [k, v] of Object.entries(patch))
    if (!special.has(k) && isEncryptedValue(v))
      throw new AppError('VALIDATION_FAILED', 'This value cannot start with "enc:"', [
        { path: `custom.${k}`, message: 'Values cannot start with "enc:"' },
      ]);
  const writable = defs.filter((d) => levels[d.key] === 'write');
  // Required fields are only enforced for people who can actually fill them in.
  const schema = buildCustomSchema(
    defs.map((d) => (writable.includes(d) ? d : { ...d, required: false })),
    mode,
  );
  const result = schema.safeParse(patch);
  if (!result.success) {
    throw new AppError(
      'VALIDATION_FAILED',
      'Some fields need attention',
      result.error.issues.map((i) => {
        const key = String(i.path[0] ?? '');
        const label = defs.find((d) => d.key === key)?.label ?? key;
        const message =
          i.code === 'unrecognized_keys'
            ? `Unknown field: ${(i as { keys?: string[] }).keys?.join(', ')}`
            : i.code === 'invalid_type' && i.input === undefined
              ? `${label} is required`
              : i.message;
        return { path: key ? `custom.${key}` : 'custom', message };
      }),
    );
  }
  const changes = result.data as Custom;
  const cleared = new Set(
    Object.entries(changes)
      .filter(([, v]) => v === null || v === undefined)
      .map(([k]) => k),
  );
  const merged: Custom = Object.fromEntries(Object.entries(existing).filter(([k]) => !cleared.has(k)));
  for (const [k, v] of Object.entries(changes)) {
    if (cleared.has(k)) continue;
    const def = defs.find((d) => d.key === k);
    const value = def?.type === 'datetime' ? new Date(String(v)).toISOString() : v;
    merged[k] = special.has(k) ? encryptValue(value) : value;
  }
  return merged;
}

/** Strip hidden and archived fields from a stored `custom` object before it leaves the API. */
export function serializeCustom(
  custom: unknown,
  defs: CustomFieldDef[],
  levels: Record<string, VisibilityLevel>,
): Custom {
  const src = (custom && typeof custom === 'object' ? custom : {}) as Custom;
  const out: Custom = {};
  for (const def of defs) {
    if (levels[def.key] === 'hidden') continue;
    if (src[def.key] === undefined || src[def.key] === null) continue;
    // Sensitive values never leave in normal responses; reveal is a separate, logged request.
    out[def.key] = def.sensitivity === 'special' ? SENSITIVE_MASK : src[def.key];
  }
  return out;
}

/** Remove hidden custom keys from an audit diff (keys look like `custom.<key>`). */
export function redactDiff(diff: Record<string, unknown>, levels: Record<string, VisibilityLevel>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(diff)) {
    if (k.startsWith('custom.') && levels[k.slice(7)] === 'hidden') continue;
    if (k === 'custom' && v && typeof v === 'object') {
      out[k] = Object.fromEntries(Object.entries(v as object).filter(([ck]) => levels[ck] !== 'hidden'));
      continue;
    }
    out[k] = v;
  }
  return out;
}

/** Replace encrypted values in a diff or record with the mask (audit log, webhooks, timeline). */
export function maskEncrypted<T>(value: T): T {
  if (isEncryptedValue(value)) return SENSITIVE_MASK as T;
  if (Array.isArray(value)) return value.map(maskEncrypted) as T;
  if (value && typeof value === 'object' && !(value instanceof Date))
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskEncrypted(v)])) as T;
  return value;
}
