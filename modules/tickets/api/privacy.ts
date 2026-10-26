import type { PrivacyHandler } from '@app/api/module-api';

export const ticketsPrivacy: PrivacyHandler = {
  key: 'tickets',
  tables: ['m_tickets_tickets', 'm_tickets_comments'],
  async export(subject, conn) {
    if (subject.entity !== 'contact') return {};
    const tickets = await conn('m_tickets_tickets')
      .where({ contact_id: subject.id })
      .orderBy('id')
      .select('id', 'subject', 'description', 'status', 'created_at');
    const comments = await conn('m_tickets_comments')
      .where({ author_contact_id: subject.id })
      .orderBy('id')
      .select('ticket_id', 'body', 'created_at');
    return { tickets, comments };
  },
  async erase(subject, trx, mode) {
    if (subject.entity !== 'contact') return {};
    const ids = (await trx('m_tickets_tickets').where({ contact_id: subject.id }).pluck('id')) as number[];
    if (mode === 'delete') {
      const comments = ids.length ? await trx('m_tickets_comments').whereIn('ticket_id', ids).delete() : 0;
      const own = await trx('m_tickets_comments').where({ author_contact_id: subject.id }).delete();
      const tickets = ids.length ? await trx('m_tickets_tickets').whereIn('id', ids).delete() : 0;
      return { cleared: { tickets, comments: comments + own } };
    }
    // Keep the tickets for support reporting, without what the person wrote.
    const tickets = ids.length
      ? await trx('m_tickets_tickets').whereIn('id', ids).update({ description: null })
      : 0;
    const comments = await trx('m_tickets_comments')
      .where({ author_contact_id: subject.id })
      .update({ body: '' });
    return { cleared: { tickets, comments } };
  },
};
