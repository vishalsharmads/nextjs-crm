import type { PrivacyHandler } from '@app/api/module-api';

export const checkinsPrivacy: PrivacyHandler = {
  key: 'coworking-checkins',
  tables: ['m_coworking_checkins_visits'],
  async export(subject, conn) {
    if (subject.entity !== 'contact') return {};
    const visits = await conn('m_coworking_checkins_visits')
      .where({ contact_id: subject.id })
      .orWhere({ host_contact_id: subject.id })
      .orderBy('checked_in_at')
      .select(
        'visitor_name',
        'visitor_company',
        'visitor_email',
        'purpose',
        'checked_in_at',
        'checked_out_at',
      );
    return { visits };
  },
  async erase(subject, trx, mode) {
    if (subject.entity !== 'contact') return {};
    const own = trx('m_coworking_checkins_visits').where({ contact_id: subject.id });
    const visits =
      mode === 'delete'
        ? await own.delete()
        : await own.update({ visitor_name: null, visitor_company: null, visitor_email: null, purpose: null });
    await trx('m_coworking_checkins_visits')
      .where({ host_contact_id: subject.id })
      .update({ host_contact_id: null });
    return { cleared: { visits } };
  },
};
