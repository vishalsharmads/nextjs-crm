import type { Knex } from 'knex';
import type { TagDto, UserRef } from '@app/shared';
import { db, type Db } from '../../db/knex';
import { AppError } from '../../lib/errors';
import { newUuid } from '../../lib/ids';
import type { AuthUser } from '../../http/context';

export const iso = (d: unknown): string | null => (d ? new Date(d as string).toISOString() : null);

/** Batch-load user references by internal id. */
export async function userRefs(
  ids: (number | null | undefined)[],
  conn: Db = db,
): Promise<Map<number, UserRef>> {
  const unique = [...new Set(ids.filter((i): i is number => typeof i === 'number'))];
  if (!unique.length) return new Map();
  const rows = await conn('users')
    .whereIn('id', unique)
    .select('id', 'uuid', 'first_name', 'last_name', 'email');
  return new Map(
    rows.map((r) => [
      r.id as number,
      { uuid: r.uuid, name: `${r.first_name} ${r.last_name}`.trim() || r.email },
    ]),
  );
}

/** Resolve a user uuid ('@me' allowed) to an id; null clears. Throws on unknown users. */
export async function userIdFromRef(
  ref: string | null | undefined,
  me: AuthUser,
  conn: Db = db,
): Promise<number | null | undefined> {
  if (ref === undefined) return undefined;
  if (ref === null) return null;
  if (ref === '@me') return me.id;
  const row = await conn('users').where({ uuid: ref }).whereNull('deleted_at').first('id');
  if (!row)
    throw new AppError('VALIDATION_FAILED', 'Unknown user', [{ path: 'ownerUuid', message: 'Unknown user' }]);
  return row.id as number;
}

/** Look up a record id by uuid within a table (used for relation inputs). */
export async function idFromUuid(
  table: string,
  uuid: string | null | undefined,
  field: string,
  conn: Db = db,
): Promise<number | null | undefined> {
  if (uuid === undefined) return undefined;
  if (uuid === null) return null;
  const row = await conn(table).where({ uuid }).whereNull('deleted_at').first('id');
  if (!row) throw new AppError('VALIDATION_FAILED', 'Not found', [{ path: field, message: 'Not found' }]);
  return row.id as number;
}

export async function tagsFor(type: string, ids: number[], conn: Db = db): Promise<Map<number, TagDto[]>> {
  const out = new Map<number, TagDto[]>();
  if (!ids.length) return out;
  const rows = await conn('taggables as tg')
    .join('tags as t', 't.id', 'tg.tag_id')
    .where('tg.taggable_type', type)
    .whereIn('tg.taggable_id', ids)
    .orderBy('t.name')
    .select('tg.taggable_id', 't.uuid', 't.name', 't.slug', 't.color');
  for (const r of rows) {
    const list = out.get(r.taggable_id) ?? [];
    list.push({ uuid: r.uuid, name: r.name, slug: r.slug, color: r.color });
    out.set(r.taggable_id, list);
  }
  return out;
}

export const slugify = (s: string) =>
  s
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'tag';

/** Create missing tags by name and return their ids. Creating tags needs `core.tags.manage` unless they exist. */
export async function ensureTags(names: string[], user: AuthUser, conn: Db): Promise<number[]> {
  const ids: number[] = [];
  for (const name of [...new Set(names.map((n) => n.trim()).filter(Boolean))]) {
    const slug = slugify(name);
    const existing = await conn('tags').where({ slug }).first('id');
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    if (
      !user.isAdmin &&
      !user.permissions.some((p) => p === 'core.tags.manage' || p === 'core.tags.*' || p === '*')
    ) {
      throw new AppError('FORBIDDEN', `Tag "${name}" does not exist and you cannot create tags`);
    }
    const [id] = await conn('tags').insert({ uuid: newUuid(), name, slug });
    ids.push(id!);
  }
  return ids;
}

export async function setTags(type: string, id: number, names: string[], user: AuthUser, conn: Db) {
  const tagIds = await ensureTags(names, user, conn);
  await conn('taggables').where({ taggable_type: type, taggable_id: id }).delete();
  if (tagIds.length)
    await conn('taggables').insert(
      tagIds.map((tag_id) => ({ tag_id, taggable_type: type, taggable_id: id })),
    );
}

export function tagsFilter(type: string, table: string) {
  return (qb: Knex.QueryBuilder, cond: { op: string; value?: unknown }) => {
    const values = (Array.isArray(cond.value) ? cond.value : [cond.value]).filter(Boolean).map(String);
    const sub = (q: Knex.QueryBuilder) =>
      q
        .select(db.raw('1'))
        .from('taggables as tg')
        .join('tags as t', 't.id', 'tg.tag_id')
        .where('tg.taggable_type', type)
        .whereRaw('tg.taggable_id = ??', [`${table}.id`])
        .where((w) => w.whereIn('t.slug', values).orWhereIn('t.uuid', values));
    if (cond.op === 'nin' || cond.op === 'neq') qb.whereNotExists(sub);
    else if (cond.op === 'is_empty')
      qb.whereNotExists((q) =>
        q
          .select(db.raw('1'))
          .from('taggables as tg')
          .where('tg.taggable_type', type)
          .whereRaw('tg.taggable_id = ??', [`${table}.id`]),
      );
    else if (cond.op === 'is_not_empty')
      qb.whereExists((q) =>
        q
          .select(db.raw('1'))
          .from('taggables as tg')
          .where('tg.taggable_type', type)
          .whereRaw('tg.taggable_id = ??', [`${table}.id`]),
      );
    else qb.whereExists(sub);
  };
}
