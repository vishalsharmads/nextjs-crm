import { z } from 'zod';
import { generatedColumnName, type CustomizableEntity, type RecordEntity } from '@app/shared';
import { defineRoutes } from '../../http/routes';
import { db } from '../../db/knex';
import { can } from '../rbac/access';
import { scopedQuery } from '../records/service';
import { escapeLike, fulltextQuery } from '../records/filters';
import { customizableEntities, getRecordDef, moduleRecordDefs, recordDefs } from '../records/registry';
import { recordBasePath } from '../records/paths';
import { snake } from '../records/record-type';
import type { ResourceDef } from '../records/types';
import { getGroup } from '../settings/settings.service';
import { fieldLevel, getDefinitions } from '../custom-fields/definitions';
import { plainText, searchText, snippetOf } from './text-search';
import { logAccess } from '../audit/access-log';
import type { AuthUser, RequestContext } from '../../http/context';

interface SearchProvider {
  entity: RecordEntity;
  def: ResourceDef;
  title: string;
  subtitle: string | null;
}

export interface SearchHit {
  type: string;
  uuid: string;
  title: string;
  subtitle: string | null;
  url: string | null;
  /** Relevance: higher is better. Exact and starts-with title matches rank first. */
  score: number;
  /** Set when the match was in a custom field: its label. */
  matched?: string;
}

/** Core entities plus searchable record types of enabled modules. */
function providers(): SearchProvider[] {
  return [
    { entity: 'contact', def: recordDefs.contact, title: 'full_name', subtitle: 'email' },
    { entity: 'organization', def: recordDefs.organization, title: 'name', subtitle: 'domain' },
    { entity: 'deal', def: recordDefs.deal, title: 'title', subtitle: 'reference' },
    { entity: 'lead', def: recordDefs.lead, title: 'full_name', subtitle: 'company_name' },
    ...moduleRecordDefs()
      .filter((d) => d.meta?.searchable)
      .map((d) => ({ entity: d.entity, def: d, title: snake(d.meta!.titleColumn), subtitle: null })),
  ];
}

/** Custom field types whose text people search for. */
const TEXT_TYPES = new Set(['text', 'email', 'phone', 'url']);

/**
 * Custom fields searched by prefix: text-like, filterable (so they have an indexed generated
 * column), not special-category, and visible to this person.
 */
async function searchableFields(def: ResourceDef, user: AuthUser) {
  if (!customizableEntities().includes(def.entity)) return [];
  const defs = (await getDefinitions(def.entity as CustomizableEntity)).filter(
    (d) =>
      TEXT_TYPES.has(d.type) &&
      d.filterable &&
      d.sensitivity !== 'special' &&
      fieldLevel(d, user) !== 'hidden',
  );
  if (!defs.length) return [];
  const rows = (await db('information_schema.columns')
    .where({ table_schema: db.raw('DATABASE()'), table_name: def.table })
    .where('column_name', 'like', 'cf\\_%')
    .select('column_name as name')) as { name: string }[];
  const cols = new Set(rows.map((r) => r.name.toLowerCase()));
  return defs
    .map((d) => ({ label: d.label, column: generatedColumnName(d.key) }))
    .filter((f) => cols.has(f.column.toLowerCase()));
}

async function searchProvider(
  s: SearchProvider,
  user: AuthUser,
  q: string,
  limit: number,
): Promise<SearchHit[]> {
  const def = s.def;
  const t = def.table;
  const select = [
    `${t}.uuid`,
    `${t}.${s.title} as title`,
    s.subtitle ? `${t}.${s.subtitle} as subtitle` : db.raw('NULL as subtitle'),
  ];
  const ft = fulltextQuery(q);
  const prefix = `${escapeLike(q)}%`;
  const fields = await searchableFields(def, user);

  // Two simple queries instead of one OR'd query, so each can use its own index.
  const fullText = async () => {
    if (!ft || !def.fulltext.length) return [];
    const { qb } = await scopedQuery(def, user, db);
    const match = `MATCH(${def.fulltext.map(() => '??').join(', ')}) AGAINST (? IN BOOLEAN MODE)`;
    return (await qb
      .whereRaw(match, [...def.fulltext, ft])
      .select([...select, db.raw(`${match} as ft_score`, [...def.fulltext, ft])])
      .orderBy('ft_score', 'desc')
      .limit(limit)) as Record<string, unknown>[];
  };
  const startsWith = async () => {
    const cols = def.likeColumns.length ? def.likeColumns : [`${t}.${s.title}`];
    const { qb } = await scopedQuery(def, user, db);
    qb.where((w) => {
      for (const c of cols) w.orWhere(c, 'like', prefix);
      for (const f of fields) w.orWhere(`${t}.${f.column}`, 'like', prefix);
    });
    const extra = fields.map((f) => db.raw(`?? as ??`, [`${t}.${f.column}`, `f_${f.column}`]));
    return (await qb.select([...select, ...extra]).limit(limit)) as Record<string, unknown>[];
  };
  const [a, b] = await Promise.all([fullText(), startsWith()]);

  const lower = q.toLowerCase();
  const hits = new Map<string, SearchHit>();
  const add = (r: Record<string, unknown>, score: number) => {
    const uuid = r.uuid as string;
    const title = String(r.title ?? '');
    const tl = title.toLowerCase();
    const bonus = tl === lower ? 100 : tl.startsWith(lower) ? 50 : 0;
    const matchedField = fields.find((f) => {
      const v = r[`f_${f.column}`];
      return typeof v === 'string' && v.toLowerCase().startsWith(lower);
    });
    const prev = hits.get(uuid);
    const total = score + bonus + (prev?.score ?? 0);
    hits.set(uuid, {
      type: s.entity,
      uuid,
      title: title || '(no name)',
      subtitle: (r.subtitle as string | null) ?? null,
      url: `${recordBasePath(def)}/${uuid}`,
      score: Math.round(total * 100) / 100,
      ...(prev?.matched || (matchedField && !bonus) ? { matched: prev?.matched ?? matchedField!.label } : {}),
    });
  };
  for (const r of a) add(r, Number(r.ft_score) || 1);
  for (const r of b) add(r, 10);
  return [...hits.values()].sort((x, y) => y.score - x.score).slice(0, limit);
}

/** Records whose comments match, as hits of the record's own type. */
async function searchComments(
  s: SearchProvider,
  user: AuthUser,
  q: string,
  limit: number,
): Promise<SearchHit[]> {
  if (q.length < 3) return [];
  const def = s.def;
  const t = def.table;
  const { qb } = await scopedQuery(def, user, db);
  const rows = (await qb
    .join('record_comments as rc', (j) => j.on('rc.record_id', `${t}.id`).andOnVal('rc.entity', def.entity))
    .whereRaw('MATCH(rc.body) AGAINST (? IN NATURAL LANGUAGE MODE)', [q])
    .select(
      `${t}.uuid`,
      `${t}.${s.title} as title`,
      'rc.body',
      db.raw('MATCH(rc.body) AGAINST (? IN NATURAL LANGUAGE MODE) as score', [q]),
    )
    .orderBy('score', 'desc')
    .limit(limit)) as Record<string, unknown>[];
  return rows.map((r) => ({
    type: s.entity,
    uuid: r.uuid as string,
    title: (r.title as string) || '(no name)',
    subtitle: `Comment: ${snippetOf(plainText(r.body as string), q, 80)}`,
    url: `${recordBasePath(def)}/${r.uuid as string}`,
    score: Math.round(Number(r.score) * 100) / 100,
  }));
}

/** Notes, emails, calls, meetings and tasks whose text matches, as search hits. */
async function searchActivities(user: AuthUser, q: string, limit: number) {
  if (q.length < 2 || !can(user, `${recordDefs.activity.resource}.view`)) return [];
  const { results } = await searchText(user, undefined, { query: q, limit: Math.min(limit, 25) });
  return results.map((r): SearchHit => {
    const relDef = r.related ? getRecordDef(r.related.type as RecordEntity) : undefined;
    const url =
      r.kind === 'task'
        ? `/tasks/${r.uuid}`
        : relDef && r.related
          ? `${recordBasePath(relDef)}/${r.related.uuid}`
          : null;
    return {
      type: 'activity',
      uuid: r.uuid,
      title: r.subject || r.snippet.slice(0, 80) || '(no subject)',
      subtitle: r.related?.name ? `${r.kind} · ${r.related.name}` : r.kind,
      url,
      score: r.score,
    };
  });
}

export const searchRoutes = defineRoutes('/search', ['search']).add({
  method: 'get',
  path: '/',
  permission: 'authenticated',
  summary: 'Global search across records the user can see, ranked by relevance',
  query: z.object({
    q: z.string().trim().min(1).max(200),
    types: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(5),
  }),
  handler: async ({ user, ctx, query }) => ({ data: await searchRecords(user, query, ctx) }),
});

/**
 * Records matching `q` that the user may see, across every searchable record type, plus
 * activities (type `activity`) unless `types` leaves them out. Each type returns up to `limit`
 * hits, best first.
 */
export async function searchRecords(
  user: AuthUser,
  query: { q: string; types?: string | undefined; limit: number },
  ctx?: RequestContext,
): Promise<SearchHit[]> {
  const types = query.types ? new Set(query.types.split(',')) : null;
  const { leads } = await getGroup('features');
  const results = await Promise.all([
    ...providers()
      .filter((s) => (!types || types.has(s.entity)) && (s.entity !== 'lead' || leads))
      .filter((s) => can(user, `${s.def.resource}.view`))
      .map(async (s) => {
        const [hits, comments] = await Promise.all([
          searchProvider(s, user, query.q, query.limit),
          searchComments(s, user, query.q, query.limit),
        ]);
        // A record found by name and by a comment appears once, by name.
        const seen = new Set(hits.map((h) => h.uuid));
        return [...hits, ...comments.filter((c) => !seen.has(c.uuid))].slice(0, query.limit);
      }),
    !types || types.has('activity') ? searchActivities(user, query.q, query.limit) : Promise.resolve([]),
  ]);
  const hits = results.flat();
  if (ctx) await logAccess(ctx, { action: 'view', entity: 'search', detail: { results: hits.length } });
  return hits;
}
