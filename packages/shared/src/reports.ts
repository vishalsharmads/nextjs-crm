import { z } from 'zod';

const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');

export const reportQuerySchema = z.object({
  pipelineUuid: z.uuid().optional(),
  /** Deal currency to report on; deals in other currencies are left out. Defaults to the workspace currency. */
  currency: z.string().length(3).optional(),
  /** Convert every currency into the workspace currency with the saved exchange rates. */
  convert: z.stringbool().optional(),
});

export const exchangeRatesInputSchema = z.object({
  /** Units of the workspace currency per one unit of each currency. Missing currencies are removed. */
  rates: z.record(z.string().regex(/^[A-Z]{3}$/), z.number().min(1e-8).max(1e9)),
});

export interface ExchangeRatesDto {
  base: string;
  rates: Record<string, number>;
  updatedAt: string | null;
}

export const forecastQuerySchema = reportQuerySchema.extend({
  months: z.coerce.number().int().min(1).max(12).default(6),
});

export const velocityQuerySchema = reportQuerySchema.extend({
  days: z.coerce.number().int().min(7).max(730).default(90),
});

export const quotaQuerySchema = z.object({
  period,
  currency: z.string().length(3).optional(),
  convert: z.stringbool().optional(),
});
export const quotaInputSchema = z.object({
  userUuid: z.uuid(),
  period,
  /** Null removes the quota. */
  amount: z.number().min(0).max(1e13).nullable(),
});

export interface ForecastDto {
  currency: string;
  /** Currencies left out of a converted report because they have no exchange rate. */
  missingRates?: string[];
  /** Open deals whose expected close date has passed. */
  overdue: { count: number; value: number; weighted: number };
  months: { month: string; count: number; value: number; weighted: number; won: number }[];
  /** Open deals with no expected close date. */
  undated: { count: number; value: number };
}

export interface QuotaRowDto {
  user: { uuid: string; name: string };
  quota: number | null;
  won: number;
  /** won / quota, 0–n, null without a quota. */
  attainment: number | null;
  openPipeline: number;
}

export interface VelocityDto {
  currency: string;
  /** Currencies left out of a converted report because they have no exchange rate. */
  missingRates?: string[];
  days: number;
  won: number;
  lost: number;
  winRate: number | null;
  avgWonValue: number | null;
  avgCycleDays: number | null;
  open: number;
  /** Expected value won per day: open × win rate × average won value ÷ cycle days. */
  velocityPerDay: number | null;
  stages: { uuid: string; name: string; avgDays: number | null; entered: number }[];
}
