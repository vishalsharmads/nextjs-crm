import type { Request, Response } from 'express';
import { hash, verify } from '@node-rs/argon2';
import { passwordPolicySchema } from '@app/shared';
import { env } from '../../config/env';
import { db } from '../../db/knex';
import { AppError } from '../../lib/errors';
import { decrypt, encrypt, sha256 } from '../../lib/crypto';
import { generateTotpSecret, matchTotpStep, otpauthUrl } from '../../lib/totp';
import { loadAccess } from '../rbac/access';
import type { RequestContext } from '../../http/context';
import { audit } from '../audit/audit.service';
import { getBranding, getGroup } from '../settings/settings.service';
import { sendTemplatedEmail } from '../mail/templates';
import {
  MFA_COOKIE,
  REFRESH_COOKIE,
  clearAuthCookies,
  consumeOneTimeToken,
  createOneTimeToken,
  burnUserTokens,
  revokeFamily,
  setMfaCookie,
  startSession,
} from './tokens';

// Verified against when the email is unknown, so response time does not reveal which accounts exist.
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hash('placeholder-password-for-timing'));

export const hashPassword = (password: string) => hash(password);

export async function validatePassword(password: string) {
  const policy = await getGroup('security');
  const result = passwordPolicySchema(policy).safeParse(password);
  if (!result.success) {
    throw new AppError(
      'VALIDATION_FAILED',
      result.error.issues[0]?.message ?? 'Password does not meet the policy',
      result.error.issues.map((i) => ({ path: 'password', message: i.message })),
    );
  }
}

const invalidCredentials = () => new AppError('UNAUTHENTICATED', 'Email or password is incorrect');

export async function login(req: Request, res: Response, email: string, password: string) {
  const security = await getGroup('security');
  const user = await db('users').where({ email }).whereNull('deleted_at').first();
  if (!user || !user.password_hash) {
    await verify(await getDummyHash(), password).catch(() => false);
    throw invalidCredentials();
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    throw new AppError('ACCOUNT_LOCKED', 'Too many failed attempts. Try again later or reset your password.');
  }
  const ok = await verify(user.password_hash, password).catch(() => false);
  if (!ok) {
    const failed = (user.failed_login_count as number) + 1;
    const lock = failed >= security.lockoutMaxAttempts;
    await db('users')
      .where({ id: user.id })
      .update({
        failed_login_count: lock ? 0 : failed,
        locked_until: lock ? new Date(Date.now() + security.lockoutMinutes * 60_000) : user.locked_until,
      });
    await audit(db, req.ctx, {
      action: lock ? 'auth.locked' : 'auth.login_failed',
      entity: 'user',
      entityId: user.id,
      entityUuid: user.uuid,
    });
    throw lock
      ? new AppError('ACCOUNT_LOCKED', 'Too many failed attempts. Try again later or reset your password.')
      : invalidCredentials();
  }
  if (user.status !== 'active') {
    throw new AppError('FORBIDDEN', 'This account is disabled. Ask an admin to re-enable it.');
  }
  await db('users').where({ id: user.id }).update({ failed_login_count: 0, locked_until: null });

  if (user.totp_enabled) {
    const token = await createOneTimeToken(db, user.id, 'mfa', 5);
    setMfaCookie(res, token);
    return { mfaRequired: true as const };
  }
  await completeLogin(req, res, user);
  return { mfaRequired: false as const };
}

async function completeLogin(req: Request, res: Response, user: { id: number; uuid: string }) {
  await db.transaction(async (trx) => {
    await startSession(trx, res, req, user);
    await trx('users').where({ id: user.id }).update({ last_login_at: new Date() });
    await audit(trx, req.ctx, {
      action: 'auth.login',
      entity: 'user',
      entityId: user.id,
      entityUuid: user.uuid,
    });
  });
}

export async function verifyMfa(req: Request, res: Response, code: string) {
  const token = req.cookies?.[MFA_COOKIE] as string | undefined;
  if (!token) throw new AppError('UNAUTHENTICATED', 'Sign in again to continue');
  const hash = sha256(token);
  const row = await db('auth_tokens')
    .where({ token_hash: hash, purpose: 'mfa' })
    .whereNull('used_at')
    .where('expires_at', '>', new Date())
    .first();
  if (!row) throw new AppError('UNAUTHENTICATED', 'Sign in again to continue');
  const user = await db('users').where({ id: row.user_id, status: 'active' }).whereNull('deleted_at').first();
  if (!user || (user.locked_until && new Date(user.locked_until) > new Date())) {
    throw new AppError('UNAUTHENTICATED', 'Sign in again to continue');
  }
  const step = user.totp_secret_enc ? matchTotpStep(decrypt(user.totp_secret_enc), code) : null;
  // A step that was already used cannot be replayed.
  if (step === null || (user.totp_last_step !== null && step <= Number(user.totp_last_step))) {
    const security = await getGroup('security');
    await db.transaction(async (trx) => {
      await trx('auth_tokens').where({ id: row.id }).increment('attempts', 1);
      // Five wrong codes burn this sign-in attempt; failures also count toward account lockout.
      if (row.attempts + 1 >= 5)
        await trx('auth_tokens').where({ id: row.id }).update({ used_at: new Date() });
      const failed = (user.failed_login_count as number) + 1;
      const lock = failed >= security.lockoutMaxAttempts;
      await trx('users')
        .where({ id: user.id })
        .update({
          failed_login_count: lock ? 0 : failed,
          locked_until: lock ? new Date(Date.now() + security.lockoutMinutes * 60_000) : user.locked_until,
        });
      await audit(trx, req.ctx, { action: 'auth.mfa_failed', entity: 'user', entityId: user.id });
    });
    throw new AppError('MFA_INVALID', 'That code is not valid. Check your authenticator app and try again.');
  }
  const userId = await consumeOneTimeToken(db, token, 'mfa');
  if (userId !== user.id) throw new AppError('UNAUTHENTICATED', 'Sign in again to continue');
  await db('users').where({ id: user.id }).update({ totp_last_step: step, failed_login_count: 0 });
  await completeLogin(req, res, user);
}

export async function refresh(req: Request, res: Response) {
  const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (!token) throw new AppError('UNAUTHENTICATED', 'Sign in to continue');
  const session = await db('sessions')
    .where({ refresh_hash: sha256(token) })
    .first();
  if (!session) {
    clearAuthCookies(res);
    throw new AppError('UNAUTHENTICATED', 'Sign in to continue');
  }
  if (session.revoked_at) {
    // A rotated token was replayed: assume theft and end the whole family.
    await revokeFamily(session.family_id);
    await audit(db, req.ctx, { action: 'auth.refresh_reuse', entity: 'user', entityId: session.user_id });
    clearAuthCookies(res);
    throw new AppError('UNAUTHENTICATED', 'Sign in to continue');
  }
  const { sessionIdleDays } = await getGroup('security');
  // Each refresh rotates the session row, so its creation time is the last activity.
  const idle = Date.now() - new Date(session.created_at).getTime() > sessionIdleDays * 86_400_000;
  if (new Date(session.expires_at) < new Date() || idle) {
    await revokeFamily(session.family_id);
    clearAuthCookies(res);
    throw new AppError('UNAUTHENTICATED', 'Your session expired. Sign in again.');
  }
  const user = await db('users')
    .where({ id: session.user_id, status: 'active' })
    .whereNull('deleted_at')
    .first('id', 'uuid');
  if (!user) {
    clearAuthCookies(res);
    throw new AppError('UNAUTHENTICATED', 'Sign in to continue');
  }
  await db.transaction(async (trx) => {
    await trx('sessions')
      .where({ id: session.id })
      .update({ revoked_at: new Date(), last_used_at: new Date() });
    await startSession(trx, res, req, user, session.family_id);
  });
}

export async function logout(req: Request, res: Response) {
  const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (token) {
    const session = await db('sessions')
      .where({ refresh_hash: sha256(token) })
      .first('family_id');
    if (session) await revokeFamily(session.family_id);
  } else if (req.ctx.user?.sessionId) {
    const session = await db('sessions').where({ id: req.ctx.user.sessionId }).first('family_id');
    if (session) await revokeFamily(session.family_id);
  }
  if (req.ctx.user)
    await audit(db, req.ctx, { action: 'auth.logout', entity: 'user', entityId: req.ctx.user.id });
  clearAuthCookies(res);
}

export async function forgotPassword(ctx: RequestContext, email: string) {
  const user = await db('users').where({ email, status: 'active' }).whereNull('deleted_at').first();
  if (!user) return;
  const token = await createOneTimeToken(db, user.id, 'reset', 60);
  await audit(db, ctx, {
    action: 'auth.reset_requested',
    entity: 'user',
    entityId: user.id,
    entityUuid: user.uuid,
  });
  await sendTemplatedEmail('auth.password_reset', user.email, {
    user: { firstName: user.first_name || user.email },
    link: `${env.APP_URL}/reset-password?token=${encodeURIComponent(token)}`,
  });
}

async function setPasswordWithToken(
  ctx: RequestContext,
  token: string,
  password: string,
  purpose: 'reset' | 'invite',
) {
  await validatePassword(password);
  const passwordHash = await hashPassword(password);
  await db.transaction(async (trx) => {
    const userId = await consumeOneTimeToken(trx, token, purpose);
    if (!userId)
      throw new AppError(
        'VALIDATION_FAILED',
        'This link has expired or was already used. Ask for a new one.',
      );
    await trx('users')
      .where({ id: userId })
      .update({
        password_hash: passwordHash,
        password_changed_at: new Date(),
        failed_login_count: 0,
        locked_until: null,
        ...(purpose === 'invite' ? { status: 'active' } : {}),
      });
    await trx('sessions')
      .where({ user_id: userId })
      .whereNull('revoked_at')
      .update({ revoked_at: new Date() });
    await audit(trx, ctx, {
      action: purpose === 'invite' ? 'auth.invite_accepted' : 'auth.password_reset',
      entity: 'user',
      entityId: userId,
    });
  });
}

export const resetPassword = (ctx: RequestContext, token: string, password: string) =>
  setPasswordWithToken(ctx, token, password, 'reset');
export const acceptInvite = (ctx: RequestContext, token: string, password: string) =>
  setPasswordWithToken(ctx, token, password, 'invite');

export async function changePassword(ctx: RequestContext, userId: number, current: string, next: string) {
  const user = await db('users').where({ id: userId }).first();
  if (!user?.password_hash || !(await verify(user.password_hash, current).catch(() => false))) {
    throw new AppError('VALIDATION_FAILED', 'Current password is incorrect', [
      { path: 'currentPassword', message: 'Current password is incorrect' },
    ]);
  }
  await validatePassword(next);
  await db.transaction(async (trx) => {
    await trx('users')
      .where({ id: userId })
      .update({ password_hash: await hashPassword(next), password_changed_at: new Date() });
    await burnUserTokens(trx, userId);
    // Keep the current session, end all others.
    const currentFamily = ctx.user?.sessionId
      ? ((await trx('sessions').where({ id: ctx.user.sessionId }).first('family_id'))?.family_id as
          string | undefined)
      : undefined;
    const q = trx('sessions').where({ user_id: userId }).whereNull('revoked_at');
    if (currentFamily) q.whereNot({ family_id: currentFamily });
    await q.update({ revoked_at: new Date() });
    await audit(trx, ctx, { action: 'auth.password_changed', entity: 'user', entityId: userId });
  });
}

export async function setupTotp(ctx: RequestContext, userId: number, email: string) {
  const security = await getGroup('security');
  if (!security.totpAllowed)
    throw new AppError('FORBIDDEN', 'Two-factor authentication is turned off for this workspace');
  const secret = generateTotpSecret();
  await db.transaction(async (trx) => {
    const n = await trx('users')
      .where({ id: userId, totp_enabled: false })
      .update({ totp_secret_enc: encrypt(secret), totp_last_step: null });
    if (!n) throw new AppError('CONFLICT', 'Two-factor authentication is already on');
    await audit(trx, ctx, { action: 'auth.mfa_setup_started', entity: 'user', entityId: userId });
  });
  const branding = await getBranding();
  return { secret, otpauthUrl: otpauthUrl(secret, email, branding.appName) };
}

export async function enableTotp(ctx: RequestContext, userId: number, code: string) {
  const user = await db('users').where({ id: userId }).first();
  if (!user?.totp_secret_enc) throw new AppError('VALIDATION_FAILED', 'Start two-factor setup first');
  const step = matchTotpStep(decrypt(user.totp_secret_enc), code);
  if (step === null) throw new AppError('MFA_INVALID', 'That code is not valid');
  await db.transaction(async (trx) => {
    await trx('users').where({ id: userId }).update({ totp_enabled: true, totp_last_step: step });
    await audit(trx, ctx, { action: 'auth.mfa_enabled', entity: 'user', entityId: userId });
  });
}

export async function disableTotp(ctx: RequestContext, userId: number, password: string) {
  const user = await db('users').where({ id: userId }).first();
  if (!user?.password_hash || !(await verify(user.password_hash, password).catch(() => false))) {
    throw new AppError('VALIDATION_FAILED', 'Password is incorrect', [
      { path: 'password', message: 'Password is incorrect' },
    ]);
  }
  const security = await getGroup('security');
  const access = await loadAccess(userId);
  if (security.totpRequiredForAdmins && access.isAdmin) {
    throw new AppError('FORBIDDEN', 'Two-factor authentication is required for admins in this workspace');
  }
  await db.transaction(async (trx) => {
    await trx('users')
      .where({ id: userId })
      .update({ totp_enabled: false, totp_secret_enc: null, totp_last_step: null });
    await audit(trx, ctx, { action: 'auth.mfa_disabled', entity: 'user', entityId: userId });
  });
}
