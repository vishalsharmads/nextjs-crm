import type { Knex } from 'knex';
import * as m0001 from './0001_access';
import * as m0002 from './0002_platform';
import * as m0003 from './0003_config';
import * as m0004 from './0004_crm_core';
import * as m0005 from './0005_audit_triggers';

export interface Migration {
  up(knex: Knex): Promise<void>;
  down(knex: Knex): Promise<void>;
}

/** Ordered core migrations. Append only — never edit or reorder a committed entry. */
export const coreMigrations: Record<string, Migration> = {
  '0001_access': m0001,
  '0002_platform': m0002,
  '0003_config': m0003,
  '0004_crm_core': m0004,
  '0005_audit_triggers': m0005,
};
