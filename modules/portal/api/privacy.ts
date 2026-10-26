import type { PrivacyHandler } from '@app/api/module-api';

/** Portal sign-in data belongs to the person: it always goes. */
export const portalPrivacy: PrivacyHandler = {
  key: 'portal',
  tables: ['m_portal_accounts', 'm_portal_sessions', 'm_portal_tokens'],
  viewPermission: 'portal.accounts.manage',
  async export(subject, conn) {
    if (subject.entity !== 'contact') return {};
    const accounts = await conn('m_portal_accounts')
      .where({ contact_id: subject.id })
      .select('id', 'email', 'last_login_at', 'created_at');
    const ids = accounts.map((a) => a.id as number);
    const sessions = ids.length
      ? await conn('m_portal_sessions').whereIn('account_id', ids).select('ip', 'user_agent', 'created_at')
      : [];
    return { accounts: accounts.map(({ id: _id, ...a }) => a), sessions };
  },
  async erase(subject, trx) {
    if (subject.entity !== 'contact') return {};
    const ids = (await trx('m_portal_accounts').where({ contact_id: subject.id }).pluck('id')) as number[];
    if (!ids.length) return {};
    await trx('m_portal_sessions').whereIn('account_id', ids).delete();
    await trx('m_portal_tokens').whereIn('account_id', ids).delete();
    return { cleared: { accounts: await trx('m_portal_accounts').whereIn('id', ids).delete() } };
  },
};
