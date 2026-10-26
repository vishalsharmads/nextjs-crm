import type { DataSubjectEntity } from '@app/shared';
import type { Db } from '../../db/knex';

export interface DataSubject {
  entity: DataSubjectEntity;
  id: number;
  uuid: string;
  email: string | null;
}

export interface ErasureResult {
  /** Rows cleared or deleted, by area (for the erasure report). */
  cleared?: Record<string, number> | undefined;
  /** Data that had to be kept, and why (for example invoices kept for tax law). */
  retained?: { area: string; reason: string }[] | undefined;
}

/**
 * How a module takes part in data subject requests. Every module that stores data about a
 * contact or lead registers one, so access exports and erasure reach its tables too.
 */
export interface PrivacyHandler {
  /** Module key, used as the section name in exports. */
  key: string;
  /** The module's tables; the handler is skipped while the first one does not exist. */
  tables: string[];
  /** Everything the module holds about the person, as JSON-serializable rows per area. */
  export(subject: DataSubject, conn: Db): Promise<Record<string, unknown[] | undefined>>;
  /**
   * Remove or anonymize the person's data inside the erasure transaction. `mode` is
   * `anonymize` (keep records for reporting) or `delete` (the person's record is being deleted).
   */
  erase(subject: DataSubject, trx: Db, mode: 'anonymize' | 'delete'): Promise<ErasureResult>;
}

/** Module handlers whose tables exist (a module never enabled has no tables). */
export async function privacyHandlers(conn: Db): Promise<PrivacyHandler[]> {
  const { loadModules } = await import('../../modules/registry');
  const out: PrivacyHandler[] = [];
  for (const m of loadModules()) {
    const h = m.api?.privacy;
    if (h && (await conn.schema.hasTable(h.tables[0]!))) out.push(h);
  }
  return out;
}
