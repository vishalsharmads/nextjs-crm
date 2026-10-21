import { z } from 'zod';
import { ENTITY_ROUTE, type CoreEntity } from '@app/shared';
import { defineRoutes } from '../../http/routes';
import { db } from '../../db/knex';
import { can } from '../rbac/access';
import { scopedQuery } from '../records/service';
import { applySearch } from '../records/filters';
import { recordDefs } from '../records/registry';
import { getGroup } from '../settings/settings.service';

const SEARCHABLE: { entity: CoreEntity; title: string; subtitle: string }[] = [
  { entity: 'contact', title: 'full_name', subtitle: 'email' },
  { entity: 'organization', title: 'name', subtitle: 'domain' },
  { entity: 'deal', title: 'title', subtitle: 'reference' },
  { entity: 'lead', title: 'full_name', subtitle: 'company_name' },
];

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
      SEARCHABLE.filter((s) => (!types || types.has(s.entity)) && (s.entity !== 'lead' || leads)).map(
        async (s) => {
          const def = recordDefs[s.entity];
          if (!can(user, `${def.resource}.view`)) return [];
          const { qb } = await scopedQuery(def, user, db);
          applySearch(qb, query.q, def);
          const rows = await qb
            .limit(query.limit)
            .select(
              `${def.table}.uuid`,
              `${def.table}.${s.title} as title`,
              `${def.table}.${s.subtitle} as subtitle`,
            );
          return rows.map((r) => ({
            type: s.entity,
            uuid: r.uuid,
            title: r.title || '(no name)',
            subtitle: r.subtitle ?? null,
            url: `/${ENTITY_ROUTE[s.entity]}/${r.uuid}`,
          }));
        },
      ),
    );
    return { data: results.flat() };
  },
});
