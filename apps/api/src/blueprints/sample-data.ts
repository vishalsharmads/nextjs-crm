import type { Knex } from 'knex';
import type { Blueprint } from '@app/blueprints';
import { normalizePhone } from '@app/shared';
import { newUuid } from '../lib/ids';

const str = (v: unknown) => (typeof v === 'string' ? v : null);

/** Insert demo records from a blueprint's `sample_data`. Only runs on the first apply. */
export async function seedSampleData(knex: Knex, bp: Blueprint): Promise<number> {
  const data = bp.sample_data;
  if (!data) return 0;
  return knex.transaction(async (trx) => {
    const admin = await trx('user_roles as ur')
      .join('roles as r', 'r.id', 'ur.role_id')
      .where('r.key', 'admin')
      .first('ur.user_id');
    const ownerId = (admin?.user_id as number | undefined) ?? null;
    const general = (await trx('settings').where({ key: 'general' }).first())?.value as
      { currency?: string } | undefined;
    const currency = general?.currency ?? 'USD';
    const refs = { org: new Map<string, number>(), contact: new Map<string, number>() };
    let n = 0;

    for (const o of data.organizations) {
      const website = str(o.website);
      const [id] = await trx('organizations').insert({
        uuid: newUuid(),
        name: str(o.name) ?? 'Organization',
        website,
        domain: website ? new URL(website).hostname.replace(/^www\./, '') : null,
        industry: str(o.industry),
        owner_id: ownerId,
        created_by: ownerId,
        custom: JSON.stringify(o.custom ?? {}),
      });
      if (str(o.ref)) refs.org.set(str(o.ref)!, id!);
      n++;
    }

    for (const c of data.contacts) {
      const phone = str(c.phone);
      const [id] = await trx('contacts').insert({
        uuid: newUuid(),
        first_name: str(c.first_name) ?? '',
        last_name: str(c.last_name) ?? '',
        email: str(c.email),
        phone,
        phone_e164: phone ? normalizePhone(phone) : null,
        lifecycle_status: str(c.lifecycle_status),
        source: str(c.source),
        owner_id: ownerId,
        created_by: ownerId,
        custom: JSON.stringify(c.custom ?? {}),
      });
      if (str(c.ref)) refs.contact.set(str(c.ref)!, id!);
      const orgId = str(c.organization) ? refs.org.get(str(c.organization)!) : undefined;
      if (orgId)
        await trx('contact_organization').insert({
          uuid: newUuid(),
          contact_id: id,
          organization_id: orgId,
          is_primary: true,
        });
      n++;
    }

    const pipeline = await trx('pipelines').where({ entity: 'deal', is_default: true }).first();
    if (pipeline) {
      const stages = await trx('pipeline_stages').where({ pipeline_id: pipeline.id }).orderBy('sort_order');
      for (const [i, d] of data.deals.entries()) {
        const stage = stages.find((s) => s.key === d.stage) ?? stages[0];
        if (!stage) continue;
        const status = stage.is_won ? 'won' : stage.is_lost ? 'lost' : 'open';
        await trx('deals').insert({
          uuid: newUuid(),
          title: str(d.title) ?? 'Deal',
          contact_id: str(d.contact) ? (refs.contact.get(str(d.contact)!) ?? null) : null,
          organization_id: str(d.organization) ? (refs.org.get(str(d.organization)!) ?? null) : null,
          pipeline_id: pipeline.id,
          stage_id: stage.id,
          value: typeof d.value === 'number' ? d.value : 0,
          currency,
          status,
          won_at: status === 'won' ? new Date() : null,
          owner_id: ownerId,
          created_by: ownerId,
          position: (i + 1) * 1000,
          custom: JSON.stringify(d.custom ?? {}),
        });
        n++;
      }
    }
    return n;
  });
}
