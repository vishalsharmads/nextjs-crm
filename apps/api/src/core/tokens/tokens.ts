import { z } from 'zod';
import {
  PAT_PREFIX,
  mfaRequiredFor,
  personalTokenInputSchema,
  type ComplianceSettings,
  type PersonalTokenDto,
} from '@app/shared';
import { defineRoutes } from '../../http/routes';
import type { AuthUser } from '../../http/context';
import { db } from '../../db/knex';
import { AppError, notFound } from '../../lib/errors';
import { randomToken, sha256 } from '../../lib/crypto';
import { newUuid } from '../../lib/ids';
import { audit } from '../audit/audit.service';
import { loadAccess } from '../rbac/access';
import { effectiveCompliance, effectiveSecurity } from '../settings/settings.service';
import { iso } from '../records/hydrate';

/** Paths a personal access token may call. Everything else ignores the token. */
export const TOKEN_PATHS = ['/api/v1/mcp'];

/**
 * Authenticate `Authorization: Bearer pat_…`. The token acts as its user, with the user's current
 * roles, scopes and field visibility; a read-only token keeps only `.view` permissions.
 */
export async function authenticatePersonalToken(
  token: string,
  compliance: Pick<ComplianceSettings, 'apiKeyMaxDays'>,
): Promise<AuthUser | null> {
  if (!token.startsWith(PAT_PREFIX)) return null;
  const minCreated =
    compliance.apiKeyMaxDays > 0 ? new Date(Date.now() - compliance.apiKeyMaxDays * 86_400_000) : new Date(0);
  const row = await db('personal_access_tokens as t')
    .join('users as u', 'u.id', 't.user_id')
    .where('t.token_hash', sha256(token))
    .whereNull('t.revoked_at')
    .where('t.expires_at', '>', new Date())
    .where('t.created_at', '>', minCreated)
    .whereNull('u.deleted_at')
    .where('u.status', 'active')
    .first(
      't.id',
      't.read_only',
      'u.id as user_id',
      'u.uuid',
      'u.email',
      'u.first_name',
      'u.last_name',
      'u.totp_enabled',
    );
  if (!row) return null;
  const access = await loadAccess(row.user_id as number);
  // Someone who must enrol in two-factor authentication cannot work around it with a token.
  if (!row.totp_enabled && mfaRequiredFor(access, await effectiveSecurity(), await effectiveCompliance()))
    return null;
  void db('personal_access_tokens')
    .where({ id: row.id })
    .update({ last_used_at: new Date() })
    .catch(() => undefined);
  return {
    id: row.user_id,
    uuid: row.uuid,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    ...access,
    sessionId: null,
    tokenId: row.id,
    readOnly: !!row.read_only,
  };
}

const dto = (r: Record<string, unknown>): PersonalTokenDto => ({
  uuid: r.uuid as string,
  name: r.name as string,
  prefix: r.prefix as string,
  access: r.read_only ? 'read' : 'full',
  lastUsedAt: iso(r.last_used_at),
  expiresAt: iso(r.expires_at)!,
  revokedAt: iso(r.revoked_at),
  createdAt: iso(r.created_at)!,
});

/** Profile → Access tokens. Only a signed-in person (not a token or key) manages their own tokens. */
export const tokensRoutes = defineRoutes('/me/tokens', ['tokens'])
  .add({
    method: 'get',
    path: '/',
    permission: 'authenticated',
    handler: async ({ user }) => ({
      data: (await db('personal_access_tokens').where({ user_id: user.id }).orderBy('id', 'desc')).map(dto),
    }),
  })
  .add({
    method: 'post',
    path: '/',
    permission: 'authenticated',
    body: personalTokenInputSchema,
    status: 201,
    summary: 'Create a token. The secret is returned once and never stored in plain text.',
    handler: async ({ ctx, user, body }) => {
      if (!user.sessionId) throw new AppError('FORBIDDEN', 'Sign in to create access tokens');
      const { apiKeyMaxDays } = await effectiveCompliance();
      if (apiKeyMaxDays > 0 && body.expiresInDays > apiKeyMaxDays)
        throw new AppError('VALIDATION_FAILED', `Choose an expiry within ${apiKeyMaxDays} days`, [
          { path: 'expiresInDays', message: `Tokens must expire within ${apiKeyMaxDays} days` },
        ]);
      const secret = `${PAT_PREFIX}${randomToken(32)}`;
      const uuid = newUuid();
      await db.transaction(async (trx) => {
        const [id] = await trx('personal_access_tokens').insert({
          uuid,
          user_id: user.id,
          name: body.name,
          prefix: secret.slice(0, 12),
          token_hash: sha256(secret),
          read_only: body.access === 'read',
          expires_at: new Date(Date.now() + body.expiresInDays * 86_400_000),
        });
        await audit(trx, ctx, {
          action: 'token.created',
          entity: 'personal_access_token',
          entityId: id,
          entityUuid: uuid,
          diff: { name: body.name, access: body.access, expiresInDays: body.expiresInDays },
        });
      });
      return { ...dto(await db('personal_access_tokens').where({ uuid }).first()), secret };
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/revoke',
    permission: 'authenticated',
    params: z.object({ uuid: z.uuid() }),
    handler: async ({ ctx, user, params }) => {
      const n = await db('personal_access_tokens')
        .where({ uuid: params.uuid, user_id: user.id })
        .whereNull('revoked_at')
        .update({ revoked_at: new Date() });
      if (!n) throw notFound('Token');
      await audit(db, ctx, {
        action: 'token.revoked',
        entity: 'personal_access_token',
        entityUuid: params.uuid,
      });
    },
  });
