import { z } from 'zod';

export const FILTER_OPS = [
  'eq',
  'neq',
  'in',
  'nin',
  'contains',
  'starts_with',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'is_empty',
  'is_not_empty',
  'within_last_days',
  'within_next_days',
  'today',
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

const scalar = z.union([z.string().max(500), z.number(), z.boolean()]);

export const filterConditionSchema = z.object({
  field: z.string().max(80),
  op: z.enum(FILTER_OPS),
  value: z.union([scalar, z.array(scalar).max(200), z.null()]).optional(),
});
export type FilterCondition = z.infer<typeof filterConditionSchema>;

export type FilterNode = FilterCondition | { and: FilterNode[] } | { or: FilterNode[] };

const MAX_DEPTH = 3;

function nodeSchema(depth: number): z.ZodType<FilterNode> {
  if (depth >= MAX_DEPTH) return filterConditionSchema;
  const child = z.lazy(() => nodeSchema(depth + 1));
  return z.union([
    filterConditionSchema,
    z.object({ and: z.array(child).max(50) }),
    z.object({ or: z.array(child).max(50) }),
  ]) as z.ZodType<FilterNode>;
}

export const filterSchema: z.ZodType<FilterNode> = nodeSchema(0);

export function isGroup(node: FilterNode): node is { and: FilterNode[] } | { or: FilterNode[] } {
  return 'and' in node || 'or' in node;
}

/** Parse the `filter` query param (URL-encoded JSON). */
export const filterParamSchema = z
  .string()
  .max(8000)
  .transform((s, ctx) => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'filter must be JSON' });
      return z.NEVER;
    }
  })
  .pipe(filterSchema);

export const sortParamSchema = z
  .string()
  .max(200)
  .regex(/^-?[a-z][a-z0-9_.]*(,-?[a-z][a-z0-9_.]*)*$/);

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: sortParamSchema.optional(),
  filter: filterParamSchema.optional(),
  q: z.string().trim().max(200).optional(),
  view: z.uuid().optional(),
  trashed: z.enum(['only', 'with']).optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export interface SortSpec {
  field: string;
  dir: 'asc' | 'desc';
}

export function parseSort(sort: string | undefined): SortSpec[] {
  if (!sort) return [];
  return sort
    .split(',')
    .map((s) => (s.startsWith('-') ? { field: s.slice(1), dir: 'desc' } : { field: s, dir: 'asc' }));
}
