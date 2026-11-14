import {
  STANDARD_HIDEABLE,
  visibilitySchema,
  type FieldVisibility,
  type StandardFieldEntity,
  type StandardFieldLevels,
  type StandardFieldSpec,
  type VisibilityLevel,
} from '@app/shared';
import { db } from '../../db/knex';
import { AppError } from '../../lib/errors';
import type { AuthUser } from '../../http/context';
import { fieldLevel } from './definitions';
import type { ResourceDef } from '../records/types';

/**
 * Who sees and edits standard fields (deal value, contact email…). Stored per field; a field
 * without a row is writable by everyone who can edit the record, as before.
 */
let cache: { at: number; rows: Map<string, FieldVisibility> } | null = null;

export function clearStandardVisibilityCache() {
  cache = null;
}

async function stored(): Promise<Map<string, FieldVisibility>> {
  if (cache && Date.now() - cache.at < 5000) return cache.rows;
  const rows = await db('standard_field_visibility').select('entity', 'field', 'visibility');
  const map = new Map<string, FieldVisibility>();
  for (const r of rows) map.set(`${r.entity}.${r.field}`, visibilitySchema.parse(r.visibility));
  cache = { at: Date.now(), rows: map };
  return map;
}

export const isStandardEntity = (entity: string): entity is StandardFieldEntity =>
  entity in STANDARD_HIDEABLE;

/** Every configured visibility, for the settings screen. */
export async function standardVisibility(): Promise<Record<string, Record<string, FieldVisibility>>> {
  const out: Record<string, Record<string, FieldVisibility>> = {};
  for (const [key, v] of await stored()) {
    const [entity, field] = key.split('.') as [string, string];
    (out[entity] ??= {})[field] = v;
  }
  return out;
}

/** This person's level for each hideable standard field of a record type. */
export async function standardLevels(
  entity: string,
  user: Pick<AuthUser, 'isAdmin' | 'roleKeys'>,
): Promise<Record<string, VisibilityLevel>> {
  if (!isStandardEntity(entity)) return {};
  const rows = await stored();
  const out: Record<string, VisibilityLevel> = {};
  for (const spec of STANDARD_HIDEABLE[entity]) {
    const v = rows.get(`${entity}.${spec.field}`);
    out[spec.field] = v ? fieldLevel({ visibility: v }, user) : 'write';
  }
  return out;
}

/** Fields of a record type at a given level for this person. */
export async function standardFieldsAt(
  entity: string,
  user: Pick<AuthUser, 'isAdmin' | 'roleKeys'>,
  levels: VisibilityLevel[],
): Promise<StandardFieldSpec[]> {
  if (!isStandardEntity(entity)) return [];
  const lv = await standardLevels(entity, user);
  return STANDARD_HIDEABLE[entity].filter((s) => levels.includes(lv[s.field]!));
}

/** For the app shell: only fields that are not plain "write". */
export async function standardLevelsForBoot(
  user: Pick<AuthUser, 'isAdmin' | 'roleKeys'>,
): Promise<StandardFieldLevels> {
  const out: StandardFieldLevels = {};
  for (const entity of Object.keys(STANDARD_HIDEABLE) as StandardFieldEntity[]) {
    const lv = await standardLevels(entity, user);
    const restricted = Object.fromEntries(Object.entries(lv).filter(([, l]) => l !== 'write'));
    if (Object.keys(restricted).length) out[entity] = restricted;
  }
  return out;
}

/** Remove hidden standard fields from response objects (records, search hits, exports). */
export async function stripHidden<T>(entity: string, user: AuthUser | undefined, dtos: T[]): Promise<T[]> {
  if (!user || user.isAdmin || !isStandardEntity(entity)) return dtos;
  const hidden = await standardFieldsAt(entity, user, ['hidden']);
  if (!hidden.length) return dtos;
  for (const d of dtos) for (const s of hidden) Reflect.deleteProperty(d as object, s.dto);
  return dtos;
}

/**
 * Refuse writes to standard fields the person may only read or not see. On update only a changed
 * value counts, so forms that send the whole record keep working.
 */
export async function assertStandardWrite(
  entity: string,
  user: AuthUser,
  input: Record<string, unknown>,
  existing?: Record<string, unknown>,
) {
  if (user.isAdmin || !isStandardEntity(entity)) return;
  for (const s of await standardFieldsAt(entity, user, ['read', 'hidden'])) {
    if (!(s.input in input)) continue;
    const next = input[s.input];
    if (existing) {
      const before = existing[s.columns[0]!];
      const same = (before ?? null) === (next ?? null) || String(before ?? '') === String(next ?? '');
      if (same) continue;
    } else if (next === null || next === undefined || next === '') continue;
    throw new AppError('FIELD_FORBIDDEN', `You cannot change ${s.label}`, [
      { path: s.input, message: 'Not allowed' },
    ]);
  }
}

/** Column names (audit diffs) of standard fields hidden from this person. */
export async function hiddenColumns(entity: string, user: AuthUser): Promise<Set<string>> {
  if (user.isAdmin) return new Set();
  return new Set((await standardFieldsAt(entity, user, ['hidden'])).flatMap((s) => s.columns));
}

/**
 * Every response built from a record type's rows goes through `toDtos`: wrapping it once removes
 * hidden standard fields from lists, detail pages, boards, search, exports and tools alike.
 */
export function guardStandardFields<R extends Record<string, unknown>, D>(
  def: ResourceDef<R, D>,
): ResourceDef<R, D> {
  const build = def.toDtos.bind(def);
  def.toDtos = async (rows, ctx) => stripHidden(def.entity, ctx.user, await build(rows, ctx));
  return def;
}
