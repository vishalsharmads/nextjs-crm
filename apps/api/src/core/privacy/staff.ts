import type { RequestContext } from '../../http/context';
import { db } from '../../db/knex';
import { conflict, notFound } from '../../lib/errors';
import { audit } from '../audit/audit.service';
import { daysOf, resealDays } from '../audit/integrity';

/**
 * Erase a former staff member's personal data. The row stays (anonymized and soft-deleted) so
 * audit entries keep pointing at the same actor id; their sign-in data and mailboxes go.
 */
export async function anonymizeUser(ctx: RequestContext, uuid: string) {
  const u = await db('users').where({ uuid }).first();
  if (!u || u.email.endsWith('@invalid')) throw notFound('User');
  if (u.status !== 'disabled') throw conflict('Disable the account before erasing it');
  await db.transaction(async (trx) => {
    await trx('users')
      .where({ id: u.id })
      .update({
        email: `removed-${u.uuid as string}@invalid`,
        first_name: 'Former',
        last_name: 'user',
        password_hash: null,
        avatar_file_uuid: null,
        locale: null,
        timezone: null,
        totp_enabled: false,
        totp_secret_enc: null,
        totp_last_step: null,
        preferences: null,
        deleted_at: u.deleted_at ?? new Date(),
      });
    await trx('sessions').where({ user_id: u.id }).delete();
    await trx('auth_tokens').where({ user_id: u.id }).delete();
    await trx('user_recovery_codes').where({ user_id: u.id }).delete();
    await trx('mail_accounts').where({ user_id: u.id }).delete();
    await trx('notifications').where({ user_id: u.id }).delete();
    await trx('api_keys')
      .where({ created_by: u.id })
      .whereNull('revoked_at')
      .update({ revoked_at: new Date() });
    // Entries about the account (for example its creation) hold the email. Entries the person made
    // keep their actor id and IP: they remain evidence of who did what.
    const days = await daysOf(trx, 'audit', { entity: 'user', entity_id: u.id });
    await trx.raw('SET @audit_redaction = 1');
    try {
      await trx('audit_logs')
        .where({ entity: 'user', entity_id: u.id })
        .update({ diff: JSON.stringify({ redacted: true }), ip: null, user_agent: null });
    } finally {
      await trx.raw('SET @audit_redaction = 0');
    }
    await resealDays(trx, 'audit', days);
    await audit(trx, ctx, { action: 'user.anonymized', entity: 'user', entityId: u.id, entityUuid: u.uuid });
  });
}
