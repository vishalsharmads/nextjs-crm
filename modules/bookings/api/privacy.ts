import type { PrivacyHandler } from '@app/api/module-api';

export const bookingsPrivacy: PrivacyHandler = {
  key: 'bookings',
  tables: ['m_bookings_bookings'],
  async export(subject, conn) {
    if (subject.entity !== 'contact') return {};
    const bookings = await conn('m_bookings_bookings')
      .where({ contact_id: subject.id })
      .orderBy('starts_at')
      .select('uuid', 'title', 'starts_at', 'ends_at', 'status', 'attendees', 'notes', 'cancel_reason');
    return { bookings };
  },
  async erase(subject, trx, mode) {
    if (subject.entity !== 'contact') return {};
    const q = trx('m_bookings_bookings').where({ contact_id: subject.id });
    const n = mode === 'delete' ? await q.delete() : await q.update({ notes: null, cancel_reason: null });
    return { cleared: { bookings: n } };
  },
};
