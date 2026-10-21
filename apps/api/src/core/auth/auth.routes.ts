import { z } from 'zod';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  resetPasswordSchema,
  totpCodeSchema,
  type MeDto,
  type SessionDto,
} from '@app/shared';
import { defineRoutes } from '../../http/routes';
import { authLimiter } from '../../middleware/rate-limit';
import { issueCsrfToken } from '../../middleware/csrf';
import { db } from '../../db/knex';
import { notFound } from '../../lib/errors';
import { audit } from '../audit/audit.service';
import * as auth from './auth.service';
import { revokeFamily } from './tokens';

export const authRoutes = defineRoutes('/auth', ['auth'])
  .add({
    method: 'get',
    path: '/csrf',
    permission: 'public',
    summary: 'Issue a CSRF token (also set as a cookie)',
    handler: ({ res }) => ({ token: issueCsrfToken(res) }),
  })
  .add({
    method: 'post',
    path: '/login',
    permission: 'public',
    before: [authLimiter],
    body: loginSchema,
    handler: ({ req, res, body }) => auth.login(req, res, body.email, body.password),
  })
  .add({
    method: 'post',
    path: '/2fa/verify',
    permission: 'public',
    before: [authLimiter],
    body: totpCodeSchema,
    handler: async ({ req, res, body }) => {
      await auth.verifyMfa(req, res, body.code);
      return { ok: true };
    },
  })
  .add({
    method: 'post',
    path: '/refresh',
    permission: 'public',
    before: [authLimiter],
    handler: async ({ req, res }) => {
      await auth.refresh(req, res);
      return { ok: true };
    },
  })
  .add({
    method: 'post',
    path: '/logout',
    permission: 'public',
    handler: ({ req, res }) => auth.logout(req, res),
  })
  .add({
    method: 'post',
    path: '/password/forgot',
    permission: 'public',
    before: [authLimiter],
    body: forgotPasswordSchema,
    // Always 204 so the response does not reveal whether the email exists.
    handler: async ({ ctx, body }) => {
      await auth.forgotPassword(ctx, body.email).catch(() => undefined);
    },
  })
  .add({
    method: 'post',
    path: '/password/reset',
    permission: 'public',
    before: [authLimiter],
    body: resetPasswordSchema,
    handler: ({ ctx, body }) => auth.resetPassword(ctx, body.token, body.password),
  })
  .add({
    method: 'post',
    path: '/invite/accept',
    permission: 'public',
    before: [authLimiter],
    body: resetPasswordSchema,
    handler: ({ ctx, body }) => auth.acceptInvite(ctx, body.token, body.password),
  });

const profileSchema = z.object({
  firstName: z.string().trim().max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
  locale: z.string().max(10).nullable().optional(),
  timezone: z.string().max(64).nullable().optional(),
});

export async function getMe(userId: number): Promise<MeDto> {
  const u = await db('users').where({ id: userId }).first();
  const roles = await db('user_roles as ur')
    .join('roles as r', 'r.id', 'ur.role_id')
    .where('ur.user_id', userId)
    .select('r.key', 'r.name');
  return {
    uuid: u.uuid,
    email: u.email,
    firstName: u.first_name,
    lastName: u.last_name,
    locale: u.locale,
    timezone: u.timezone,
    totpEnabled: !!u.totp_enabled,
    roles: roles.map((r) => ({ key: r.key, name: r.name })),
  };
}

export const meRoutes = defineRoutes('/me', ['me'])
  .add({ method: 'get', path: '/', permission: 'authenticated', handler: ({ user }) => getMe(user.id) })
  .add({
    method: 'patch',
    path: '/',
    permission: 'authenticated',
    body: profileSchema,
    handler: async ({ ctx, user, body }) => {
      await db.transaction(async (trx) => {
        await trx('users')
          .where({ id: user.id })
          .update({
            ...(body.firstName !== undefined ? { first_name: body.firstName } : {}),
            ...(body.lastName !== undefined ? { last_name: body.lastName } : {}),
            ...(body.locale !== undefined ? { locale: body.locale } : {}),
            ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
          });
        await audit(trx, ctx, {
          action: 'user.profile_updated',
          entity: 'user',
          entityId: user.id,
          entityUuid: user.uuid,
          diff: body,
        });
      });
      return getMe(user.id);
    },
  })
  .add({
    method: 'post',
    path: '/password',
    permission: 'authenticated',
    before: [authLimiter],
    body: changePasswordSchema,
    handler: ({ ctx, user, body }) =>
      auth.changePassword(ctx, user.id, body.currentPassword, body.newPassword),
  })
  .add({
    method: 'post',
    path: '/2fa/setup',
    permission: 'authenticated',
    before: [authLimiter],
    handler: ({ ctx, user }) => auth.setupTotp(ctx, user.id, user.email),
  })
  .add({
    method: 'post',
    path: '/2fa/enable',
    permission: 'authenticated',
    before: [authLimiter],
    body: totpCodeSchema,
    handler: ({ ctx, user, body }) => auth.enableTotp(ctx, user.id, body.code),
  })
  .add({
    method: 'post',
    path: '/2fa/disable',
    permission: 'authenticated',
    before: [authLimiter],
    body: z.object({ password: z.string().min(1).max(256) }),
    handler: ({ ctx, user, body }) => auth.disableTotp(ctx, user.id, body.password),
  })
  .add({
    method: 'get',
    path: '/sessions',
    permission: 'authenticated',
    handler: async ({ user }): Promise<SessionDto[]> => {
      const current = user.sessionId
        ? ((await db('sessions').where({ id: user.sessionId }).first('family_id'))?.family_id as
            string | undefined)
        : undefined;
      const rows = await db('sessions')
        .where({ user_id: user.id })
        .whereNull('revoked_at')
        .where('expires_at', '>', new Date())
        .orderBy('last_used_at', 'desc');
      return rows.map((s) => ({
        uuid: s.uuid,
        userAgent: s.user_agent,
        ip: s.ip,
        createdAt: new Date(s.created_at).toISOString(),
        lastUsedAt: new Date(s.last_used_at).toISOString(),
        current: s.family_id === current,
      }));
    },
  })
  .add({
    method: 'delete',
    path: '/sessions/:uuid',
    permission: 'authenticated',
    params: z.object({ uuid: z.uuid() }),
    handler: async ({ ctx, user, params }) => {
      const s = await db('sessions').where({ uuid: params.uuid, user_id: user.id }).first('family_id');
      if (!s) throw notFound('Session');
      await db.transaction(async (trx) => {
        await revokeFamily(s.family_id, trx);
        await audit(trx, ctx, { action: 'auth.session_revoked', entity: 'user', entityId: user.id });
      });
    },
  });
