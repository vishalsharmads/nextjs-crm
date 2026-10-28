import { z } from 'zod';
import { entityKeySchema } from './entities';
import { filterSchema } from './filters';

/** A report someone builds: one record type, grouped by one field, measured by one metric. */
export const reportDefinitionSchema = z.object({
  entity: entityKeySchema,
  /** Field key to group by (`status`, `owner`, `stage`, `created_at`, `cf.<key>`). */
  groupBy: z.string().regex(/^(cf\.)?[a-z][a-z0-9_]{0,63}$/),
  /** Optional second grouping: each group is broken down by it (stacked bars, a matrix table). */
  groupBy2: z
    .string()
    .regex(/^(cf\.)?[a-z][a-z0-9_]{0,63}$/)
    .nullish(),
  /** Sum or average money in the workspace currency, using the saved exchange rates. */
  convert: z.boolean().optional(),
  /** For date fields: the bucket size. */
  dateBucket: z.enum(['day', 'week', 'month', 'quarter', 'year']).default('month'),
  metric: z.enum(['count', 'sum', 'avg']).default('count'),
  /** Number field for sum and average. */
  metricField: z
    .string()
    .regex(/^(cf\.)?[a-z][a-z0-9_]{0,63}$/)
    .nullish(),
  filter: filterSchema.nullish(),
  chart: z.enum(['bar', 'line', 'pie', 'table']).default('bar'),
});
export type ReportDefinition = z.infer<typeof reportDefinitionSchema>;

export const savedReportInputSchema = z.object({
  name: z.string().trim().min(1).max(150),
  definition: reportDefinitionSchema,
  /** Visible to everyone who may view the record type (needs `core.saved_views.share`). */
  shared: z.boolean().default(false),
});

export interface ReportResultDto {
  entity: string;
  rows: { key: string | null; label: string; value: number; breakdown?: Record<string, number> }[];
  /** Columns of the second grouping, when there is one. */
  series?: { key: string; label: string }[];
  total: number;
  /** Currencies left out of a converted report because they have no exchange rate. */
  missingRates?: string[];
}

export interface SavedReportDto {
  uuid: string;
  name: string;
  definition: ReportDefinition;
  shared: boolean;
  mine: boolean;
  updatedAt: string;
}
