import { logger } from '../../lib/logger';
import { z } from 'zod';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  mfaVerifySchema,
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
    body: mfaVerifySchema,
    handler: async ({ req, res, body }) => {
      await auth.verifyMfa(req, res, body);
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
      await auth
        .forgotPassword(ctx, body.email)
        .catch((err: unknown) =>
          logger.warn({ err, requestId: ctx.requestId }, 'Password reset email failed'),
        );
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
  notifications: z.object({ email: z.boolean().optional(), taskDigest: z.boolean().optional() }).optional(),
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
    recoveryCodesLeft: u.totp_enabled ? await auth.unusedRecoveryCodeCount(userId) : 0,
    roles: roles.map((r) => ({ key: r.key, name: r.name })),
    toursSeen: prefsOf(u.preferences).toursSeen ?? [],
    notifications: {
      email: prefsOf(u.preferences).emailNotifications !== false,
      taskDigest: prefsOf(u.preferences).taskDigest === true,
    },
  };
}

const prefsOf = (v: unknown) =>
  ((typeof v === 'string' ? JSON.parse(v) : v) ?? {}) as { toursSeen?: string[] } & Record<string, unknown>;

export const meRoutes = defineRoutes('/me', ['me'])
  .add({ method: 'get', path: '/', permission: 'authenticated', handler: ({ user }) => getMe(user.id) })
  .add({
    method: 'patch',
    path: '/',
    permission: 'authenticated',
    body: profileSchema,
    handler: async ({ ctx, user, body }) => {
      await db.transaction(async (trx) => {
        let preferences: string | undefined;
        if (body.notifications) {
          const row = await trx('users').where({ id: user.id }).forUpdate().first('preferences');
          const prefs = prefsOf(row?.preferences);
          const n = body.notifications;
          preferences = JSON.stringify({
            ...prefs,
            ...(n.email !== undefined ? { emailNotifications: n.email } : {}),
            ...(n.taskDigest !== undefined ? { taskDigest: n.taskDigest } : {}),
          });
        }
        await trx('users')
          .where({ id: user.id })
          .update({
            ...(preferences !== undefined ? { preferences } : {}),
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
    path: '/tours/:tour/seen',
    permission: 'authenticated',
    params: z.object({ tour: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/) }),
    summary: 'Remember that this person finished or dismissed a guided tour',
    handler: async ({ ctx, user, params }) => {
      await db.transaction(async (trx) => {
        const row = await trx('users').where({ id: user.id }).forUpdate().first('preferences');
        const prefs = prefsOf(row?.preferences);
        const seen = new Set(prefs.toursSeen ?? []);
        seen.add(params.tour);
        await trx('users')
          .where({ id: user.id })
          .update({ preferences: JSON.stringify({ ...prefs, toursSeen: [...seen].slice(-100) }) });
        await audit(trx, ctx, {
          action: 'user.tour_seen',
          entity: 'user',
          entityId: user.id,
          diff: { tour: params.tour },
        });
      });
    },
  })
  .add({
    method: 'post',
    path: '/activity',
    permission: 'authenticated',
    summary: 'Heartbeat after user input; the x-idle-ms header moves the idle clock forward',
    // authenticate() already recorded the reported input.
    handler: () => undefined,
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
    path: '/2fa/recovery-codes',
    permission: 'authenticated',
    before: [authLimiter],
    summary: 'Replace your 2FA recovery codes (shown once)',
    body: z.object({ password: z.string().min(1).max(256) }),
    handler: ({ ctx, user, body }) => auth.regenerateRecoveryCodes(ctx, user.id, body.password),
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
