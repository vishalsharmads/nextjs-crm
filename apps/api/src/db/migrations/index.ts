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
import * as m0011 from './0011_privacy';
import * as m0012 from './0012_encryption';
import * as m0013 from './0013_open_entities';
import * as m0014 from './0014_lead_pipeline';
import * as m0015 from './0015_custom_objects';
import * as m0016 from './0016_access_tokens';
import * as m0017 from './0017_sales_quotas';
import * as m0018 from './0018_automation_timing';
import * as m0019 from './0019_assign_cursor';
import * as m0020 from './0020_exchange_rates';
import * as m0021 from './0021_mcp_oauth';
import * as m0022 from './0022_oauth_families';
import * as m0023 from './0023_activity_comments';
import * as m0024 from './0024_activity_checklists';
import * as m0025 from './0025_activity_recurrence';
import * as m0026 from './0026_task_pipeline';

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
  '0011_privacy': m0011,
  '0012_encryption': m0012,
  '0013_open_entities': m0013,
  '0014_lead_pipeline': m0014,
  '0015_custom_objects': m0015,
  '0016_access_tokens': m0016,
  '0017_sales_quotas': m0017,
  '0018_automation_timing': m0018,
  '0019_assign_cursor': m0019,
  '0020_exchange_rates': m0020,
  '0021_mcp_oauth': m0021,
  '0022_oauth_families': m0022,
  '0023_activity_comments': m0023,
  '0024_activity_checklists': m0024,
  '0025_activity_recurrence': m0025,
  '0026_task_pipeline': m0026,
};
