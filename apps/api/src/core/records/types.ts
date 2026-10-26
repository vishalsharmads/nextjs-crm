import type { Knex } from 'knex';
import type { z } from 'zod';
import type { CoreEntity, FilterCondition } from '@app/shared';
import type { AuthUser, RequestContext } from '../../http/context';
import type { Db } from '../../db/knex';

export type FieldKind = 'text' | 'number' | 'date' | 'datetime' | 'boolean' | 'select' | 'user' | 'relation';

/** A core (non-custom) field a list can filter, sort or search on. */
export interface CoreFieldSpec {
  kind: FieldKind;
  /** Fully-qualified SQL column (e.g. `contacts.email`). Omit when `filter`/`sortExpr` handle it. */
  column?: string;
  sortable?: boolean;
  filterable?: boolean;
  /** Raw SQL expression used for sorting when it differs from the column. */
  sortExpr?: string;
  /** Custom filter compiler (relations, tags, owner by uuid). */
  filter?: (qb: Knex.QueryBuilder, cond: FilterCondition, user: AuthUser) => void;
}

export interface ResourceDef<Row extends Record<string, unknown> = Record<string, unknown>, Dto = unknown> {
  entity: CoreEntity;
  table: string;
  /** Permission resource, e.g. `core.contacts`. */
  resource: string;
  /** Table has `merged_into_id`: merged-away rows are soft-deleted but are not in the trash. */
  mergeable?: boolean;
  /** Columns OR-ed for own/team scope. */
  ownerColumns: string[];
  /** Columns in the FULLTEXT index (MATCH ... AGAINST must list exactly these). */
  fulltext: string[];
  /** LIKE fallback columns for short search terms. */
  likeColumns: string[];
  fields: Record<string, CoreFieldSpec>;
  defaultSort: string;
  createSchema: z.ZodType;
  patchSchema: z.ZodType;
  /** Map validated core input to DB columns (async for lookups such as owner uuid → id). */
  toRow(input: Record<string, unknown>, ctx: WriteContext): Promise<Record<string, unknown>>;
  /** Build DTOs for a page of rows (batch-load relations). */
  toDtos(rows: Row[], ctx: ReadContext): Promise<Dto[]>;
  /** Column whose new holder is notified when it changes (owner, assignee). */
  notifyColumn?: string;
  /** Optional hooks. */
  beforeCreate?(row: Record<string, unknown>, ctx: WriteContext): Promise<void>;
  afterWrite?(
    id: number,
    input: Record<string, unknown>,
    ctx: WriteContext,
    op: 'create' | 'update',
  ): Promise<void>;
}

export interface ReadContext {
  user: AuthUser;
  conn: Db;
}

export interface WriteContext extends ReadContext {
  ctx: RequestContext;
  /** Existing row on update. */
  existing?: Record<string, unknown>;
}
