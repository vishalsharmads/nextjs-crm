import { z } from 'zod';
import { defineRoutes } from '../../http/routes';
import type { AuthUser } from '../../http/context';
import { db } from '../../db/knex';
import { AppError, notFound } from '../../lib/errors';
import { randomToken, sha256 } from '../../lib/crypto';
import { newUuid } from '../../lib/ids';
import { audit } from '../audit/audit.service';
import { loadAccess } from '../rbac/access';
import { assertCanAssignRoles } from '../rbac/grants';
import { effectiveCompliance } from '../settings/settings.service';
import type { ComplianceSettings } from '@app/shared';

const KEY_PREFIX = 'sk_';

/**
 * Authenticate `Authorization: Bearer sk_…`. The key acts as a service identity with
 * its role's permissions and scopes (never more than the role), attributed to its creator.
 */
export async function authenticateApiKey(
  token: string,
  compliance: Pick<ComplianceSettings, 'apiKeyMaxDays'>,
): Promise<AuthUser | null> {
  if (!token.startsWith(KEY_PREFIX)) return null;
  // The compliance profile caps key age, including keys created before it was turned on.
  const minCreated =
    compliance.apiKeyMaxDays > 0 ? new Date(Date.now() - compliance.apiKeyMaxDays * 86_400_000) : new Date(0);
  const row = await db('api_keys as k')
    .join('roles as r', 'r.id', 'k.role_id')
    .join('users as u', 'u.id', 'k.created_by')
    .where('k.key_hash', sha256(token))
    .whereNull('k.revoked_at')
    .where((w) => w.whereNull('k.expires_at').orWhere('k.expires_at', '>', new Date()))
    .where('k.created_at', '>', minCreated)
    .where('u.status', 'active')
    .first(
      'k.id',
      'k.role_id',
      'r.key as role_key',
      'u.id as user_id',
      'u.uuid',
      'u.email',
      'u.first_name',
      'u.last_name',
    );
  if (!row) return null;
  // Access comes from the key's role only, not from the creator's other roles.
  const perms = await db('role_permissions').where({ role_id: row.role_id }).pluck('pattern');
  const scopeRows = await db('role_scopes').where({ role_id: row.role_id });
  const base = await loadAccess(row.user_id);
  const scopes = { ...base.scopes };
  for (const k of Object.keys(scopes)) {
    const s = scopeRows.find((r) => r.resource === k || r.resource === '*');
    scopes[k] = (s?.scope as (typeof scopes)[string]) ?? 'own';
  }
  void db('api_keys')
    .where({ id: row.id })
    .update({ last_used_at: new Date() })
    .catch(() => undefined);
  return {
    id: row.user_id,
    uuid: row.uuid,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    roleKeys: [row.role_key],
    isAdmin: (perms as string[]).includes('*'),
    permissions: perms as string[],
    scopes,
    sessionId: null,
    apiKeyId: row.id,
  };
}

const dto = (k: Record<string, unknown>) => ({
  uuid: k.uuid,
  name: k.name,
  prefix: k.prefix,
  role: { key: k.role_key, name: k.role_name },
  lastUsedAt: k.last_used_at ? new Date(k.last_used_at as string).toISOString() : null,
  expiresAt: k.expires_at ? new Date(k.expires_at as string).toISOString() : null,
  revokedAt: k.revoked_at ? new Date(k.revoked_at as string).toISOString() : null,
  createdAt: new Date(k.created_at as string).toISOString(),
});

export const apiKeysRoutes = defineRoutes('/api-keys', ['api-keys'])
  .add({
    method: 'get',
    path: '/',
    permission: 'core.api_keys.manage',
    handler: async () => ({
      data: (
        await db('api_keys as k')
          .join('roles as r', 'r.id', 'k.role_id')
          .orderBy('k.id', 'desc')
          .select('k.*', 'r.key as role_key', 'r.name as role_name')
      ).map(dto),
    }),
  })
  .add({
    method: 'post',
    path: '/',
    permission: 'core.api_keys.manage',
    body: z.object({
      name: z.string().trim().min(1).max(100),
      roleKey: z.string().max(64),
      expiresAt: z.iso.datetime({ offset: true }).nullish(),
    }),
    status: 201,
    summary: 'Create a key. The secret is returned once and never stored in plain text.',
    handler: async ({ ctx, user, body }) => {
      if (user.apiKeyId) throw new AppError('FORBIDDEN', 'API keys cannot create API keys');
      const role = await db('roles').where({ key: body.roleKey }).first();
      if (!role)
        throw new AppError('VALIDATION_FAILED', 'Unknown role', [
          { path: 'roleKey', message: 'Unknown role' },
        ]);
      await assertCanAssignRoles(user, [role.id]);
      const { apiKeyMaxDays } = await effectiveCompliance();
      if (
        apiKeyMaxDays > 0 &&
        (!body.expiresAt || new Date(body.expiresAt).getTime() > Date.now() + apiKeyMaxDays * 86_400_000)
      )
        throw new AppError('VALIDATION_FAILED', `Choose an expiry date within ${apiKeyMaxDays} days`, [
          {
            path: 'expiresAt',
            message: `The compliance profile requires keys to expire within ${apiKeyMaxDays} days`,
          },
        ]);
      const secret = `${KEY_PREFIX}${randomToken(32)}`;
      const uuid = newUuid();
      await db.transaction(async (trx) => {
        const [id] = await trx('api_keys').insert({
          uuid,
          name: body.name,
          prefix: secret.slice(0, 11),
          key_hash: sha256(secret),
          role_id: role.id,
          created_by: user.id,
          expires_at: body.expiresAt ? new Date(body.expiresAt) : null,
        });
        await audit(trx, ctx, {
          action: 'api_key.created',
          entity: 'api_key',
          entityId: id,
          entityUuid: uuid,
          diff: { name: body.name, role: body.roleKey },
        });
      });
      const row = await db('api_keys as k')
        .join('roles as r', 'r.id', 'k.role_id')
        .where('k.uuid', uuid)
        .first('k.*', 'r.key as role_key', 'r.name as role_name');
      return { ...dto(row), secret };
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/revoke',
    permission: 'core.api_keys.manage',
    params: z.object({ uuid: z.uuid() }),
    handler: async ({ ctx, params }) => {
      const n = await db('api_keys')
        .where({ uuid: params.uuid })
        .whereNull('revoked_at')
        .update({ revoked_at: new Date() });
      if (!n) throw notFound('API key');
      await audit(db, ctx, { action: 'api_key.revoked', entity: 'api_key', entityUuid: params.uuid });
    },
  });
