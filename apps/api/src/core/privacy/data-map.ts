import { CUSTOMIZABLE_ENTITIES, type CustomizableEntity, type Sensitivity } from '@app/shared';
import { env } from '../../config/env';
import { db } from '../../db/knex';
import { ENTITY_TABLE, getDefinitions } from '../custom-fields/definitions';
import { effectiveCompliance } from '../settings/settings.service';
import { privacyHandlers } from './handlers';

/** Built-in personal data per record type (the columns, in plain words). */
const CORE_PERSONAL: Record<CustomizableEntity, string[]> = {
  contact: [
    'Name',
    'Email',
    'Phone',
    'Job title',
    'Photo',
    'Links to other records',
    'Source',
    'Lifecycle status',
  ],
  lead: ['Name', 'Email', 'Phone', 'Company', 'Job title', 'Source'],
  organization: ['Name', 'Email', 'Phone', 'Address', 'Website'],
  deal: ['Linked person', 'Value', 'Notes'],
  activity: ['Subject', 'Notes and email bodies', 'Email addresses (email copies)'],
};

export interface DataMapDto {
  profile: string;
  records: {
    entity: CustomizableEntity;
    rows: number;
    coreFields: string[];
    customFields: { key: string; label: string; sensitivity: Sensitivity }[];
  }[];
  modules: { key: string; tables: string[] }[];
  system: { area: string; data: string; retention: string }[];
  recipients: { name: string; detail: string }[];
  retentionRules: number;
}

/**
 * What personal data this workspace holds, where, for how long, and who receives it.
 * A starting point for the operator's record of processing activities (GDPR Art. 30).
 */
export async function dataMap(): Promise<DataMapDto> {
  const c = await effectiveCompliance();
  const records = [];
  for (const entity of CUSTOMIZABLE_ENTITIES) {
    const defs = await getDefinitions(entity);
    const rows = Number(
      ((await db(ENTITY_TABLE[entity]).whereNull('deleted_at').count({ n: '*' }).first()) as { n: number }).n,
    );
    records.push({
      entity,
      rows,
      coreFields: CORE_PERSONAL[entity],
      customFields: defs.map((d) => ({ key: d.key, label: d.label, sensitivity: d.sensitivity })),
    });
  }
  const days = (n: number) => (n ? `${n} days` : 'Kept until deleted');
  const h = c.housekeeping;
  const system = [
    {
      area: 'Staff accounts',
      data: 'Name, email, sign-in times, 2FA secret (encrypted)',
      retention: 'Until the account is erased',
    },
    { area: 'Sessions', data: 'IP address, browser', retention: days(h.sessionsDays) },
    {
      area: 'Audit log',
      data: 'Who changed what, IP address, browser',
      retention: days(c.auditRetentionDays),
    },
    {
      area: 'Access log',
      data: 'Who viewed or exported what, IP address',
      retention: c.accessLogging ? days(c.auditRetentionDays) : 'Off',
    },
    {
      area: 'Consent records',
      data: 'Decision, wording, time, IP address',
      retention: 'With the person’s record',
    },
    {
      area: 'Privacy requests',
      data: 'Requester name and email, notes',
      retention: 'Kept as proof of handling',
    },
    {
      area: 'Webhook deliveries',
      data: c.webhookMinimal ? 'Record ids only' : 'Record snapshots',
      retention: days(h.webhookDeliveriesDays),
    },
    {
      area: 'Notifications',
      data: 'Titles may include names',
      retention: `${days(h.notificationsDays)} after reading`,
    },
    { area: 'Background jobs', data: 'Event payloads', retention: days(h.jobsDays) },
    {
      area: 'Uploaded files',
      data: c.encryptUploads ? 'Encrypted at rest' : 'Stored as uploaded',
      retention: `With their record; ${days(h.deletedFilesDays)} after deletion`,
    },
  ];
  const hooks = await db('webhooks').where({ active: true }).select('name', 'url');
  const recipients = [
    { name: 'Email delivery (SMTP)', detail: env.SMTP_HOST },
    ...hooks.map((w) => ({ name: `Webhook: ${w.name as string}`, detail: hostOf(w.url as string) })),
  ];
  const mailboxes = Number(
    ((await db('mail_accounts').where({ active: true }).count({ n: '*' }).first()) as { n: number }).n,
  );
  if (mailboxes)
    recipients.push({ name: 'Connected mailboxes', detail: `${mailboxes} staff mailbox(es) via IMAP/SMTP` });
  return {
    profile: c.profile,
    records,
    modules: (await privacyHandlers(db)).map((p) => ({ key: p.key, tables: p.tables })),
    system,
    recipients,
    retentionRules: c.retentionRules.length,
  };
}

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
