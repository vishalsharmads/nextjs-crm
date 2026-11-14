import { z } from 'zod';
import { ACTIVITY_TYPES, RELATED_TYPES } from '@app/shared';
import { db } from '../../db/knex';
import type { AuthUser, RequestContext } from '../../http/context';
import { AppError } from '../../lib/errors';
import { assertCan } from '../rbac/access';
import { recordDefs } from '../records/registry';
import { scopedQuery } from '../records/service';
import { RELATED_TABLE } from '../activities/activities.def';
import { logAccess } from '../audit/access-log';

/**
 * Full-text search over what people wrote: notes, emails, calls, meetings and tasks (subject and
 * text) and comments on them, through MySQL's FULLTEXT indexes (8.4+, no extensions). It runs as
 * the person with the activity screens' own scope, so it finds only what they could open there.
 */
export const textSearchSchema = z.object({
  query: z.string().trim().min(2).max(200).describe('Words to look for; quote a phrase to match it exactly'),
  types: z
    .array(z.enum(ACTIVITY_TYPES))
    .max(5)
    .optional()
    .describe('Only these kinds: note, email, call, meeting, task'),
  related: z
    .object({ type: z.enum(RELATED_TYPES), uuid: z.uuid() })
    .optional()
    .describe('Only what belongs to this contact, organization, deal or lead'),
  since: z.iso.date().optional().describe('Only from this day on (YYYY-MM-DD)'),
  limit: z.number().int().min(1).max(25).default(10),
});
export type TextSearchInput = z.infer<typeof textSearchSchema>;

export interface TextHit {
  /** The activity (or the activity a comment is on). */
  uuid: string;
  kind: string;
  /** Where the match is: the activity itself, or a comment on it. */
  in: 'activity' | 'comment';
  subject: string | null;
  snippet: string;
  date: string;
  related: { type: string; uuid: string; name: string | null } | null;
  score: number;
}

/** HTML as plain text, for snippets. */
export function plainText(html: string | null | undefined): string {
  return (html ?? '')
    .replace(/<(br|\/p|\/div|\/li|\/h\d)[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** About 300 characters around the first word of the query found in the text. */
export function snippetOf(text: string, query: string, size = 300): string {
  const words = query
    .toLowerCase()
    .replace(/["+\-*~<>()]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3);
  const lower = text.toLowerCase();
  const at =
    words
      .map((w) => lower.indexOf(w))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, at - Math.floor(size / 3));
  const end = Math.min(text.length, start + size);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

/**
 * The query as MySQL reads it: natural language (relevance) by default, boolean mode when the
 * person quoted a phrase or used + and -, so "exact words" and -exclusions work.
 */
function matchMode(query: string) {
  return /["+-]/.test(query) ? 'IN BOOLEAN MODE' : 'IN NATURAL LANGUAGE MODE';
}

export async function searchText(
  user: AuthUser,
  /** Without a context (global search logs its own access entry) nothing is logged here. */
  ctx: RequestContext | undefined,
  raw: unknown,
): Promise<{ results: TextHit[] }> {
  const input = textSearchSchema.parse(raw);
  const def = recordDefs.activity;
  assertCan(user, `${def.resource}.view`);
  const mode = matchMode(input.query);

  let relatedId: number | undefined;
  if (input.related) {
    const row = await db(RELATED_TABLE[input.related.type].table)
      .where({ uuid: input.related.uuid })
      .first('id');
    if (!row) throw new AppError('NOT_FOUND', 'That record was not found');
    relatedId = row.id as number;
  }
  const narrow = (qb: ReturnType<typeof db>) => {
    if (input.types?.length) qb.whereIn('activities.type', input.types);
    if (input.related)
      qb.where({ 'activities.related_type': input.related.type, 'activities.related_id': relatedId });
    if (input.since) qb.where('activities.updated_at', '>=', `${input.since} 00:00:00`);
  };

  // The activities themselves: subject and text.
  const { qb: own } = await scopedQuery(def, user);
  narrow(own);
  own
    .whereRaw(`MATCH(activities.subject, activities.body) AGAINST (? ${mode})`, [input.query])
    .select(
      'activities.id',
      'activities.uuid',
      'activities.type',
      'activities.subject',
      'activities.body',
      'activities.related_type',
      'activities.related_id',
      'activities.updated_at',
      db.raw(`MATCH(activities.subject, activities.body) AGAINST (? ${mode}) as score`, [input.query]),
    )
    .orderBy('score', 'desc')
    .limit(input.limit);

  // Comments, on activities the person may see.
  const { qb: comments } = await scopedQuery(def, user);
  narrow(comments);
  comments
    .join('activity_comments as c', 'c.activity_id', 'activities.id')
    .whereNull('c.deleted_at')
    .whereRaw(`MATCH(c.body) AGAINST (? ${mode})`, [input.query])
    .select(
      'activities.id',
      'activities.uuid',
      'activities.type',
      'activities.subject',
      'c.body',
      'activities.related_type',
      'activities.related_id',
      'c.created_at as updated_at',
      db.raw(`MATCH(c.body) AGAINST (? ${mode}) as score`, [input.query]),
    )
    .orderBy('score', 'desc')
    .limit(input.limit);

  const [a, c] = await Promise.all([own, comments]);
  type Row = Record<string, unknown> & { in: 'activity' | 'comment' };
  const rows: Row[] = [
    ...(a as Record<string, unknown>[]).map((r): Row => ({ ...r, in: 'activity' })),
    ...(c as Record<string, unknown>[]).map((r): Row => ({ ...r, in: 'comment' })),
  ]
    .sort((x, y) => Number(y.score) - Number(x.score))
    .slice(0, input.limit);

  // Names of the records the matches belong to, one query per type.
  const names = new Map<string, { uuid: string; name: string | null }>();
  for (const type of RELATED_TYPES) {
    const ids = [...new Set(rows.filter((r) => r.related_type === type).map((r) => r.related_id as number))];
    if (!ids.length) continue;
    const t = RELATED_TABLE[type];
    for (const r of await db(t.table).whereIn('id', ids).select('id', 'uuid', `${t.title} as name`))
      names.set(`${type}:${r.id}`, { uuid: r.uuid as string, name: (r.name as string | null) ?? null });
  }

  if (ctx)
    await logAccess(ctx, {
      action: 'view',
      entity: 'activity',
      detail: { search: 'text', results: rows.length },
    });
  return {
    results: rows.map((r) => {
      const rel = r.related_type ? names.get(`${r.related_type}:${r.related_id}`) : undefined;
      return {
        uuid: r.uuid as string,
        kind: r.type as string,
        in: r.in,
        subject: (r.subject as string | null) ?? null,
        snippet: snippetOf(plainText(r.body as string | null), input.query),
        date: new Date(r.updated_at as string | Date).toISOString(),
        related: rel ? { type: r.related_type as string, ...rel } : null,
        score: Math.round(Number(r.score) * 100) / 100,
      };
    }),
  };
}
