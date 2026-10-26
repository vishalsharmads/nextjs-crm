import type { PrivacyHandler } from '@app/api/module-api';

/** Assets assigned to the person: the assignment is business data; deleting the contact unlinks it. */
export const assetsPrivacy: PrivacyHandler = {
  key: 'assets',
  tables: ['m_assets_assets', 'm_assets_events'],
  async export(subject, conn) {
    if (subject.entity !== 'contact') return {};
    const assets = await conn('m_assets_assets')
      .where({ contact_id: subject.id })
      .select('uuid', 'name', 'tag', 'notes');
    const events = await conn('m_assets_events')
      .where({ contact_id: subject.id })
      .orderBy('id')
      .select('kind', 'note', 'created_at');
    return { assets, events };
  },
  async erase(subject, trx) {
    if (subject.entity !== 'contact') return {};
    const events = await trx('m_assets_events').where({ contact_id: subject.id }).update({ note: null });
    return { cleared: { events } };
  },
};
