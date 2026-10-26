import type { Knex } from 'knex';
import * as m0001 from './0001_access';
import * as m0002 from './0002_platform';
import * as m0003 from './0003_config';
import * as m0004 from './0004_crm_core';
import * as m0005 from './0005_audit_triggers';
import * as m0006 from './0006_auth_hardening';
import * as m0007 from './0007_phase2';
import * as m0008 from './0008_commerce';
import * as m0009 from './0009_compliance_auth';
import * as m0010 from './0010_access_audit';

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
  '0006_auth_hardening': m0006,
  '0007_phase2': m0007,
  '0008_commerce': m0008,
  '0009_compliance_auth': m0009,
  '0010_access_audit': m0010,
};
