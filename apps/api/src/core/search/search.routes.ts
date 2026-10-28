import { z } from 'zod';
import type { RecordEntity } from '@app/shared';
import { defineRoutes } from '../../http/routes';
import { db } from '../../db/knex';
import { can } from '../rbac/access';
import { scopedQuery } from '../records/service';
import { applySearch } from '../records/filters';
import { moduleRecordDefs, recordDefs } from '../records/registry';
import { recordBasePath } from '../records/paths';
import { snake } from '../records/record-type';
import type { ResourceDef } from '../records/types';
import { getGroup } from '../settings/settings.service';

interface SearchProvider {
  entity: RecordEntity;
  def: ResourceDef;
  title: string;
  subtitle: string | null;
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

export const searchRoutes = defineRoutes('/search', ['search']).add({
  method: 'get',
  path: '/',
  permission: 'authenticated',
  summary: 'Global search across records the user can see',
  query: z.object({
    q: z.string().trim().min(1).max(200),
    types: z.string().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(20).default(5),
  }),
  handler: async ({ user, query }) => {
    const types = query.types ? new Set(query.types.split(',')) : null;
    const { leads } = await getGroup('features');
    const results = await Promise.all(
      providers()
        .filter((s) => (!types || types.has(s.entity)) && (s.entity !== 'lead' || leads))
        .map(async (s) => {
          const def = s.def;
          if (!can(user, `${def.resource}.view`)) return [];
          const { qb } = await scopedQuery(def, user, db);
          applySearch(qb, query.q, def);
          const rows = await qb
            .limit(query.limit)
            .select(
              `${def.table}.uuid`,
              `${def.table}.${s.title} as title`,
              s.subtitle ? `${def.table}.${s.subtitle} as subtitle` : db.raw('NULL as subtitle'),
            );
          return rows.map((r) => ({
            type: s.entity,
            uuid: r.uuid,
            title: r.title || '(no name)',
            subtitle: r.subtitle ?? null,
            url: `${recordBasePath(def)}/${r.uuid as string}`,
          }));
        }),
    );
    return { data: results.flat() };
  },
});
